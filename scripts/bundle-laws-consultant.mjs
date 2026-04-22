import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

import { generateEd25519KeyPair } from "../packages/crypto/src/index.js";
import { createLicenseFetchHandler } from "../packages/license-server/src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const bundleId = "laws-consultant";
const version = fs.readFileSync(path.join(repoRoot, "VERSION"), "utf8").trim() || "0.1.0";
const SAFE_ID = /^[a-zA-Z0-9._-]+$/;
if (!SAFE_ID.test(bundleId)) throw new Error(`unsafe bundleId: ${bundleId}`);
if (!SAFE_ID.test(version)) throw new Error(`unsafe version string in VERSION file: ${version}`);

const verticalRoot = path.join(repoRoot, "verticals", "laws-consultant");
const distributionDir = path.join(repoRoot, "verticals", "laws-consultant", "distribution");
const keysDir = path.join(distributionDir, "keys");
const privateKeyFile = path.join(keysDir, "dev-private.pem");
const publicKeyFile = path.join(keysDir, "dev-public.pem");
const licenseFile = path.join(distributionDir, "license.dev.json");
const outputDir = path.join(repoRoot, "dist", "skills");
const outputFile = path.join(outputDir, `${bundleId}-${version}.mcpb`);
const releaseDir = path.join(outputDir, `${bundleId}-${version}`);
const releaseBundleFile = path.join(releaseDir, `${bundleId}-${version}.mcpb`);
const releasePublicKeyFile = path.join(releaseDir, `${bundleId}-${version}.public.pem`);
const releaseSkillDir = path.join(releaseDir, "skill", bundleId);
const releaseRuntimeDir = path.join(releaseDir, "runtime");
const releaseRuntimeWikiRagSrcDir = path.join(releaseRuntimeDir, "wiki-rag-src");
const releaseVerifyScript = path.join(releaseRuntimeDir, "verify-bundle.mjs");
const releaseInstallScript = path.join(releaseRuntimeDir, "install-skill.sh");
const releaseReceiverScript = path.join(
  releaseRuntimeDir,
  "receiver-verify-install.sh"
);
const releaseVerifyReadme = path.join(releaseDir, "VERIFY.md");
const releaseChecksumsFile = path.join(releaseDir, "SHA256SUMS");
const releaseTarball = path.join(outputDir, `${bundleId}-${version}-bundle.tar.gz`);

function copyDirRecursively(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const src = path.join(sourceDir, entry.name);
    const dst = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursively(src, dst);
      continue;
    }
    if (entry.isFile()) {
      fs.copyFileSync(src, dst);
    }
  }
}

function sha256Hex(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

fs.mkdirSync(keysDir, { recursive: true });
fs.mkdirSync(outputDir, { recursive: true });

if (!fs.existsSync(privateKeyFile) || !fs.existsSync(publicKeyFile)) {
  // Regenerate both if either is missing — partial state from interrupted runs would produce mismatched pairs
  const keys = generateEd25519KeyPair();
  fs.writeFileSync(privateKeyFile, keys.privateKeyPem, { mode: 0o600 });
  fs.writeFileSync(publicKeyFile, keys.publicKeyPem, { mode: 0o644 });
}

// Issue a dev lease at build time so server.mjs can perform real lease verification
const licenseBase = JSON.parse(fs.readFileSync(licenseFile, "utf8"));
const _privateKeyPem = fs.readFileSync(privateKeyFile, "utf8");
const _publicKeyPem = fs.readFileSync(publicKeyFile, "utf8");
const _licenseFetch = createLicenseFetchHandler({
  signingPrivateKeyPem: _privateKeyPem,
  signingPublicKeyPem: _publicKeyPem,
});
const _leaseResp = await _licenseFetch(
  new Request("http://local/v1/leases/issue", {
    method: "POST",
    body: JSON.stringify({
      customerId: licenseBase.customerId ?? "demo-customer",
      seatId: licenseBase.seatId ?? "default",
      vendorId: licenseBase.bundleId ?? bundleId,
      ttlSec: ((licenseBase.policy?.ttlDays ?? 30) * 24 * 60 * 60),
    }),
  })
);
const { leaseToken } = await _leaseResp.json();
if (!leaseToken) throw new Error("license_server_did_not_return_lease_token");

const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "laws-consultant-skill-"));
fs.chmodSync(stagingRoot, 0o700);

// Write augmented license (with leaseToken) for embedding in the bundle
const augmentedLicenseFile = path.join(stagingRoot, "license-with-token.json");
fs.writeFileSync(augmentedLicenseFile, JSON.stringify({ ...licenseBase, leaseToken }, null, 2) + "\n");

const inputDir = path.join(stagingRoot, bundleId);
fs.mkdirSync(inputDir, { recursive: true });
fs.copyFileSync(path.join(verticalRoot, "SKILL.md"), path.join(inputDir, "SKILL.md"));
// policy.json in inputDir → becomes skill/policy.json in bundle → covered by manifest signature
const policySourceFile = path.join(distributionDir, "policy.dev.json");
if (fs.existsSync(policySourceFile)) {
  fs.copyFileSync(policySourceFile, path.join(inputDir, "policy.json"));
}
fs.mkdirSync(path.join(inputDir, "knowledge"), { recursive: true });
const wikiArchive = path.join(inputDir, "knowledge", "wiki.tar.gz");
const wikiTar = spawnSync(
  "tar",
  ["-czf", wikiArchive, "wiki"],
  { cwd: verticalRoot, encoding: "utf8" }
);
if (wikiTar.status !== 0) {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  throw new Error(`wiki_archive_failed:${wikiTar.stderr?.trim() || "unknown"}`);
}

const wikiSourceDir = path.join(verticalRoot, "wiki");
const preindexDbPath = path.join(inputDir, "knowledge", "wiki-rag.db");
const preindexMetadataPath = path.join(inputDir, "knowledge", "wiki-rag.json");
const preindexResult = spawnSync(
  "bun",
  [
    "wiki-rag/src/cli.ts",
    "index",
    "--db",
    preindexDbPath,
    "--root",
    wikiSourceDir,
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
  }
);

const preindexReady = preindexResult.status === 0;
if (!preindexReady) {
  fs.rmSync(preindexDbPath, { force: true });
  process.stderr.write(
    `[WARN] wiki preindex failed; runtime will fail-open to legacy engine: ${(preindexResult.stderr || "").trim()}\n`
  );
}
fs.writeFileSync(
  preindexMetadataPath,
  JSON.stringify(
    {
      engine: preindexReady ? "sqlite" : "legacy",
      preindexReady,
      fallbackEngine: "legacy",
      generatedAt: new Date().toISOString(),
    },
    null,
    2
  ) + "\n"
);

const args = [
  "run",
  "packages/cli/src/cli.js",
  "bundle",
  "build",
  "--input-dir",
  inputDir,
  "--bundle-id",
  bundleId,
  "--version",
  version,
  "--license-file",
  augmentedLicenseFile,
  "--private-key-file",
  privateKeyFile,
  "--output-file",
  outputFile,
];

const result = spawnSync("bun", args, {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.status !== 0) {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

fs.rmSync(releaseDir, { recursive: true, force: true });
fs.rmSync(releaseTarball, { force: true });
fs.mkdirSync(releaseDir, { recursive: true });
fs.mkdirSync(path.join(releaseDir, "skill"), { recursive: true });
fs.mkdirSync(releaseRuntimeDir, { recursive: true });
fs.copyFileSync(outputFile, releaseBundleFile);
fs.copyFileSync(publicKeyFile, releasePublicKeyFile);
fs.mkdirSync(releaseSkillDir, { recursive: true });
fs.copyFileSync(path.join(verticalRoot, "SKILL.md"), path.join(releaseSkillDir, "SKILL.md"));

// Copy the embedded MCP runtime server into the release tarball
const serverMjsSource = path.join(repoRoot, "packages", "runtime", "src", "server.mjs");
const releaseServerScript = path.join(releaseRuntimeDir, "server.mjs");
fs.copyFileSync(serverMjsSource, releaseServerScript);
fs.chmodSync(releaseServerScript, 0o755);

const serverUtilMjsSource = path.join(repoRoot, "packages", "runtime", "src", "server-util.mjs");
const releaseServerUtilScript = path.join(releaseRuntimeDir, "server-util.mjs");
fs.copyFileSync(serverUtilMjsSource, releaseServerUtilScript);
fs.chmodSync(releaseServerUtilScript, 0o755);

const wikiRagSourceDir = path.join(repoRoot, "wiki-rag", "src");
copyDirRecursively(wikiRagSourceDir, releaseRuntimeWikiRagSrcDir);

const bundleSha = sha256Hex(releaseBundleFile);
const pubKeySha = sha256Hex(releasePublicKeyFile);
const serverMjsSha = sha256Hex(releaseServerScript);
const serverUtilMjsSha = sha256Hex(releaseServerUtilScript);
const runtimeWikiCliSha = sha256Hex(path.join(releaseRuntimeWikiRagSrcDir, "cli.ts"));
fs.writeFileSync(
  releaseChecksumsFile,
  `${bundleSha}  ${path.basename(releaseBundleFile)}\n` +
  `${pubKeySha}  ${path.basename(releasePublicKeyFile)}\n` +
  `${serverMjsSha}  runtime/server.mjs\n` +
  `${serverUtilMjsSha}  runtime/server-util.mjs\n` +
  `${runtimeWikiCliSha}  runtime/wiki-rag-src/cli.ts\n`
);

const verifyScript = `#!/usr/bin/env node
if (parseInt(process.versions.node, 10) < 15) {
  process.stderr.write("verify-bundle.mjs requires Node.js >= 15 (crypto.verify Ed25519 support). Found: " + process.version + "\\n");
  process.exit(1);
}
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

function fromBase64Url(value) {
  const padded = value + "===".slice((value.length + 3) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64");
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortJson(value[k])])
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sha256Hex(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

const bundlePath = process.argv[2];
const publicKeyPath = process.argv[3];
if (!bundlePath || !publicKeyPath) {
  console.error("usage: node verify-bundle.mjs <bundle.mcpb> <public.pem>");
  process.exit(2);
}

const absBundle = path.resolve(bundlePath);
const absPub = path.resolve(publicKeyPath);
if (!fs.existsSync(absBundle)) throw new Error("bundle_not_found");
if (!fs.existsSync(absPub)) throw new Error("public_key_not_found");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-skillpack-"));
try {
const listEntries = spawnSync("unzip", ["-l", absBundle], { encoding: "utf8" });
for (const line of (listEntries.stdout || "").split("\\n").slice(3)) {
  const entryName = line.trim().split(/\\s+/).slice(3).join(" ");
  if (!entryName || entryName === "---" || entryName === "Name") continue;
  if (entryName.startsWith("/") || entryName.includes("../")) {
    throw new Error("zip_path_traversal:" + entryName);
  }
}
const unzip = spawnSync("unzip", ["-q", absBundle, "-d", tempDir], { encoding: "utf8" });
if (unzip.status !== 0) {
  throw new Error("unzip_failed");
}

const manifestRaw = fs.readFileSync(path.join(tempDir, "manifest.json"), "utf8");
const manifest = JSON.parse(manifestRaw);
const manifestCanonical = canonicalJson(manifest);
const expectedManifestSha = fs
  .readFileSync(path.join(tempDir, "manifest.sha256"), "utf8")
  .trim();
const actualManifestSha = sha256Hex(manifestCanonical);
if (expectedManifestSha !== actualManifestSha) {
  throw new Error("manifest_sha_mismatch");
}

const signatureB64Url = fs.readFileSync(path.join(tempDir, "signature.bin"), "utf8").trim();
const signature = fromBase64Url(signatureB64Url);
const publicKeyPem = fs.readFileSync(absPub, "utf8");
const verified = crypto.verify(null, Buffer.from(manifestCanonical), publicKeyPem, signature);
if (!verified) {
  throw new Error("manifest_signature_invalid");
}

for (const file of manifest.files) {
  const filePath = path.join(tempDir, file.path);
  if (!fs.existsSync(filePath)) throw new Error("manifest_file_missing:" + file.path);
  const bytes = fs.readFileSync(filePath);
  if (bytes.length !== file.size) throw new Error("manifest_size_mismatch:" + file.path);
  if (sha256Hex(bytes) !== file.sha256) throw new Error("manifest_hash_mismatch:" + file.path);
}

console.log(
  JSON.stringify({
    ok: true,
    bundle: absBundle,
    verifiedFiles: manifest.files.length,
    bundleId: manifest.bundleId,
    version: manifest.version
  })
);
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
`;
fs.writeFileSync(releaseVerifyScript, verifyScript);
fs.chmodSync(releaseVerifyScript, 0o755);

const installScript = `#!/usr/bin/env bash
set -euo pipefail

DEST_ROOT="\${1:-$HOME/.claude/skills}"
DEST_SKILL_DIR="$DEST_ROOT/${bundleId}"
SRC_SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)/skill/${bundleId}"

mkdir -p "$DEST_SKILL_DIR"
rsync -a "$SRC_SKILL_DIR/" "$DEST_SKILL_DIR/"
echo "Installed skill to: $DEST_SKILL_DIR"
`;
fs.writeFileSync(releaseInstallScript, installScript);
fs.chmodSync(releaseInstallScript, 0o755);

const receiverScript = `#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$BASE_DIR"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] node not found. Install Node.js >= 15 before proceeding." >&2
  echo "Install options:" >&2
  echo "  macOS (Homebrew): brew install node@20" >&2
  echo "  Ubuntu/Debian:    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs" >&2
  echo "  Any OS (nvm):     nvm install 20 && nvm use 20" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(\".\")[0])' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 15 ]; then
  echo "[ERROR] Node.js >= 15 required. Found: $(node --version)" >&2
  echo "Install/upgrade Node and rerun this script." >&2
  echo "  macOS (Homebrew): brew install node@20" >&2
  echo "  Ubuntu/Debian:    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs" >&2
  echo "  Any OS (nvm):     nvm install 20 && nvm use 20" >&2
  exit 1
fi
command -v rsync >/dev/null 2>&1 || { echo "[ERROR] rsync not found. Install rsync before proceeding." >&2; exit 1; }
command -v unzip >/dev/null 2>&1 || { echo "[ERROR] unzip not found. Install unzip before proceeding." >&2; exit 1; }
command -v shasum >/dev/null 2>&1 || { echo "[ERROR] shasum not found. Install Perl coreutils package before proceeding." >&2; exit 1; }

BUNDLE_FILE="${bundleId}-${version}.mcpb"
PUBKEY_FILE="${bundleId}-${version}.public.pem"
SKILL_NAME="${bundleId}"
SKILL_DEST_ROOT="${'$'}{SKILL_DEST_ROOT:-${'$'}HOME/.claude/skills}"
BUNDLE_DEST_ROOT="${'$'}{BUNDLE_DEST_ROOT:-${'$'}HOME/.skillpack/bundles}"
SKILL_DEST="${'$'}SKILL_DEST_ROOT/${bundleId}"
BUNDLE_DEST="${'$'}BUNDLE_DEST_ROOT/${bundleId}"

if [ ! -f "$BUNDLE_FILE" ]; then
  echo "missing bundle: $BUNDLE_FILE" >&2
  exit 1
fi
if [ ! -f "$PUBKEY_FILE" ]; then
  echo "missing public key: $PUBKEY_FILE" >&2
  exit 1
fi
if [ ! -f "SHA256SUMS" ]; then
  echo "missing SHA256SUMS" >&2
  exit 1
fi

echo "[1/4] checksum verification"
shasum -a 256 -c SHA256SUMS

if [ -n "${'$'}{EXPECTED_PUBKEY_SHA256:-}" ]; then
  echo "[2/4] public key fingerprint verification"
  ACTUAL_KEY_SHA="$(shasum -a 256 "$PUBKEY_FILE" | awk '{print $1}')"
  if [ "$ACTUAL_KEY_SHA" != "${'$'}EXPECTED_PUBKEY_SHA256" ]; then
    echo "public key fingerprint mismatch" >&2
    echo "expected: ${'$'}EXPECTED_PUBKEY_SHA256" >&2
    echo "actual:   $ACTUAL_KEY_SHA" >&2
    exit 1
  fi
else
  echo "" >&2
  echo "  WARNING: key pinning skipped. Without EXPECTED_PUBKEY_SHA256 the trust root" >&2
  echo "  is the tarball itself. An attacker who replaces bundle + public key +" >&2
  echo "  SHA256SUMS in the same tarball will pass all checks." >&2
  echo "  Obtain the trusted public key SHA256 from the vendor out-of-band and rerun:" >&2
  echo "    EXPECTED_PUBKEY_SHA256=<sha256> ./runtime/receiver-verify-install.sh" >&2
  echo "" >&2
fi

echo "[3/4] bundle signature and manifest verification"
node runtime/verify-bundle.mjs "$BUNDLE_FILE" "$PUBKEY_FILE"

echo "[4/4] install guide layer and stage sealed bundle"
mkdir -p "$SKILL_DEST"
rsync -a "skill/$SKILL_NAME/" "$SKILL_DEST/"
mkdir -p "$BUNDLE_DEST"
cp "$BUNDLE_FILE" "$BUNDLE_DEST/"
cp "$PUBKEY_FILE" "$BUNDLE_DEST/"
cp runtime/server.mjs "$BUNDLE_DEST/"
cp runtime/server-util.mjs "$BUNDLE_DEST/"
rsync -a runtime/wiki-rag-src/ "$BUNDLE_DEST/wiki-rag-src/"

echo "installed skill:      ${'$'}SKILL_DEST"
echo "staged sealed bundle: ${'$'}BUNDLE_DEST/${'$'}BUNDLE_FILE"
echo "staged MCP server:    ${'$'}BUNDLE_DEST/server.mjs"
echo ""
echo "To enable the wiki knowledge base, add to ~/.claude.json (or project .mcp.json):"
echo "  \\"mcpServers\\": {"
echo "    \\"${bundleId}-wiki\\": {"
echo "      \\"command\\": \\"node\\","
echo "      \\"args\\": [\\"${'$'}BUNDLE_DEST/server.mjs\\", \\"${'$'}BUNDLE_DEST/${'$'}BUNDLE_FILE\\"]"
echo "    }"
echo "  }"
echo ""
echo "best practice: do not unzip .mcpb in production."
`;
fs.writeFileSync(releaseReceiverScript, receiverScript);
fs.chmodSync(releaseReceiverScript, 0o755);

const verifyReadme = `# Verify + Install (${bundleId} ${version})

## One-command receiver flow (best practice)

\`\`\`bash
cd "$(dirname "$0")"
./runtime/receiver-verify-install.sh
\`\`\`

Optional strict public-key pinning:

\`\`\`bash
EXPECTED_PUBKEY_SHA256="<trusted-sha256>" ./runtime/receiver-verify-install.sh
\`\`\`

## Manual verification flow

\`\`\`bash
cd "$(dirname "$0")"
shasum -a 256 -c SHA256SUMS
node runtime/verify-bundle.mjs ${path.basename(releaseBundleFile)} ${path.basename(releasePublicKeyFile)}
\`\`\`

## Install as Claude Code skill

Claude Code skills are folder-based (not direct .mcpb import). Copy the extracted skill folder:

\`\`\`bash
./runtime/install-skill.sh
\`\`\`

Then start Claude Code in any project and run:

\`\`\`text
/${bundleId}
\`\`\`
`;
fs.writeFileSync(releaseVerifyReadme, verifyReadme);

const tar = spawnSync(
  "tar",
  ["-czf", releaseTarball, path.basename(releaseDir)],
  { cwd: outputDir, encoding: "utf8" }
);
if (tar.status !== 0) {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  throw new Error(`tar_failed:${tar.stderr?.trim() || "unknown"}`);
}

const tarballSha = sha256Hex(releaseTarball);
fs.writeFileSync(
  `${releaseTarball}.sha256`,
  `${tarballSha}  ${path.basename(releaseTarball)}\n`
);

fs.rmSync(stagingRoot, { recursive: true, force: true });
