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

Run this on your local machine, at the project root. It writes two `.pem` files to `/tmp`:

```bash
node -e "
import('./packages/crypto/src/index.js').then(({ generateEd25519KeyPair }) => {
  const { privateKeyPem, publicKeyPem } = generateEd25519KeyPair();
  require('node:fs').writeFileSync('/tmp/release-private.pem', privateKeyPem, { mode: 0o600 });
  require('node:fs').writeFileSync('/tmp/release-public.pem', publicKeyPem);
  console.log('done');
});
"
```

Check they were created:

```bash
cat /tmp/release-private.pem   # starts with -----BEGIN PRIVATE KEY-----
cat /tmp/release-public.pem    # starts with -----BEGIN PUBLIC KEY-----
```

---

### Step 2 (OPTIONAL): Record the public key fingerprint

**Most projects can skip this step entirely.** Skip to Step 3 if your receivers download from GitHub Releases over HTTPS and that level of trust is enough for them.

Read this section only if you need to understand it, or if you sell into regulated environments (hospitals, defense, finance) where customers require defense against download-channel attacks.

#### What problem this solves

Imagine the normal release flow:

1. CI signs a bundle with your private key
2. CI puts THREE things into the release tarball: the `.mcpb` bundle, the `.public.pem` (the public key that matches your private key), and a signature file
3. Receiver downloads tarball from GitHub Releases
4. Receiver extracts it, runs the verify script
5. Verify script reads the `.public.pem` from inside the tarball, checks the signature on the `.mcpb` matches that key
6. Pass = receiver installs the bundle

This is fine **if the tarball the receiver downloaded is actually yours**. GitHub Releases over HTTPS is usually trustworthy enough.

#### The attack this defends against

Now imagine an attacker who can intercept the receiver's download. Examples:

- A corporate proxy that does TLS interception (very common in regulated networks)
- A compromised mirror or CDN
- A malicious admin inside the receiver's company who substitutes the file before the receiver runs it
- DNS hijacking redirecting `github.com` to a fake server

The attacker can generate THEIR OWN Ed25519 keypair (anyone can — it takes one second). Then they:

1. Build a malicious `.mcpb` (with a backdoor, a wrong skill, whatever)
2. Sign it with THEIR private key
3. Put the malicious `.mcpb` + THEIR public key + a fresh signature into a fake tarball
4. Hand the fake tarball to the receiver

Now the receiver runs the verify script. The script reads the public key from the (fake) tarball, checks the signature on the (fake) bundle, and **passes**. Because everything inside the tarball is internally consistent — the attacker's signature matches the attacker's key.

The receiver has no way to know the public key in the tarball is not yours.

This is why "verify the signature using the key inside the tarball" is not enough on its own. The verify script can only confirm the tarball is internally consistent. It cannot confirm the tarball came from you.

#### How the fingerprint fixes this

A fingerprint is just a SHA-256 hash of your public key. It is a 64-character hex string. It does not change unless you rotate your keypair. It is not secret.

The fix:

1. You publish your fingerprint somewhere the attacker cannot easily forge: your company website (HTTPS), a signed PGP-signed email, a customer portal behind login, the back of a printed contract, whatever
2. Receiver writes the fingerprint down once, when they first onboard
3. When verifying any future release, receiver passes the fingerprint:

    ```bash
    EXPECTED_PUBKEY_SHA256="<your-fingerprint>" ./runtime/receiver-verify-install.sh
    ```

4. The verify script now does an extra check: hash the public key from the tarball, compare to the fingerprint. If they don't match, abort.

The attacker cannot forge this. The attacker would need to substitute the public key inside the tarball with YOUR real public key. But then their signature (made with their private key) would no longer match. They are stuck.

#### Generate the fingerprint

Do this **before** you delete the local key files in Step 3, while `/tmp/release-public.pem` still exists:

```bash
shasum -a 256 /tmp/release-public.pem | awk '{print $1}'
```

Output looks like:

```
3a7f8c9d4b2e1f6a5d8c7b9a3e2f1d4c8b7a6e5f4d3c2b1a9e8f7d6c5b4a3e2f
```

Save that string. Send it to receivers through whatever trusted channel you use (email signature, customer portal, contract, signed release notes).

#### Decision tree: do I need this?

| Situation                                                             | Need fingerprint? |
| --------------------------------------------------------------------- | ----------------- |
| Hobby project, OSS users download from GitHub                         | No                |
| Internal company tool, employees install on dev machines              | No                |
| Selling to small businesses, no security review required              | No                |
| Selling to a hospital, law firm, bank, or defense contractor          | **Yes**           |
| Customer asked you "how do we know your release is not tampered with" | **Yes**           |
| Air-gapped install with sneakernet transfer through unknown hands     | **Yes**           |

If you are unsure, skip this step. You can always start distributing the fingerprint later — your existing public key does not change, so the fingerprint stays valid.

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

#### Lost the public key? Need the fingerprint later?

Don't worry. The public key is recoverable from any release. **You do NOT need to ship a new release.**

Two ways to get it back:

**Option A: Download from any release asset (easiest)**

Every release publishes the public key as a standalone file:

```bash
gh release download v0.2.0.0 --pattern '*.public.pem' --repo shizlie/skillpack -O /tmp/release-public.pem
shasum -a 256 /tmp/release-public.pem | awk '{print $1}'
```

Or via browser: go to the release page, download the `.public.pem` asset, hash it locally.

**Option B: Extract from the bundle tarball**

```bash
gh release download v0.2.0.0 --pattern '*-bundle.tar.gz' --repo shizlie/skillpack -O /tmp/bundle.tar.gz
tar -xzf /tmp/bundle.tar.gz -C /tmp
shasum -a 256 /tmp/laws-consultant-*/laws-consultant-*.public.pem | awk '{print $1}'
```

The private key is also still safe in GitHub Secrets. You cannot view its value through the GitHub UI (write-only), but the workflow can still use it. You only need the local copy if you want to do off-CI signing.

---

## Triggering a release

```bash
# Bump VERSION file and CHANGELOG.md first, then:
git tag v$(cat VERSION)
git push origin v$(cat VERSION)
# Incase you need to delete a bad tag and retry:
git tag -d v0.2.0.0
git push --delete origin v0.2.0.0
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

## Two different keypairs: dev (local) vs production (CI)

There are TWO keypairs in this project. They live in the same file path but mean different things. This is the most confusing part of the setup. Read carefully.

### The file path

The bundle script always reads from one location:

```
verticals/laws-consultant/distribution/keys/dev-private.pem
verticals/laws-consultant/distribution/keys/dev-public.pem
```

What is actually IN that file depends on where the build runs.

### Scenario A: You run `bun run bundle:laws-consultant` on your laptop

The bundle script looks for those `.pem` files. If they don't exist, it generates a fresh **throwaway dev keypair** and writes it there. This dev keypair is unique to your laptop.

- Use case: testing the bundle pipeline, debugging, writing receiver runbooks
- The resulting `.mcpb` is signed with your laptop's dev key
- **Never give this `.mcpb` to a real receiver.** Their fingerprint check (if they do one) will fail, and even if they skip the check, every laptop produces a different key — there is no stable identity behind it
- The dev keypair is gitignored via the `*.pem` rule — it never gets committed

### Scenario B: CI runs the build on a tag push

The CI workflow writes your **production keypair** (from GitHub Secrets) into the same `.pem` file paths BEFORE running the bundle script. The script then signs with your real production key.

- Use case: every official release receivers will install
- The resulting `.mcpb` is signed with the stable production key
- The matching `.public.pem` is published as a release asset and embedded in the tarball
- Receivers can verify the signature, and (if they do strict pinning) check the fingerprint matches what you told them out-of-band

### Why use the same file path for both?

So the bundle script does not need to know whether it's running on your laptop or in CI. Both paths produce a valid signed bundle. The difference is **which key got written there first**.

### Rules

- **Do not commit any `.pem` file.** They are gitignored. This includes both dev and production keys.
- **Do not ship a laptop-built `.mcpb` to a real receiver.** Always release through CI so the production key signs it.
- **The production private key only exists in GitHub Secrets.** Once you set it up (per Step 3 above), you should not have a local copy.
- If you need to test the production key locally (rare, e.g. debugging a CI release issue), you can manually paste the secret into the local `.pem` files — but delete them after.
