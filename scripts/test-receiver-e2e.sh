#!/usr/bin/env bash
# E2E test suite for receiver-verify-install flow.
# Run from repo root: bash scripts/test-receiver-e2e.sh
# Requires: bun, node >= 15, rsync, unzip, shasum
# Optional: docker (for fresh-machine test)

set -euo pipefail

VERSION=$(cat VERSION 2>/dev/null | tr -d '[:space:]') || VERSION="0.1.0.0"
BUNDLE_NAME="laws-consultant-${VERSION}"
DIST_DIR="dist/skills"
TARBALL="${DIST_DIR}/${BUNDLE_NAME}-bundle.tar.gz"
TARBALL_SHA="${TARBALL}.sha256"
RELEASE_DIR="${DIST_DIR}/${BUNDLE_NAME}"

PASS=0
FAIL=0

pass() { echo "  PASS: $1"; PASS=$((PASS + 1)); }
fail() { echo "  FAIL: $1"; FAIL=$((FAIL + 1)); }
section() { echo; echo "=== $1 ==="; }

# ── helpers ──────────────────────────────────────────────────────────────────

fresh_receiver_dir() {
  local dir
  dir=$(mktemp -d /tmp/receiver-test-XXXXXX)
  cp "${TARBALL}" "${dir}/"
  echo "${dir}"
}

extract_in() {
  local dir="$1"
  cd "${dir}"
  tar -xzf "${BUNDLE_NAME}-bundle.tar.gz"
  cd "${BUNDLE_NAME}"
}

# ── step 0: build ─────────────────────────────────────────────────────────────

section "0. Build"

echo "  Running bun run bundle:laws-consultant ..."
if bun run bundle:laws-consultant; then
  pass "bundle script exits 0"
else
  fail "bundle script failed — aborting"
  exit 1
fi

[ -f "${DIST_DIR}/${BUNDLE_NAME}.mcpb" ] && pass ".mcpb exists" || fail ".mcpb missing"
[ -f "${TARBALL}" ]                       && pass "tarball exists" || fail "tarball missing"
[ -f "${TARBALL_SHA}" ]                   && pass "tarball .sha256 sidecar exists" || fail "tarball .sha256 missing"
[ -f "${RELEASE_DIR}/SHA256SUMS" ]        && pass "SHA256SUMS exists" || fail "SHA256SUMS missing"
[ -f "${RELEASE_DIR}/runtime/receiver-verify-install.sh" ] && pass "receiver script exists" || fail "receiver script missing"
[ -f "${RELEASE_DIR}/runtime/verify-bundle.mjs" ]          && pass "verify-bundle.mjs exists" || fail "verify-bundle.mjs missing"
[ -f "${RELEASE_DIR}/skill/laws-consultant/SKILL.md" ]     && pass "SKILL.md in release" || fail "SKILL.md missing from release"

# ── step 1: happy path (no key pinning) ───────────────────────────────────────

section "1. Receiver happy path (no key pinning)"

RECV=$(fresh_receiver_dir)
(
  extract_in "${RECV}"
  SKILL_DEST_ROOT="${RECV}/skills" BUNDLE_DEST_ROOT="${RECV}/bundles" \
    ./runtime/receiver-verify-install.sh
) && pass "receiver script exits 0" || fail "receiver script failed"

[ -f "${RECV}/skills/laws-consultant/SKILL.md" ] \
  && pass "SKILL.md installed to skill dest" \
  || fail "SKILL.md not installed"

[ -f "${RECV}/bundles/laws-consultant/${BUNDLE_NAME}.mcpb" ] \
  && pass ".mcpb staged to bundle dest" \
  || fail ".mcpb not staged"

rm -rf "${RECV}"

# ── step 2: key pinning ───────────────────────────────────────────────────────

section "2. Key pinning (EXPECTED_PUBKEY_SHA256)"

RECV=$(fresh_receiver_dir)
(
  extract_in "${RECV}"
  REAL_SHA=$(shasum -a 256 "${BUNDLE_NAME}.public.pem" | awk '{print $1}')
  SKILL_DEST_ROOT="${RECV}/skills" BUNDLE_DEST_ROOT="${RECV}/bundles" \
    EXPECTED_PUBKEY_SHA256="${REAL_SHA}" ./runtime/receiver-verify-install.sh
) && pass "key pinning with correct SHA passes" || fail "key pinning with correct SHA failed"

RECV2=$(fresh_receiver_dir)
(
  extract_in "${RECV2}"
  set +e
  SKILL_DEST_ROOT="${RECV2}/skills" BUNDLE_DEST_ROOT="${RECV2}/bundles" \
    EXPECTED_PUBKEY_SHA256="deadbeef000000000000000000000000000000000000000000000000000000" \
    ./runtime/receiver-verify-install.sh 2>&1
  STATUS=$?
  set -e
  [ "${STATUS}" -ne 0 ]
) && pass "wrong key SHA rejected (exit non-0)" || fail "wrong key SHA should fail"

rm -rf "${RECV}" "${RECV2}"

# ── step 3: tamper tests ──────────────────────────────────────────────────────

section "3. Tamper tests"

# 3a: tamper bundle content → SHA256SUMS fails
RECV=$(fresh_receiver_dir)
(
  extract_in "${RECV}"
  echo "evil" >> "${BUNDLE_NAME}.mcpb"
  set +e
  ./runtime/receiver-verify-install.sh 2>&1
  STATUS=$?
  set -e
  [ "${STATUS}" -ne 0 ]
) && pass "tampered .mcpb rejected by shasum" || fail "tampered .mcpb should fail"
rm -rf "${RECV}"

# 3b: remove SHA256SUMS → script exits 1
RECV=$(fresh_receiver_dir)
(
  extract_in "${RECV}"
  rm SHA256SUMS
  set +e
  ./runtime/receiver-verify-install.sh 2>&1
  STATUS=$?
  set -e
  [ "${STATUS}" -ne 0 ]
) && pass "missing SHA256SUMS rejected" || fail "missing SHA256SUMS should fail"
rm -rf "${RECV}"

# 3c: tamper manifest inside .mcpb → signature fails
RECV=$(fresh_receiver_dir)
(
  extract_in "${RECV}"
  WORK=$(mktemp -d)
  BUNDLE_ABS="$(pwd)/${BUNDLE_NAME}.mcpb"
  unzip -q "${BUNDLE_ABS}" -d "${WORK}"
  # corrupt manifest
  echo '{"bundleId":"evil"}' > "${WORK}/manifest.json"
  # repack over the original bundle path so checksum verification sees the tampered file
  (cd "${WORK}" && zip -qr "${BUNDLE_ABS}" .)
  # recompute SHA256SUMS so step 1 passes, but signature check (step 3) must fail
  BUNDLE_SHA=$(shasum -a 256 "${BUNDLE_NAME}.mcpb" | awk '{print $1}')
  PEM_SHA=$(shasum -a 256 "${BUNDLE_NAME}.public.pem" | awk '{print $1}')
  printf "%s  %s\n%s  %s\n" \
    "${BUNDLE_SHA}" "${BUNDLE_NAME}.mcpb" \
    "${PEM_SHA}" "${BUNDLE_NAME}.public.pem" > SHA256SUMS
  rm -rf "${WORK}"
  set +e
  SKILL_DEST_ROOT="${RECV}/skills" BUNDLE_DEST_ROOT="${RECV}/bundles" \
    ./runtime/receiver-verify-install.sh 2>&1
  STATUS=$?
  set -e
  [ "${STATUS}" -ne 0 ]
) && pass "tampered manifest rejected by signature check" || fail "tampered manifest should fail signature"
rm -rf "${RECV}"

# 3b: missing bundle file
RECV=$(fresh_receiver_dir)
(
  extract_in "${RECV}"
  rm "${BUNDLE_NAME}.mcpb"
  set +e
  ./runtime/receiver-verify-install.sh 2>&1
  STATUS=$?
  set -e
  [ "${STATUS}" -ne 0 ]
) && pass "missing bundle file rejected" || fail "missing bundle should fail"
rm -rf "${RECV}"

# ── step 4: tarball sidecar integrity ─────────────────────────────────────────

section "4. Tarball transfer integrity (.sha256 sidecar)"

EXPECTED=$(awk '{print $1}' "${TARBALL_SHA}")
ACTUAL=$(shasum -a 256 "${TARBALL}" | awk '{print $1}')
[ "${EXPECTED}" = "${ACTUAL}" ] \
  && pass "tarball sha256 sidecar matches" \
  || fail "tarball sha256 sidecar mismatch (expected ${EXPECTED}, got ${ACTUAL})"

# ── step 5: node version guard ────────────────────────────────────────────────

section "5. Node version guard in verify-bundle.mjs"

if node --version 2>/dev/null | grep -q "^v1[5-9]\|^v[2-9]"; then
  pass "current node $(node --version) >= 15 (guard would pass)"
else
  fail "current node $(node --version) < 15 — verify-bundle.mjs will reject it"
fi

# ── step 6: runtime startup verification + meter continuity ───────────────────

section "6. Runtime startup verification + meter continuity"

RECV=$(fresh_receiver_dir)
(
  extract_in "${RECV}"
  SKILL_DEST_ROOT="${RECV}/skills" BUNDLE_DEST_ROOT="${RECV}/bundles" \
    ./runtime/receiver-verify-install.sh >/dev/null

  BUNDLE_STAGE="${RECV}/bundles/laws-consultant"
  SERVER_PATH="${BUNDLE_STAGE}/server.mjs"
  BUNDLE_PATH="${BUNDLE_STAGE}/${BUNDLE_NAME}.mcpb"
  METER_STATE="${BUNDLE_STAGE}/meter-state.json"
  METER_LOG="${BUNDLE_STAGE}/meter.jsonl"

  # First start: should create meter state/log
  node "${SERVER_PATH}" "${BUNDLE_PATH}" < /dev/null >/dev/null 2>&1
  [ -f "${METER_STATE}" ] && pass "meter-state.json created after server start" || fail "meter-state.json missing after server start"
  [ -f "${METER_LOG}" ] && pass "meter.jsonl created after server start" || fail "meter.jsonl missing after server start"

  SEQ1=$(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(p.seq);' "${METER_STATE}")

  # Second start: seq must advance (continuity across restarts)
  node "${SERVER_PATH}" "${BUNDLE_PATH}" < /dev/null >/dev/null 2>&1
  SEQ2=$(node -e 'const fs=require("fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); console.log(p.seq);' "${METER_STATE}")
  [ "${SEQ2}" -gt "${SEQ1}" ] && pass "meter sequence advances across restarts" || fail "meter sequence did not advance across restarts"
)
rm -rf "${RECV}"

RECV=$(fresh_receiver_dir)
(
  extract_in "${RECV}"
  SKILL_DEST_ROOT="${RECV}/skills" BUNDLE_DEST_ROOT="${RECV}/bundles" \
    ./runtime/receiver-verify-install.sh >/dev/null

  BUNDLE_STAGE="${RECV}/bundles/laws-consultant"
  SERVER_PATH="${BUNDLE_STAGE}/server.mjs"
  BUNDLE_PATH="${BUNDLE_STAGE}/${BUNDLE_NAME}.mcpb"
  TAMPER_DIR=$(mktemp -d)

  unzip -q "${BUNDLE_PATH}" -d "${TAMPER_DIR}"
  echo '{"bundleId":"tampered"}' > "${TAMPER_DIR}/manifest.json"
  (cd "${TAMPER_DIR}" && zip -qr "${BUNDLE_PATH}" .) || { echo "[ERROR] zip repack failed — cannot run tamper test"; rm -rf "${TAMPER_DIR}"; exit 1; }
  rm -rf "${TAMPER_DIR}"

  set +e
  node "${SERVER_PATH}" "${BUNDLE_PATH}" < /dev/null >/dev/null 2>&1
  STATUS=$?
  set -e
  [ "${STATUS}" -ne 0 ]
) && pass "runtime server rejects tampered bundle at startup" || fail "runtime server should reject tampered bundle at startup"
rm -rf "${RECV}"

# ── step 7: docker fresh machine (optional) ───────────────────────────────────

section "7. Docker fresh machine (optional)"

if ! command -v docker >/dev/null 2>&1; then
  echo "  SKIP: docker not available"
elif ! docker info >/dev/null 2>&1; then
  echo "  SKIP: docker daemon not running"
else
  DOCKERFILE=$(mktemp /tmp/Dockerfile-receiver-XXXXXX)
  cat > "${DOCKERFILE}" <<DOCKERFILE
FROM node:18-slim
RUN apt-get update && apt-get install -y rsync unzip && rm -rf /var/lib/apt/lists/*
COPY ${BUNDLE_NAME}-bundle.tar.gz /tmp/
RUN tar -xzf /tmp/${BUNDLE_NAME}-bundle.tar.gz -C /tmp
WORKDIR /tmp/${BUNDLE_NAME}
RUN SKILL_DEST_ROOT=/tmp/skills BUNDLE_DEST_ROOT=/tmp/bundles ./runtime/receiver-verify-install.sh
RUN test -f /tmp/skills/laws-consultant/SKILL.md && echo "SKILL_INSTALLED_OK"
RUN test -f /tmp/bundles/laws-consultant/${BUNDLE_NAME}.mcpb && echo "BUNDLE_STAGED_OK"
DOCKERFILE

  cp "${TARBALL}" /tmp/
  if docker build -f "${DOCKERFILE}" /tmp/ --no-cache --quiet 2>&1 | tail -5; then
    pass "docker fresh-machine build passes"
  else
    fail "docker fresh-machine build failed"
  fi
  rm -f "${DOCKERFILE}"
fi

# ── results ───────────────────────────────────────────────────────────────────

echo
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Results: ${PASS} passed, ${FAIL} failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

[ "${FAIL}" -eq 0 ] && exit 0 || exit 1
