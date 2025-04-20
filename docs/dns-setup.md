# DNS Setup: eng.todie.io → GitHub Pages

## Current State

- Domain: `todie.io`
- Registrar/DNS: Namecheap
- Target: GitHub Pages (`eng.todie.io` → static mirror of Ghost blog)

## Step 1: Add CNAME at Namecheap (minimum viable)

If staying on Namecheap DNS for now, add this record in the Namecheap Advanced DNS panel:

| Type  | Host  | Value                     | TTL       |
|-------|-------|---------------------------|-----------|
| CNAME | eng   | todie.github.io.          | Automatic |

After adding, GitHub will auto-provision a Let's Encrypt TLS certificate (takes ~15 min). Then enable HTTPS enforcement:

```bash
# After DNS propagates and cert is issued:
curl -X PUT https://api.github.com/repos/todie/ghost-blog/pages \
  -H "Authorization: token <PAT>" \
  -H "Accept: application/vnd.github+json" \
  -d '{"https_enforced":true}'
```

Verify: `dig eng.todie.io CNAME` should return `todie.github.io.`

## Step 2: Migrate DNS to Cloudflare

### Why Cloudflare

- Free plan covers everything needed (DNS, CDN, DDoS, analytics)
- Faster propagation than most registrar DNS
- API-driven — every record scriptable via `wrangler` or REST
- Page Rules, WAF, and caching for future services on todie.io
- GitHub Pages + Cloudflare = free CDN in front of free hosting

### Migration Steps

1. **Create Cloudflare account** at https://dash.cloudflare.com

2. **Add site**: Enter `todie.io`, select the **Free** plan

3. **Cloudflare scans existing records**: It will import everything currently on Namecheap. Review the import — make sure all existing A, AAAA, MX, TXT, CNAME records are present.

4. **Add the blog CNAME** (if not auto-imported):

   | Type  | Name  | Content              | Proxy | TTL  |
   |-------|-------|----------------------|-------|------|
   | CNAME | eng   | todie.github.io      | DNS only (gray cloud) | Auto |

   **Important**: Use "DNS only" (gray cloud), not "Proxied" (orange cloud). GitHub Pages needs to see the real CNAME to provision the TLS cert. Once the cert is active, you can optionally switch to Proxied for Cloudflare CDN caching.

5. **Get Cloudflare nameservers**: Cloudflare assigns two nameservers (e.g., `ada.ns.cloudflare.com`, `bob.ns.cloudflare.com`).

6. **Update nameservers at Namecheap**:
   - Log into Namecheap → Domain List → `todie.io` → Nameservers
   - Change from "Namecheap BasicDNS" to "Custom DNS"
   - Enter the two Cloudflare nameservers
   - Save

7. **Wait for propagation**: Usually 1-24 hours. Cloudflare will email you when active.

8. **Verify**:
   ```bash
   dig eng.todie.io CNAME +short
   # Expected: todie.github.io.

   dig todie.io NS +short
   # Expected: ada.ns.cloudflare.com. / bob.ns.cloudflare.com.

   curl -sI https://eng.todie.io | head -5
   # Expected: HTTP/2 200, server: GitHub.com
   ```

### Post-Migration Cloudflare Settings

- **SSL/TLS**: Set to "Full (strict)" — both Cloudflare↔GitHub and client↔Cloudflare use TLS
- **Always Use HTTPS**: Enable (Settings → Edge Certificates)
- **HSTS**: Enable with `max-age=31536000; includeSubDomains`
- **Caching**: If you switch `eng` to Proxied (orange cloud), Cloudflare caches static assets automatically. GitHub Pages already has good cache headers, so this is optional but reduces latency.

## Step 3: Verify GitHub Pages Domain

GitHub may require domain verification for custom domains on org/user accounts:

1. Go to https://github.com/settings/pages (or org settings)
2. Add `todie.io` as a verified domain
3. Add the TXT record Cloudflare/Namecheap as instructed
4. Once verified, GitHub prevents other repos from claiming subdomains of `todie.io`

## DNS Records Reference

Final state after migration (all in Cloudflare):

| Type  | Name       | Content              | Proxy      | Notes                    |
|-------|------------|----------------------|------------|--------------------------|
| CNAME | eng        | todie.github.io      | DNS only*  | Ghost blog static mirror |
| TXT   | _github-pages-challenge-todie | (value from GitHub) | N/A | Domain verification |
| ...   | (existing) | (existing)           | (existing) | Preserve all other records |

*Switch to Proxied after TLS cert is confirmed active.
