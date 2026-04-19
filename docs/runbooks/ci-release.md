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

### Why this is needed

Every `.mcpb` bundle is signed with an Ed25519 private key. Receivers verify the signature using the matching public key. To make this work in CI:

- You generate a keypair once and store it in GitHub Secrets
- Every CI release uses that same stable private key to sign the bundle
- The matching public key is included in every release tarball so receivers can verify
- Receivers who want strict security obtain the public key fingerprint from you out-of-band (not from the tarball), so an attacker who tampers with the tarball cannot also swap out the key

**Both keys must come from the same keypair.** The private key signs bundles; the public key verifies them. They are mathematically linked — mismatched keys will cause verification to fail for every receiver.

---

### Step 1: Generate a stable keypair (once)

Run this on your local machine. It writes two `.pem` files to `/tmp`:

```bash
node -e "
const crypto = require('node:crypto');
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
require('node:fs').writeFileSync('/tmp/release-private.pem', privateKey, { mode: 0o600 });
require('node:fs').writeFileSync('/tmp/release-public.pem', publicKey);
console.log('Keys written to /tmp/release-private.pem and /tmp/release-public.pem');
"
```

Check they were created:

```bash
cat /tmp/release-private.pem   # starts with -----BEGIN PRIVATE KEY-----
cat /tmp/release-public.pem    # starts with -----BEGIN PUBLIC KEY-----
```

---

### Step 2: Record the public key fingerprint (before deleting the files)

This fingerprint is what you send to receivers so they can do strict key pinning. Do this **now**, while the files are still on disk:

```bash
shasum -a 256 /tmp/release-public.pem | awk '{print $1}'
```

Save that output (a 64-character hex string). Send it to receivers via email, a signed release note, or your customer portal — not inside the tarball. This is what makes key pinning meaningful: the fingerprint comes from a trusted channel, not from the bundle being verified.

Receivers use it like this:

```bash
EXPECTED_PUBKEY_SHA256="<your-fingerprint>" ./runtime/receiver-verify-install.sh
```

---

### Step 3: Add the keys to GitHub Secrets

Navigate to:

```
https://github.com/shizlie/skillpack/settings/secrets/actions
```

The page has two sections: **Repository secrets** and **Environment secrets**.

Use **Repository secrets** — click **"New repository secret"** in that section. If you see a dropdown asking for an environment, you clicked the wrong section.

Add two secrets one at a time:

**Secret 1:**
- Name: `LAWS_CONSULTANT_PRIVATE_KEY`
- Value: paste the entire contents of `/tmp/release-private.pem`, including the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines

**Secret 2:**
- Name: `LAWS_CONSULTANT_PUBLIC_KEY`
- Value: paste the entire contents of `/tmp/release-public.pem`, including the `-----BEGIN PUBLIC KEY-----` and `-----END PUBLIC KEY-----` lines

After both secrets are saved, delete the local files:

```bash
rm /tmp/release-private.pem /tmp/release-public.pem
```

The keys now live only in GitHub Secrets. The CI workflow injects them at build time — they are never written to the repo or exposed in logs.

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
