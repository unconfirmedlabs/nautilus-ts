---
description: Nautilus TypeScript enclave framework - uses Bun, not Node.js.
globs: "*.ts, *.tsx, *.js, package.json, Containerfile, Makefile"
alwaysApply: true
---

Use Bun instead of Node.js. No `bun:ffi` — native boundaries use companion binaries (`traffic-proxy`, `nsm-proxy`).

## Architecture

- `src/core/` — Platform layer (VSOCK, networking, crypto, config)
- `src/nsm/` — NSM attestation via persistent Rust proxy process
- `src/nautilus.ts` — Framework class with route registration
- `src/server.ts` — Application entry point (user code)
- `tools/nsm-proxy/` — Rust binary for NSM /dev/nsm attestation and RNG
- `tools/traffic-proxy/` — Go binary for TCP↔VSOCK bridging and config delivery

## Key Decisions

- Ed25519 signing in TypeScript (@noble/ed25519), NOT Rust FFI
- Only NSM attestation requires Rust (ioctl on /dev/nsm)
- VSOCK via Go traffic-proxy binary (no socat/Python/FFI inside enclave)
- Config via VSOCK:7777 at boot (dynamic, not baked into image)
- `bun build --compile` for single-binary output
- `nit.target=/nautilus-server` — Bun binary runs directly as init target
- `Bun.serve()` for HTTP — no Express, no Elysia

## Build

```sh
make              # builds EIF via Docker
bun run dev       # local dev mode with hot reload
```
