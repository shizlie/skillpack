# CI Release Workflow

Automated release pipeline for `.mcpb` bundle artifacts via GitHub Actions.

---

## How it works

Trigger: push a version tag (`v*`). The workflow:

1. Injects the stable signing keypair from GitHub Secrets
2. Runs `bun test:unit` (gate — no release on test failure)
3. Runs `bun run bundle:laws-consultant` to produce the `.mcpb`, release folder, and tarball
4. Extracts the changelog entry for the version from `CHANGELOG.md`
5. Creates a GitHub Release with the tarball and `.sha256` sidecar as assets

Receivers download from the release page and verify with the pinned public key fingerprint.

---

## One-time setup: secrets

Two secrets are required. Both must come from the **same keypair** — the public key fingerprint is what receivers pin out-of-band. Rotating either key means receivers must re-pin.

### Step 1: Generate a stable keypair (once)

```bash
cd /tmp
node -e "
const crypto = require('node:crypto');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
require('node:fs').writeFileSync('release-private.pem', privateKey, { mode: 0o600 });
require('node:fs').writeFileSync('release-public.pem', publicKey);
console.log('done');
"
```

Or use the repo's own crypto package after `bun install`:

```bash
node -e "
import('../packages/crypto/src/index.js').then(({ generateEd25519KeyPair }) => {
  const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
  require('node:fs').writeFileSync('/tmp/release-private.pem', privateKeyPem, { mode: 0o600 });
  require('node:fs').writeFileSync('/tmp/release-public.pem', publicKeyPem);
  console.log('done');
});
"
```

### Step 2: Add to GitHub Secrets

Navigate to:

```
https://github.com/<org>/skillpack/settings/secrets/actions
```

The page has two sections: **Repository secrets** and **Environment secrets**.

Use **Repository secrets** — click the **"New repository secret"** button in that section. It does NOT ask for an environment. If you see an environment dropdown, you clicked the wrong button (Environment secrets section).

Add two secrets:

| Secret name | Value |
|---|---|
| `LAWS_CONSULTANT_PRIVATE_KEY` | Full contents of `release-private.pem` including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines |
| `LAWS_CONSULTANT_PUBLIC_KEY` | Full contents of `release-public.pem` including the `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----` lines |

Delete the local key files after adding them:

```bash
rm /tmp/release-private.pem /tmp/release-public.pem
```

### Step 3: Record the public key fingerprint

Send this fingerprint to receivers out-of-band (email, signed release notes, portal):

```bash
shasum -a 256 /tmp/release-public.pem | awk '{print $1}'
# or after adding secrets, download the public key from any release asset
```

Receivers use it:

```bash
EXPECTED_PUBKEY_SHA256="<fingerprint>" ./runtime/receiver-verify-install.sh
```

---

## Triggering a release

```bash
# Bump VERSION file and CHANGELOG.md first, then:
git tag v$(cat VERSION)
git push origin v$(cat VERSION)
```

The workflow runs automatically. Watch progress at:

```
https://github.com/<org>/skillpack/actions
```

Release assets appear at:

```
https://github.com/<org>/skillpack/releases/tag/v<version>
```

---

## Key rotation

Key rotation means receivers must obtain a new fingerprint. Plan for it:

1. Generate a new keypair (Step 1 above)
2. Update both GitHub Secrets
3. Notify existing receivers that the public key fingerprint has changed
4. Ship a new release — the new public key will be embedded in that release's tarball

Do **not** rotate keys mid-release. All assets in a given release must be signed with the same private key that matches the `.public.pem` included in the tarball.

---

## Local vs CI keypair

The bundle script uses `verticals/laws-consultant/distribution/keys/dev-private.pem` for local builds. The CI workflow injects secrets to that same path before running the script. This means:

- Local dev builds use an auto-generated dev key (fine for testing)
- CI/release builds use the stable production key from secrets

Do **not** commit the local dev private key. It is gitignored via `*.pem` exclusion. The public key distributed in release tarballs comes from whichever key was active at build time — local dev builds should not be sent to receivers.
