#!/usr/bin/env bash
# Enclave smoke test — boots a Nitro Enclave and verifies core behavior.
#
# Prerequisites: nitro-cli, argonaut, jq, curl
# Usage: ./scripts/enclave-smoke-test.sh out/nitro.eif <path-to-argonaut>
set -euo pipefail

EIF_PATH="${1:?Usage: $0 <path-to-eif> <argonaut-path>}"
ARGONAUT="${2:?Usage: $0 <path-to-eif> <argonaut-path>}"
HTTP_PORT=8080
VSOCK_HTTP_PORT=3000
ENCLAVE_MEMORY=4096
ENCLAVE_CPUS=2
ENCLAVE_CID=""
HOST_PID=""
CONFIG_FILE=""

cleanup() {
  echo "[smoke] cleaning up..."
  [[ -n "$HOST_PID" ]] && kill "$HOST_PID" 2>/dev/null || true
  [[ -n "$CONFIG_FILE" ]] && rm -f "$CONFIG_FILE" 2>/dev/null || true
  nitro-cli terminate-enclave --all 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "[smoke] FAIL: $1"; exit 1; }
pass() { echo "[smoke] PASS: $1"; }

# --- Boot enclave ---
echo "[smoke] booting enclave from $EIF_PATH"
ENCLAVE_OUTPUT=$(nitro-cli run-enclave \
  --cpu-count "$ENCLAVE_CPUS" \
  --memory "$ENCLAVE_MEMORY" \
  --eif-path "$EIF_PATH")

ENCLAVE_CID=$(echo "$ENCLAVE_OUTPUT" | jq -r '.EnclaveCID')
ENCLAVE_ID=$(echo "$ENCLAVE_OUTPUT" | jq -r '.EnclaveID')
echo "[smoke] enclave started: CID=$ENCLAVE_CID ID=$ENCLAVE_ID"

sleep 2

# --- Write config and start host (config delivery + bridges) ---
CONFIG_FILE=$(mktemp)
cat > "$CONFIG_FILE" <<EOF
{"httpPort":$HTTP_PORT,"httpVsockPort":$VSOCK_HTTP_PORT,"httpTcpPort":$VSOCK_HTTP_PORT,"endpoints":[]}
EOF

echo "[smoke] starting argonaut host with CID=$ENCLAVE_CID"
"$ARGONAUT" host "$ENCLAVE_CID" "$CONFIG_FILE" &
HOST_PID=$!
sleep 3

BASE="http://127.0.0.1:$HTTP_PORT"

# --- Test: attestation ---
echo "[smoke] testing /attestation"
ATTEST=$(curl -sf "$BASE/attestation") || fail "/attestation request failed"
ATTEST_DOC=$(echo "$ATTEST" | jq -r '.attestation')

[[ "$ATTEST_DOC" != "null" ]] || fail "attestation document is null"
[[ ${#ATTEST_DOC} -gt 100 ]] || fail "attestation document suspiciously short: ${#ATTEST_DOC} chars"
pass "/attestation returns document (${#ATTEST_DOC} hex chars)"

# --- Test: 404 ---
echo "[smoke] testing 404"
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "$BASE/nonexistent" || true)
[[ "$STATUS" == "404" ]] || fail "expected 404, got $STATUS"
pass "unknown route returns 404"

echo ""
echo "[smoke] all tests passed"
