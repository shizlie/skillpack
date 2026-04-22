# Receiver Runbook

Goal: install `laws-consultant` on a receiver machine, verify integrity and authenticity, enable the wiki MCP server, and confirm Claude Code picks up the skill.

---

## Step 0: Rebuild (scripts changed this session)

```bash
VERSION="$(cat VERSION)"
bun run bundle:laws-consultant
```

Outputs:

```
dist/skills/laws-consultant-<version>.mcpb
dist/skills/laws-consultant-<version>/          (release folder)
dist/skills/laws-consultant-<version>-bundle.tar.gz
dist/skills/laws-consultant-<version>-bundle.tar.gz.sha256
```

The `.sha256` sidecar lets receivers verify tarball integrity before extracting.

---

## Step 1: Local receiver simulation (5 min, same machine)

```bash
VERSION="$(cat VERSION)"
RECEIVER_DIR="/tmp/receiver-test-$VERSION"

# Simulate transfer to a separate receiver folder
rm -rf "$RECEIVER_DIR"
mkdir -p "$RECEIVER_DIR"
cp "dist/skills/laws-consultant-$VERSION-bundle.tar.gz" "$RECEIVER_DIR/"

# Receiver side
cd "$RECEIVER_DIR"
tar -xzf "laws-consultant-$VERSION-bundle.tar.gz"
cd "laws-consultant-$VERSION"

# Run the one-command flow
./runtime/receiver-verify-install.sh
```

Expected output:

```
[1/4] checksum verification
laws-consultant-<version>.mcpb: OK
laws-consultant-<version>.public.pem: OK
runtime/server.mjs: OK
runtime/server-util.mjs: OK
runtime/wiki-rag-src/cli.ts: OK

  WARNING: key pinning skipped...   ← expected without pinning

[3/4] bundle signature and manifest verification
{"ok":true,"bundle":"...","verifiedFiles":5,"bundleId":"laws-consultant","version":"<version>"}
[4/4] install guide layer and stage sealed bundle
installed skill:      ~/.claude/skills/laws-consultant
staged sealed bundle: ~/.skillpack/bundles/laws-consultant/laws-consultant-<version>.mcpb
staged MCP server:    ~/.skillpack/bundles/laws-consultant/server.mjs

To enable the wiki knowledge base, add to ~/.claude.json (or project .mcp.json):
  "mcpServers": {
    "laws-consultant-wiki": {
      "command": "node",
      "args": ["/Users/you/.skillpack/bundles/laws-consultant/server.mjs",
               "/Users/you/.skillpack/bundles/laws-consultant/laws-consultant-<version>.mcpb"]
    }
  }
```

Verify installs landed:

```bash
ls ~/.claude/skills/laws-consultant/     # SKILL.md
ls ~/.skillpack/bundles/laws-consultant/ # .mcpb + .pem + server.mjs
```

## Step 1B: Full receiver smoke test (query from extracted receiver folder)

This confirms runtime works from the extracted transfer folder, not from repo paths.

```bash
VERSION="$(cat VERSION)"
RECEIVER_DIR="/tmp/receiver-test-$VERSION/laws-consultant-$VERSION"
cd "$RECEIVER_DIR"

# Legacy path should succeed
printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"wiki_search","arguments":{"query":"copyright","limit":2}}}\n' \
| RAG_ENGINE=legacy RAG_FAIL_OPEN=true node runtime/server.mjs "laws-consultant-$VERSION.mcpb" "laws-consultant-$VERSION.public.pem"

# SQLite path should also succeed in the receiver folder
printf '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"wiki_search","arguments":{"query":"copyright","limit":2}}}\n' \
| RAG_ENGINE=sqlite RAG_FAIL_OPEN=false node runtime/server.mjs "laws-consultant-$VERSION.mcpb" "laws-consultant-$VERSION.public.pem"
```

Expected:

- both commands return JSON-RPC `result.content`
- sqlite run does not show `Module not found ... wiki-rag/src/cli.ts`

---

## Step 2: With key pinning (intended prod flow)

Get the public key fingerprint out-of-band from the vendor (email, portal, signed release notes):

```bash
# Vendor runs this, sends the SHA256 to receiver
shasum -a 256 dist/skills/laws-consultant-$VERSION/laws-consultant-$VERSION.public.pem | awk '{print $1}'
```

Receiver uses it:

```bash
VERSION="$(cat VERSION)"
cd "/tmp/receiver-test-$VERSION/laws-consultant-$VERSION"
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
COPY laws-consultant-<version>-bundle.tar.gz /tmp/
RUN tar -xzf /tmp/laws-consultant-<version>-bundle.tar.gz -C /tmp
WORKDIR /tmp/laws-consultant-<version>
RUN ./runtime/receiver-verify-install.sh
RUN ls ~/.claude/skills/laws-consultant/SKILL.md && echo "SKILL INSTALLED OK"
RUN ls ~/.skillpack/bundles/laws-consultant/laws-consultant-<version>.mcpb && echo "BUNDLE STAGED OK"
```

```bash
cp dist/skills/laws-consultant-<version>-bundle.tar.gz /tmp/
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
VERSION="$(cat VERSION)"
cd "/tmp/receiver-test-$VERSION"
tar -xzf "laws-consultant-$VERSION-bundle.tar.gz"
cd "laws-consultant-$VERSION"

# Test 1: Tampered bundle content → checksum fails
echo "evil" >> "laws-consultant-$VERSION.mcpb"
./runtime/receiver-verify-install.sh
# Expected: "laws-consultant-$VERSION.mcpb: FAILED"

# Test 2: Wrong public key → signature fails
# Swap in a foreign public key, recompute SHA256SUMS to pass step 1
shasum -a 256 "laws-consultant-$VERSION.mcpb" "laws-consultant-$VERSION.public.pem" > SHA256SUMS
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
BUNDLE_ABS="$(pwd)/laws-consultant-$VERSION.mcpb"
WORK=$(mktemp -d)
unzip -q "$BUNDLE_ABS" -d "$WORK"
echo '{"bundleId":"evil"}' > "$WORK/manifest.json"
(cd "$WORK" && zip -qr "$BUNDLE_ABS" .)
BUNDLE_SHA=$(shasum -a 256 "laws-consultant-$VERSION.mcpb" | awk '{print $1}')
PEM_SHA=$(shasum -a 256 "laws-consultant-$VERSION.public.pem" | awk '{print $1}')
printf "%s  %s\n%s  %s\n" "$BUNDLE_SHA" "laws-consultant-$VERSION.mcpb" \
  "$PEM_SHA" "laws-consultant-$VERSION.public.pem" > SHA256SUMS
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
               "/Users/you/.skillpack/bundles/laws-consultant/laws-consultant-<version>.mcpb"]
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

| Tool             | Description                                                                  |
| ---------------- | ---------------------------------------------------------------------------- |
| `wiki_search`    | Full-text search across all wiki pages, returns ranked results with snippets |
| `wiki_read_page` | Read a single wiki page by name (e.g. `computer-misuse-act-1993`)            |
| `wiki_runtime_info` | Returns runtime bundle metadata (version, lease mode, seat/workspace/policy when available) |

---

## Step 6: Verify Claude Code picks up the skill

This is the receiver end-user check. No terminal commands required after setup.

After the operator has completed Step 1-5, the receiver end user should:

0. Ask the agent to show runtime metadata from the bundle/runtime itself:

```text
Before answering, call wiki_runtime_info and show: bundle version, lease mode, seatId, workspaceId/policyId (if available).
```

This should come from the loaded `.mcpb` runtime context, not manual operator notes.

1. Open Claude Code.
2. Run:

```text
/laws-consultant
```

3. Ask the following UAT prompts:

- `What are PDPA breach notification obligations?`
- `What are CII obligations under the Cybersecurity Act?`
- `Summarize unauthorized access risk under the Computer Misuse Act.`
- `Map key MAS TRM controls to implementation actions.`
- `Create a cross-statute compliance checklist for a new SaaS launch.`

4. For each response, verify:

- cites wiki-grounded evidence/pages
- separates law text vs guidance/practice
- includes concrete risk notes and next actions
- does not present unqualified legal advice
- labels provenance for each key claim:
  - wiki/local retrieval,
  - model memory,
  - external/internet
- any non-wiki claim is explicitly marked non-wiki and lower-confidence

Pass criteria:

- 5/5 prompts return grounded responses with citations.
- no obvious hallucinated statute names or fabricated sections.
- response quality is stable across repeated runs of the same prompt.
- non-wiki claims are clearly flagged and never presented as cited wiki facts.

Recommended prefix to add before each UAT prompt:

```text
First call wiki_runtime_info and show bundle version, lease mode, seatId, workspaceId/policyId when available. Use local laws-consultant wiki as primary source. For each factual claim, cite the wiki page name and note whether it came from wiki_search/wiki_read_page. If a claim is not from wiki, label it as [NON-WIKI: model memory] or [NON-WIKI: external]. Do not mix non-wiki claims into cited wiki facts.
```

---

## Step 7 (optional): Operator diagnostics if end-user UAT fails

If the end user reports poor/ungrounded answers, operator can quickly validate MCP wiring:

```bash
VERSION="$(cat VERSION)"
printf '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"wiki_search","arguments":{"query":"PDPA breach notification","limit":2}}}\n' \
| RAG_ENGINE=sqlite RAG_FAIL_OPEN=true node "$HOME/.skillpack/bundles/laws-consultant/server.mjs" "$HOME/.skillpack/bundles/laws-consultant/laws-consultant-$VERSION.mcpb"
```

If policy-loop validation is needed (`issue -> use -> warn -> stop -> renew -> continue`), run:

```bash
./scripts/demo-policy-loop.sh
```

Full reference: `docs/runbooks/policy-loop-demo.md`.

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
