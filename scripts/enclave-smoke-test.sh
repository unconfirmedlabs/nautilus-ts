#!/usr/bin/env bash
# Enclave smoke test — boots a Nitro Enclave and verifies core behavior.
#
# Prerequisites: nitro-cli, socat, jq, curl
# Usage: ./scripts/enclave-smoke-test.sh out/nitro.eif
set -euo pipefail

EIF_PATH="${1:?Usage: $0 <path-to-eif>}"
HTTP_PORT=8080
VSOCK_HTTP_PORT=3000
VSOCK_CONFIG_PORT=7777
ENCLAVE_MEMORY=4096
ENCLAVE_CPUS=2
ENCLAVE_CID=""

cleanup() {
  echo "[smoke] cleaning up..."
  # Kill background processes
  kill %socat 2>/dev/null || true
  # Terminate enclave
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

# Give the enclave a moment to reach the VSOCK listen
sleep 2

# --- Send boot config via VSOCK:7777 ---
echo "[smoke] sending boot config via VSOCK:$VSOCK_CONFIG_PORT"
BOOT_CONFIG='{"endpoints":[]}'
echo "$BOOT_CONFIG" | socat - VSOCK-CONNECT:"$ENCLAVE_CID":"$VSOCK_CONFIG_PORT"
echo "[smoke] boot config sent"

# Give the server time to start
sleep 2

# --- Set up inbound HTTP bridge ---
echo "[smoke] bridging TCP:$HTTP_PORT → VSOCK:$ENCLAVE_CID:$VSOCK_HTTP_PORT"
socat TCP-LISTEN:"$HTTP_PORT",fork,reuseaddr VSOCK-CONNECT:"$ENCLAVE_CID":"$VSOCK_HTTP_PORT" &
sleep 1

# --- Test: health_check ---
echo "[smoke] testing /health_check"
HEALTH=$(curl -sf "http://127.0.0.1:$HTTP_PORT/health_check") || fail "/health_check request failed"
PK=$(echo "$HEALTH" | jq -r '.pk')
ADDR=$(echo "$HEALTH" | jq -r '.address')

[[ "$PK" =~ ^[0-9a-f]{64}$ ]] || fail "pk is not 64-char hex: $PK"
[[ "$ADDR" =~ ^0x[0-9a-f]{64}$ ]] || fail "address is not 0x-prefixed 64-char hex: $ADDR"
pass "/health_check returns valid pk=$PK address=$ADDR"

# --- Test: get_attestation ---
echo "[smoke] testing /get_attestation"
ATTEST=$(curl -sf "http://127.0.0.1:$HTTP_PORT/get_attestation") || fail "/get_attestation request failed"
ATTEST_DOC=$(echo "$ATTEST" | jq -r '.attestation')

[[ "$ATTEST_DOC" != "null" ]] || fail "attestation document is null"
[[ ${#ATTEST_DOC} -gt 100 ]] || fail "attestation document suspiciously short: ${#ATTEST_DOC} chars"
pass "/get_attestation returns document (${#ATTEST_DOC} hex chars)"

# --- Test: root ---
echo "[smoke] testing /"
ROOT=$(curl -sf "http://127.0.0.1:$HTTP_PORT/") || fail "/ request failed"
[[ "$ROOT" == "Pong!" ]] || fail "/ returned unexpected body: $ROOT"
pass "/ returns Pong!"

# --- Test: 404 ---
echo "[smoke] testing 404"
STATUS=$(curl -sf -o /dev/null -w '%{http_code}' "http://127.0.0.1:$HTTP_PORT/nonexistent" || true)
[[ "$STATUS" == "404" ]] || fail "expected 404, got $STATUS"
pass "unknown route returns 404"

# --- Test: consistent keys ---
echo "[smoke] testing key consistency"
HEALTH2=$(curl -sf "http://127.0.0.1:$HTTP_PORT/health_check") || fail "second /health_check failed"
PK2=$(echo "$HEALTH2" | jq -r '.pk')
[[ "$PK" == "$PK2" ]] || fail "pk changed between requests: $PK vs $PK2"
pass "keys are consistent across requests"

echo ""
echo "[smoke] all tests passed"
