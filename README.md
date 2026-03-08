# Nautilus-TS

A TypeScript framework for building applications inside [AWS Nitro Enclaves](https://aws.amazon.com/ec2/nitro/nitro-enclaves/) with first-class [Sui](https://sui.io) support.

Write your enclave business logic in TypeScript using Mysten's SDKs (`@mysten/sui`, `@mysten/seal`, etc.), and the framework handles all the enclave plumbing: VSOCK networking, NSM attestation, traffic forwarding, and key management.

## Architecture

```
┌──────────────────── Nitro Enclave ────────────────────┐
│                                                        │
│  ┌──────────────┐     ┌──────────────────────────┐    │
│  │ traffic-proxy│     │ nautilus-server           │    │
│  │ (Go)         │     │ (Bun compiled binary)     │    │
│  │              │     │  Your TS business logic   │    │
│  │ VSOCK:3000 ──┼─TCP─┤► Bun.serve() on :3000    │    │
│  │              │     │  @mysten/sui, @mysten/seal│    │
│  │ TCP:443 ◄────┼─────┤► fetch("https://...")     │    │
│  │  ↕ VSOCK     │     │                           │    │
│  └──────────────┘     │  NSM via persistent       │    │
│                       │  Rust nsm-proxy process   │    │
│                       └──────────────────────────┘    │
│                                                        │
└───────────────────── VSOCK boundary ──────────────────┘
         ↕                              ↕
┌──────── EC2 Host ─────────────────────────────────────┐
│  traffic-proxy host TCP:8080 ↔ VSOCK:3000 (inbound)  │
│  vsock-proxy VSOCK:8101 ↔ seal.mirai.cloud:443       │
│  vsock-proxy VSOCK:8103 ↔ walrus.space:443           │
│  vsock-proxy VSOCK:8104 ↔ fullnode.sui.io:443        │
└───────────────────────────────────────────────────────┘
```

### Components

**Bun compiled binary** (`nautilus-server`): Your TypeScript application compiled into a single ~55MB standalone binary via `bun build --compile`. Contains the Bun runtime, all npm dependencies, and your business logic. Runs as PID 1 target inside the enclave.

**Go traffic proxy** (`tools/traffic-proxy`): A small static binary that handles all TCP↔VSOCK bridging. In enclave mode it is spawned as a child process by the Bun binary at boot; in host mode the same binary bridges inbound TCP into enclave VSOCK. It manages:

- **Inbound bridge**: VSOCK:3000 → TCP:127.0.0.1:3000 (HTTP requests from the host reach your Bun server)
- **Outbound proxies**: TCP:127.0.0.x:443 → VSOCK:parent:port (your `fetch()` calls reach external services)
- **/etc/hosts**: Maps endpoint hostnames to loopback addresses so `fetch("https://fullnode.testnet.sui.io")` resolves correctly

**Rust NSM proxy** (`nsm-proxy`): A tiny companion process that owns `/dev/nsm` access and exposes attestation and hardware RNG over a line-based stdin/stdout protocol. TypeScript keeps one persistent proxy process for the enclave lifetime, avoiding raw native pointer ownership in the Bun runtime.

## Why TypeScript Instead of Pure Rust?

The [official Mysten Nautilus implementation](https://github.com/MystenLabs/nautilus) is written entirely in Rust. We chose a TypeScript-first approach for different reasons:

**SDK access**: Mysten's TypeScript SDKs (`@mysten/sui`, `@mysten/seal`, `@mysten/bcs`) are designed for building user-facing applications quickly. The Rust SDKs are actively maintained and complete, but implemented as lower-level building blocks — Seal decryption flows, PTB construction helpers, and BCS encoding are more ergonomic in TypeScript. With Bun, you import the same libraries you use in your frontend/backend.

**Selective native code**: Native code is used only where it's genuinely better:

- **NSM attestation** requires ioctl on `/dev/nsm` — a tiny Rust proxy process keeps that boundary outside the Bun runtime
- **Traffic proxying** requires socket bridging across TCP and VSOCK — a small Go binary handles both host and enclave proxying paths

## Why a Custom Traffic Proxy?

AWS's Nitro Enclave documentation and Mysten's official implementation both use [traffic_forwarder.py](https://github.com/MystenLabs/nautilus/blob/main/src/nautilus-server/traffic_forwarder.py), a Python script that:

- Spawns threads for each connection direction
- Uses blocking `recv(1024)` in a loop
- Requires the Python runtime inside the enclave (~40MB)

We replaced it with a small native binary for several reasons:

**No Python in the enclave**: Adding Python to a minimal enclave image adds ~40MB, increases the attack surface, and makes reproducible builds harder. Our traffic proxy is a single static musl binary (~2MB).

**Proper stream handling**: Python threads with blocking `recv()` work but are not optimal. Our proxy uses full-duplex stream copying with proper half-close handling so larger responses and sequential requests do not wedge the bridge.

**Single process model**: The Python forwarder runs as a separate script with its own lifecycle. Ours is spawned by the Bun process and monitored — if it crashes, the enclave shuts down cleanly instead of silently losing network connectivity.

**Template quality**: This is meant to be a starting template. Including a Python script alongside TypeScript and native binaries sends the wrong signal about the architecture. Each component in the enclave should earn its place.

## VSOCK and Native Boundaries

Nitro Enclaves have no network interface. The only communication channel is [VSOCK](https://man7.org/linux/man-pages/man7/vsock.7.html) — a socket address family (`AF_VSOCK = 40`) for hypervisor-guest communication.

**Boot config** (one-shot): At startup, the Bun binary spawns `traffic-proxy config recv 7777`, which listens on VSOCK port 7777 for a one-shot JSON configuration blob from the host. No FFI or raw socket code in TypeScript — the Go binary handles the VSOCK layer.

**Traffic proxying** (persistent): All ongoing VSOCK I/O is handled by the Go traffic proxy. The Bun process only deals with standard TCP sockets — `Bun.serve()` listens on `127.0.0.1:3000`, and `fetch()` calls resolve to loopback addresses that the proxy bridges to VSOCK.

**NSM attestation**: The `/dev/nsm` device requires an ioctl interface. A minimal Rust proxy binary (`nsm-proxy`) wraps the [aws-nitro-enclaves-nsm-api](https://github.com/aws/aws-nitro-enclaves-nsm-api) crate and stays alive for the enclave lifetime. TypeScript sends requests over stdin/stdout and receives attestation documents or hardware RNG bytes back as plain hex payloads.

## Quick Start

```bash
# Install dependencies
bun install

# Local development (no enclave)
bun run dev

# Build EIF (requires Docker)
make

# Deploy to EC2 with Nitro Enclaves
scp out/nitro.eif ec2-user@<host>:~/nautilus-ts/out/
ssh ec2-user@<host> "cd nautilus-ts && scripts/deploy.sh"
```

## Project Structure

```
src/
  server.ts          # Your application entry point
  nautilus.ts        # Framework: boot, routing, HTTP server
  core/
    config.ts        # Boot config via traffic-proxy VSOCK:7777
    network.ts       # Loopback interface setup
    crypto.ts        # Ed25519 signing, hashing (@noble libraries)
  nsm/
    index.ts         # Persistent client for the Rust nsm-proxy process
tools/
  nsm-proxy/         # Rust proxy for /dev/nsm attestation and RNG
  traffic-proxy/     # Go binary for host/enclave TCP↔VSOCK bridging
scripts/
  deploy.sh          # EC2 deployment script
  systemd/           # systemd units for host services
Containerfile        # Multi-stage EIF build (StageX + Bun + Rust + Go)
```

## Configuration

The enclave receives configuration at boot via VSOCK port 7777:

```json
{
  "endpoints": [
    { "host": "fullnode.testnet.sui.io", "vsock_port": 8104 },
    { "host": "open.key-server.testnet.seal.mirai.cloud", "vsock_port": 8101 }
  ],
  "app": {
    "sui_network": "testnet",
    "custom_key": "custom_value"
  }
}
```

- `endpoints`: External services the enclave needs to reach. Each gets a VSOCK-forwarded loopback address.
- `app`: Arbitrary application config, available via `ctx.config.app` in your route handlers.
- `secrets`: Key-value pairs available via `ctx.config.secrets` in route handlers.

## Writing Routes

```ts
import { Nautilus } from "./nautilus.ts";

const app = new Nautilus();

app.post("/process", async (req, ctx) => {
  const body = await req.json();

  // Use Mysten SDKs normally
  const tx = new Transaction();
  // ...

  // Sign with ephemeral enclave keypair
  const signature = ctx.sign(someData);

  return Response.json({
    result: "processed",
    signature: ctx.toHex(signature),
    public_key: ctx.publicKey,
  });
});

app.start();
```

The `ctx` object provides:

- `ctx.sign(bytes)` — Ed25519 signature with ephemeral keypair
- `ctx.publicKey` / `ctx.address` — Hex-encoded public key and Sui address
- `ctx.config` — Boot configuration
- `ctx.attest()` — NSM attestation document (enclave only)
- `ctx.toHex()` / `ctx.fromHex()` / `ctx.blake2b256()` / `ctx.sha256()` — Crypto utilities

## FAQ

### How does the enclave access the NSM for attestation?

The NSM (Nitro Secure Module) is accessed via ioctl on `/dev/nsm`. Since JavaScript can't do ioctl directly, we ship a tiny Rust proxy process (`nsm-proxy`) that wraps the `aws-nitro-enclaves-nsm-api` crate. The Bun process keeps that proxy alive and sends it attestation/RNG requests over stdin/stdout, so no raw native pointers cross into the JS runtime.

### Does the TypeScript code know it's inside an enclave?

Mostly no, by design. Your `fetch("https://fullnode.testnet.sui.io/...")` calls resolve normally — `/etc/hosts` maps hostnames to loopback addresses, and the traffic proxy bridges those to VSOCK transparently. The only enclave-aware code is the boot sequence and the `ctx.attest()` call. Your business logic reads like a normal TypeScript server.

### Should I assume the EC2 host is malicious?

Yes. The host controls the network, can inspect or modify unencrypted traffic, and sends the boot configuration. This is exactly why enclaves exist — the attestation document cryptographically proves what code is running and binds your ephemeral public key to that measurement. Design your protocol so that all trust flows from the attestation, not from the host.

### How does the enclave handle TLS certificates?

Trusted CA certificates from StageX's `core-ca-certificates` package are baked into the EIF image at build time. The environment variables `SSL_CERT_FILE` and `SSL_CERT_DIR` point to these embedded certs. Since they're part of the measured image (reflected in PCR values), the host cannot replace or tamper with them. All outbound HTTPS connections verify against these embedded roots.

### Can the host tamper with inbound HTTP requests to the enclave?

Yes — inbound traffic from the host to the enclave's HTTP server is unencrypted (it travels over VSOCK, which is a local hypervisor channel, not a network). This is by design and matches Mysten's official implementation. The security model relies on the enclave **signing its responses** with its attestation-bound keypair. The on-chain Move contract verifies that signature, so it doesn't matter if the host tampers with requests — only correctly signed enclave outputs are accepted on-chain.

### How is the ephemeral keypair generated? Is it secure?

The keypair is generated at boot by mixing two independent entropy sources: `crypto.getRandomValues()` (kernel PRNG) and the NSM hardware RNG (`/dev/nsm`). These are XORed together, so both sources must be compromised to predict the key. In dev mode (no NSM), only the kernel PRNG is used. The keypair is ephemeral — it lives only in enclave memory and is destroyed when the enclave terminates.

### Are builds reproducible? Will PCR values be the same?

Yes, given identical source code and lockfiles. All Docker base images are pinned by SHA256 digest, Cargo.lock and bun.lock are committed, `cargo build --locked` and `bun install --frozen-lockfile` are enforced, file timestamps are zeroed, and cpio archives are built with deterministic ordering. Run `bun scripts/check-reproducibility.ts` to verify that nothing has drifted. The same source should produce the same PCR0/PCR1/PCR2 measurements on any machine.

### What are the PCR values and how do I verify them?

PCR0 measures the enclave image (your code + all dependencies). PCR1 measures the kernel. PCR2 measures the application. After building (`make`), the measurements are written to `out/nitro.pcrs`. Anyone can clone the repo, run `make`, and compare their PCR values against yours. If they match, the enclave is running the published source code.

### Can I add more external endpoints?

Yes. Add entries to the `endpoints` array in your boot config and set up corresponding `vsock-proxy` instances on the host. Each endpoint gets a unique loopback IP (`127.0.0.64`, `127.0.0.65`, etc.) and an entry in `/etc/hosts`. Your code just calls `fetch("https://your-service.com/...")` as usual.

### Why Bun instead of Node.js?

Bun compiles TypeScript into a single standalone binary via `bun build --compile`. This binary includes the runtime, all npm dependencies, and your code — no `node_modules` directory, no package manager, no interpreter needed inside the enclave. There is no `bun:ffi` usage — all native boundaries (VSOCK, NSM) are handled by companion binaries (`traffic-proxy`, `nsm-proxy`) that the Bun process spawns and communicates with over stdin/stdout or TCP.

### Why not just use the official Mysten Nautilus (Rust)?

You can and should if Rust is your preference. This template exists for teams that want to write their enclave business logic in TypeScript using Mysten's TypeScript SDKs. The trade-off is a slightly larger image (Bun runtime + Rust components vs pure Rust) in exchange for faster iteration and access to the TypeScript ecosystem.

### What happens if the traffic proxy crashes?

The Bun process monitors the traffic proxy as a child process. If it exits, Bun logs the error and calls `process.exit(1)`, which terminates the enclave. This is intentional — silently losing network connectivity is worse than a clean restart.

### Can I use this without Sui?

Yes. The framework provides generic enclave utilities (attestation, signing, hashing, encrypted config). The Sui-specific parts (`@mysten/sui`, `suiAddress()`) are optional — remove them from `package.json` and `crypto.ts` if you don't need them.

### How do I pass secrets to the enclave?

Include a `secrets` object in the boot config sent via VSOCK:7777. These are available to route handlers via `ctx.config.secrets`. They are not injected into `process.env`. Note that the boot config is sent by the host, so secrets are only as secure as your trust model. For highly sensitive material, consider using Seal encryption with the enclave's attestation-bound identity.

### Why not use socat for the host-side bridge?

[Mysten's official Nautilus](https://github.com/MystenLabs/nautilus/blob/main/expose_enclave.sh) and most Nitro Enclave tutorials use `socat TCP-LISTEN:port,fork VSOCK-CONNECT:cid:port` on the parent EC2 to bridge inbound HTTP traffic. socat's `fork` mode creates a new process and VSOCK connection for every incoming TCP connection, and under rapid sequential connections the VSOCK socket can race, causing `Transport endpoint is not connected` errors.

We ship a dedicated host mode in the `traffic-proxy` binary (`tools/traffic-proxy/`) that replaces socat for inbound traffic. The Linux VSOCK subsystem itself can transiently timeout under rapid sequential connections regardless of the client — socat surfaces these as client-visible errors, while `traffic-proxy host` absorbs them with a transparent connect retry loop. Usage: `traffic-proxy host <listen-port> <enclave-cid> <vsock-port>`.

### Is the native traffic proxy necessary? Can I use Python's traffic_forwarder.py?

You can, but we don't recommend it. The Python forwarder adds ~40MB to the image, uses blocking threads, and requires the Python runtime. Our native traffic proxy is a small static binary with proper bidirectional stream handling. It also means one fewer language runtime in your attack surface.

### How does this compare to Mysten's Nautilus for reproducibility?

Both implementations use the same StageX-based reproducible build pipeline: SHA256-pinned images, deterministic cpio (zeroed timestamps, sorted entries, `--reproducible` flag), `eif_build` for the final EIF, and `--provenance=false` in Docker. This template additionally includes an automated reproducibility verification script and CI workflow.

### Why generate a new keypair on every boot instead of loading one?

This is fundamental to the enclave security model. The attestation document binds the public key to the enclave's PCR measurements, proving "this key was generated inside code with these exact measurements." If you loaded a key from the host (e.g., `.env` or config), the host would know the private key, and the attestation would prove nothing — the host could sign anything. Ephemeral keys generated inside the enclave's isolated memory are the only kind that the attestation can meaningfully vouch for. The trade-off is that the enclave's Sui address changes on every reboot and must be re-approved on-chain.

### Can I run this locally for development?

Yes. `bun run dev` starts the server in dev mode — no enclave, no VSOCK, no NSM. It reads config from a local file (or uses defaults), generates a keypair from the kernel PRNG, and listens on `localhost:3000`. The `ctx.attest()` call returns `null` in dev mode.

## Testing

135 tests across TypeScript, Go, and Rust cover every security boundary and functional path. Run all tests with:

```bash
bun test                                                    # TypeScript (110 tests)
go test -v ./... -C tools/traffic-proxy                     # Go (9 tests)
cargo test --locked --manifest-path tools/nsm-proxy/Cargo.toml  # Rust (16 tests)
```

### TypeScript — Config Validation (`tests/config.test.ts`)

- **Default config** — `devBootConfig()` returns sensible defaults (empty endpoints, debug log level).
- **File config loading** — Reads and parses config from a JSON file with endpoints, secrets, and app data.
- **Invalid JSON rejection** — Throws on malformed JSON input.
- **Nonexistent file** — Throws when config file doesn't exist.
- **LOG_LEVEL env var** — Respects the `LOG_LEVEL` environment variable for dev mode defaults.
- **Minimal config** — Accepts `{"endpoints": []}` with all optional fields undefined.
- **Multiple endpoints** — Parses configs with multiple endpoint entries.
- **Full config acceptance** — Validates a complete config with endpoints, secrets, log_level, and app.
- **Top-level shape rejection** — Rejects null, arrays, and strings at the top level.
- **Missing endpoints** — Rejects configs without an `endpoints` field.
- **Endpoint host validation** — Rejects empty hosts, oversized hosts (>253 chars), and hosts with whitespace, newlines, tabs, slashes, or colons (prevents `/etc/hosts` injection).
- **Port boundary validation** — Rejects port 0, negative ports, ports > 65535, non-integer ports, and NaN.
- **Endpoint type checking** — Rejects non-object endpoint entries.
- **Secrets type checking** — Rejects non-object secrets, array secrets, and non-string secret values.
- **log_level type checking** — Rejects non-string log_level values.
- **App type checking** — Rejects non-object and array app values.
- **Secrets isolation** — Verifies that config secrets are NOT injected into `process.env` (prevents host from overwriting internal env vars like `NSM_PROXY_PATH`).

### TypeScript — Cryptography (`tests/crypto.test.ts`)

- **Keypair generation** — Returns 32-byte private and public keys, generates unique keypairs, 100 keypairs without collision.
- **NSM entropy mixing** — Produces valid keypairs when mixed with hardware entropy via XOR, falls back gracefully when entropy is too short.
- **Sign and verify** — Signs messages and verifies correctly, fails with wrong public key, wrong message, or tampered signature.
- **Empty and large messages** — Signs empty messages and 1MB messages correctly.
- **Deterministic signatures** — Same keypair and message always produce the same signature.
- **Sui address derivation** — Returns `0x`-prefixed 64-char hex, is deterministic, differs across keys, matches `blake2b256(0x00 || pubkey)` algorithm.
- **Sui SDK cross-validation** — Addresses pass `isValidSuiAddress()` from `@mysten/sui` SDK, verified across 100 generated keypairs.
- **Hex encoding** — Roundtrips arbitrary bytes, handles empty input, strips `0x` prefix, produces lowercase, rejects odd-length and invalid hex characters.
- **Hash test vectors** — blake2b256 and SHA-256 match known test vectors (empty input, "abc").

### TypeScript — HTTP Framework (`tests/nautilus.test.ts`)

- **Built-in routes** — `GET /` returns "Pong!", `GET /health_check` returns valid pk and address, `GET /get_attestation` returns 503 outside enclave.
- **Key consistency** — Multiple health_check requests return the same pk and address.
- **Custom routes** — GET and POST handlers receive context with crypto utilities, JSON echo preserves body.
- **Signing endpoint** — POST `/sign` produces deterministic 64-byte signatures with valid hashes.
- **Error handling** — Unknown routes return 404, wrong HTTP method returns 404, throwing routes return 500.
- **Body size limits** — Rejects requests exceeding `maxBodySize` with 413, accepts requests within the limit.
- **Address derivation integrity** — Health check address matches Sui derivation from the returned public key.
- **Signature verification** — Signatures from the server verify against the returned public key; forgery (wrong message or tampered signature) fails.
- **Private key non-exposure** — Route handler context does not leak the private key in JSON responses.
- **Error suppression in enclave mode** — Exceptions return generic "internal error" (not the actual message) when running as enclave; dev mode exposes the real message.
- **Concurrent requests** — 50 concurrent health checks return consistent results; mixed concurrent GET/POST requests resolve correctly without interference.
- **Path normalization** — Trailing slashes return 404 (exact match), query strings don't affect routing, double slashes are normalized by the URL parser.

### TypeScript — NSM Proxy Client (`tests/nsm.test.ts`)

- **Enclave detection** — `isEnclave()` returns false outside a Nitro Enclave.
- **Graceful fallback** — `getAttestation()` and `getHardwareRandom()` return null outside enclave.
- **ATT protocol round-trip** — Sends a public key to the mock proxy, receives it back as the attestation document.
- **RND protocol** — Requests random bytes from the mock proxy.
- **Concurrent multiplexing** — 15 concurrent requests (10 ATT + 5 RND) all resolve to the correct response using ID-based tracking.
- **Pending request rejection** — All pending requests are rejected when the proxy process exits unexpectedly.
- **Post-exit rejection** — Requests after proxy exit throw "not running" immediately.
- **ERR response handling** — Proxy ERR responses correctly reject the corresponding promise with the error message.
- **Large attestation documents** — Handles 4KB attestation documents (realistic production size) without truncation.

### Go — Traffic Proxy (`tools/traffic-proxy/main_test.go`)

- **Config JSON parsing** — Parses valid JSON with endpoints, http_vsock_port, and http_tcp_port.
- **Empty endpoints** — Handles configs with zero endpoints.
- **Missing fields** — Missing JSON fields default to zero values.
- **Invalid JSON** — Rejects malformed JSON input.
- **Loopback IP generation** — All 191 possible endpoint IPs (127.0.0.64–127.0.0.254) are valid; 192nd overflows.
- **Hosts file content** — Generated `/etc/hosts` contains localhost and all endpoint entries with correct IPs.
- **Hosts file injection prevention** — Each line has exactly two fields (IP and hostname), no extra content.
- **Bidirectional copy** — Data flows correctly in both directions through the bridge with proper half-close handling.
- **Max endpoint limit** — Verifies the IP address space boundary at 191 endpoints.

### Rust — NSM Proxy (`tools/nsm-proxy/src/main.rs`)

- **Hex codec** — Rejects odd-length input, rejects invalid characters, round-trips encoding/decoding.
- **ATT request** — Processes attestation requests and returns hex-encoded documents.
- **RND request** — Processes random requests and returns hex-encoded bytes.
- **Unknown method** — Returns ERR for unrecognized methods.
- **Invalid hex payload** — Returns ERR for non-hex attestation payloads.
- **Empty and whitespace lines** — Returns appropriate ERR responses.
- **ID-only requests** — Returns ERR when no method is specified.
- **Missing ATT payload** — Returns ERR when ATT is sent without a public key.
- **Odd-length hex** — Returns ERR for odd-length hex in ATT payload.
- **Wrong key length** — Validates that public keys must be exactly 32 bytes; rejects 16-byte and 64-byte keys (using StrictFakeBackend that mirrors NitroBackend validation).
- **Correct key length** — Accepts 32-byte public keys and returns the attestation document.

### End-to-End — Enclave Smoke Test (`scripts/enclave-smoke-test.sh`)

Runs on a real Nitro Enclave (EC2 with `c5.xlarge` or larger):

- **Health check** — Verifies `GET /health_check` returns valid pk (64-char hex) and address (0x-prefixed 64-char hex).
- **Attestation** — Verifies `GET /get_attestation` returns a non-null attestation document > 100 hex chars.
- **Root route** — Verifies `GET /` returns "Pong!".
- **404 handling** — Verifies unknown routes return HTTP 404.
- **Key consistency** — Verifies the public key is identical across multiple requests (ephemeral key persists for enclave lifetime).

### CI Pipeline (`.github/workflows/test.yml`)

On every push to `main` and every pull request:

1. **TypeScript** — `bun test` + reproducibility check
2. **Rust** — `cargo test --locked`
3. **Go** — `go test -v ./...`
4. **EIF build** — `make` (full Docker build of the enclave image)
5. **Smoke test** (main only) — Launches a spot EC2 instance, deploys the EIF, and runs the full enclave smoke test

## Disclaimer

This framework is provided as-is and has not been audited. We are not responsible for any issues arising from its use. Use at your own risk.

Contributions and comments are welcome — please open an issue or pull request.
