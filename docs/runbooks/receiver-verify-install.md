# Receiver Runbook

Goal: install `laws-consultant` on a receiver machine, verify integrity and authenticity, enable the wiki MCP server, and confirm Claude Code picks up the skill.

---

## Step 0: Rebuild (scripts changed this session)

```bash
bun run bundle:laws-consultant
```

Outputs:

```
dist/skills/laws-consultant-0.1.0.0.mcpb
dist/skills/laws-consultant-0.1.0.0/          (release folder)
dist/skills/laws-consultant-0.1.0.0-bundle.tar.gz
dist/skills/laws-consultant-0.1.0.0-bundle.tar.gz.sha256
```

The `.sha256` sidecar lets receivers verify tarball integrity before extracting.

---

## Step 1: Local receiver simulation (5 min, same machine)

```bash
# Simulate transfer to a scratch dir
mkdir -p /tmp/receiver-test
cp dist/skills/laws-consultant-0.1.0.0-bundle.tar.gz /tmp/receiver-test/

# Receiver side
cd /tmp/receiver-test
tar -xzf laws-consultant-0.1.0.0-bundle.tar.gz
cd laws-consultant-0.1.0.0

# Run the one-command flow
./runtime/receiver-verify-install.sh
```

Expected output:

```
[1/4] checksum verification
laws-consultant-0.1.0.0.mcpb: OK
laws-consultant-0.1.0.0.public.pem: OK
runtime/server.mjs: OK

  WARNING: key pinning skipped...   ← expected without pinning

[3/4] bundle signature and manifest verification
{"ok":true,"bundle":"...","verifiedFiles":2,"bundleId":"laws-consultant","version":"0.1.0.0"}
[4/4] install guide layer and stage sealed bundle
installed skill:      ~/.claude/skills/laws-consultant
staged sealed bundle: ~/.skillpack/bundles/laws-consultant/laws-consultant-0.1.0.0.mcpb
staged MCP server:    ~/.skillpack/bundles/laws-consultant/server.mjs

To enable the wiki knowledge base, add to ~/.claude.json (or project .mcp.json):
  "mcpServers": {
    "laws-consultant-wiki": {
      "command": "node",
      "args": ["/Users/you/.skillpack/bundles/laws-consultant/server.mjs",
               "/Users/you/.skillpack/bundles/laws-consultant/laws-consultant-0.1.0.0.mcpb"]
    }
  }
```

Verify installs landed:

```bash
ls ~/.claude/skills/laws-consultant/     # SKILL.md
ls ~/.skillpack/bundles/laws-consultant/ # .mcpb + .pem + server.mjs
```

---

## Step 2: With key pinning (intended prod flow)

Get the public key fingerprint out-of-band from the vendor (email, portal, signed release notes):

```bash
# Vendor runs this, sends the SHA256 to receiver
shasum -a 256 dist/skills/laws-consultant-0.1.0.0/laws-consultant-0.1.0.0.public.pem | awk '{print $1}'
```

Receiver uses it:

```bash
cd /tmp/receiver-test/laws-consultant-0.1.0.0
EXPECTED_PUBKEY_SHA256="<sha-from-vendor>" ./runtime/receiver-verify-install.sh
```

No WARNING. `[2/4]` now prints `public key fingerprint verification` and passes.

Without key pinning the trust root is the tarball itself — an attacker who replaces bundle + public key + SHA256SUMS in the same tarball passes all checks. Key pinning breaks this.

---

## Step 3: Docker fresh machine (full confidence, ~10 min)

```dockerfile
# /tmp/test-receiver.Dockerfile
FROM node:18-slim
RUN apt-get update && apt-get install -y rsync unzip && rm -rf /var/lib/apt/lists/*
COPY laws-consultant-0.1.0.0-bundle.tar.gz /tmp/
RUN tar -xzf /tmp/laws-consultant-0.1.0.0-bundle.tar.gz -C /tmp
WORKDIR /tmp/laws-consultant-0.1.0.0
RUN ./runtime/receiver-verify-install.sh
RUN ls ~/.claude/skills/laws-consultant/SKILL.md && echo "SKILL INSTALLED OK"
RUN ls ~/.skillpack/bundles/laws-consultant/laws-consultant-0.1.0.0.mcpb && echo "BUNDLE STAGED OK"
```

```bash
cp dist/skills/laws-consultant-0.1.0.0-bundle.tar.gz /tmp/
docker build -f /tmp/test-receiver.Dockerfile /tmp/ --no-cache
```

Proves it works on a clean Node 18 image with no pre-installed tools beyond `rsync` + `unzip`.

To test Node version guard (should fail):

```dockerfile
FROM node:14-slim   # too old
```

Expected: receiver preflight fails early with `Node.js >= 15 required. Found: v14.x.x`.

---

## Step 4: Tamper / negative tests

```bash
cd /tmp/receiver-test
tar -xzf laws-consultant-0.1.0.0-bundle.tar.gz
cd laws-consultant-0.1.0.0

# Test 1: Tampered bundle content → checksum fails
echo "evil" >> laws-consultant-0.1.0.0.mcpb
./runtime/receiver-verify-install.sh
# Expected: "laws-consultant-0.1.0.0.mcpb: FAILED"

# Test 2: Wrong public key → signature fails
# Swap in a foreign public key, recompute SHA256SUMS to pass step 1
shasum -a 256 laws-consultant-0.1.0.0.mcpb laws-consultant-0.1.0.0.public.pem > SHA256SUMS
./runtime/receiver-verify-install.sh
# Expected: "manifest_signature_invalid"

# Test 3: Missing SHA256SUMS
rm SHA256SUMS
./runtime/receiver-verify-install.sh
# Expected: "missing SHA256SUMS" exit 1

# Test 4: Key pinning mismatch
EXPECTED_PUBKEY_SHA256="deadbeef000000000000000000000000000000000000000000000000000000" \
  ./runtime/receiver-verify-install.sh
# Expected: "public key fingerprint mismatch"

# Test 5: Tampered manifest inside .mcpb → signature fails
# (SHA256SUMS recomputed to pass step 1, but manifest.sha256 inside bundle is stale)
BUNDLE_ABS="$(pwd)/laws-consultant-0.1.0.0.mcpb"
WORK=$(mktemp -d)
unzip -q "$BUNDLE_ABS" -d "$WORK"
echo '{"bundleId":"evil"}' > "$WORK/manifest.json"
(cd "$WORK" && zip -qr "$BUNDLE_ABS" .)
BUNDLE_SHA=$(shasum -a 256 laws-consultant-0.1.0.0.mcpb | awk '{print $1}')
PEM_SHA=$(shasum -a 256 laws-consultant-0.1.0.0.public.pem | awk '{print $1}')
printf "%s  %s\n%s  %s\n" "$BUNDLE_SHA" laws-consultant-0.1.0.0.mcpb \
  "$PEM_SHA" laws-consultant-0.1.0.0.public.pem > SHA256SUMS
rm -rf "$WORK"
./runtime/receiver-verify-install.sh
# Expected: exit non-0, "manifest_sha_mismatch" or "manifest_signature_invalid"
```

Or just run the automated suite:

```bash
bun run test:receiver-e2e
```

---

## Step 5: Enable the wiki MCP server

The receiver script prints the exact config block at the end of step [4/4]. **Copy that output verbatim** into `~/.claude.json` (global) or `<project>/.mcp.json` (project-scoped).

> **Warning: do not retype or use `~` shorthand.** Claude Code spawns `node` directly without a shell — `~` is never expanded. The server silently fails to start. Always use the absolute paths printed by the receiver script.

Example of what the receiver script prints (paths will match your actual install):

```
To enable the wiki knowledge base, add to ~/.claude.json (or project .mcp.json):
  "mcpServers": {
    "laws-consultant-wiki": {
      "command": "node",
      "args": ["/Users/you/.skillpack/bundles/laws-consultant/server.mjs",
               "/Users/you/.skillpack/bundles/laws-consultant/laws-consultant-0.1.0.0.mcpb"]
    }
  }
```

If you need to write the config manually, get the correct absolute path with:

```bash
echo "$HOME/.skillpack/bundles/laws-consultant"
```

Then use that value (no `~`) in the `args` array.

What the server does on startup:

1. Extracts `.mcpb` to a `chmod 700` temp dir
2. Verifies bundle integrity and authenticity (`manifest.sha256`, `signature.bin`, and manifest file hashes)
3. Reads `license.json` → verifies the Ed25519 lease token against the vendor public key
4. Extracts `knowledge/wiki.tar.gz` to a second `chmod 700` temp dir
5. Starts a JSON-RPC 2.0 MCP server on stdio
6. Verifies the lease again on every `tools/call` (catches mid-session expiry)
7. Appends an HMAC-chained meter event to `~/.skillpack/bundles/laws-consultant/meter.jsonl` per call
8. Persists meter chain state to `~/.skillpack/bundles/laws-consultant/meter-state.json` so sequence/hash continuity survives restarts
9. Cleans up both temp dirs on exit

Server startup message (goes to stderr, not visible in Claude Code):

```
[skillpack] laws-consultant wiki MCP server ready (lease mode: active)
```

If lease is in grace period:

```
[WARNING] lease is in grace period — renew soon to avoid service interruption
```

If lease is expired past grace:

```
[ERROR] lease verification failed: runtime_lease_expired_past_grace
```

Process exits non-0. Claude Code will show the MCP server as unavailable.

MCP tools available after install:

| Tool | Description |
|------|-------------|
| `wiki_search` | Full-text search across all wiki pages, returns ranked results with snippets |
| `wiki_read_page` | Read a single wiki page by name (e.g. `computer-misuse-act-1993`) |

---

## Step 6: Verify Claude Code picks up the skill

After install, in any project:

```bash
claude
```

Then in Claude Code:

```
/laws-consultant
```

Should load the skill. Test a real query:

```
What are PDPA breach notification obligations?
```

The skill instructs Claude to ground each claim in wiki evidence. With the MCP server running, Claude will call `wiki_search` and `wiki_read_page` to retrieve source material before answering.

---

## Policy

- Do not unzip `.mcpb` on receiver production machines.
- Do not ship or install raw wiki markdown pages — wiki content is sealed inside the bundle.
- Use `EXPECTED_PUBKEY_SHA256` in regulated environments. Without it the trust root is the tarball.
- The `meter.jsonl` file is append-only. Do not delete it between sessions.
- The `meter-state.json` file stores chain continuity metadata. Do not modify it manually.

## Optional destination overrides

Defaults:
- skill guide layer: `~/.claude/skills/`
- sealed bundle + server staging: `~/.skillpack/bundles/`

Override at install time:

```bash
SKILL_DEST_ROOT="/custom/skills" BUNDLE_DEST_ROOT="/custom/bundles" \
  ./runtime/receiver-verify-install.sh
```

Then update the `args` paths in your MCP config to match.
