/**
 * NSM (Nitro Secure Module) attestation via Rust FFI.
 *
 * The NSM is accessed via ioctl on /dev/nsm, which requires native code.
 * We compile a minimal Rust shared library that exposes exactly two functions:
 *   - nsm_get_attestation(public_key) → attestation document (CBOR/COSE)
 *   - nsm_get_random() → 256 random bytes from the NSM hardware RNG
 *
 * Ed25519 signing is done in TypeScript via @noble/ed25519 — no Rust needed.
 */

import { dlopen, FFIType, ptr, toBuffer } from "bun:ffi";
import { existsSync } from "fs";

interface NsmLib {
  nsm_get_attestation: (
    pkPtr: number,
    pkLen: number,
    outLenPtr: number,
  ) => number;
  nsm_get_random: (outPtr: number) => number;
  nsm_free: (ptr: number, len: number) => void;
}

let lib: ReturnType<typeof dlopen> | null = null;

function getLib() {
  if (lib) return lib;

  const candidates = [
    process.env.NSM_LIB_PATH,
    "/lib/libnsm_ffi.so",
    "./target/x86_64-unknown-linux-musl/release/libnsm_ffi.so",
    "./target/release/libnsm_ffi.so",
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (existsSync(path)) {
      lib = dlopen(path, {
        nsm_get_attestation: {
          returns: FFIType.ptr,
          args: [FFIType.ptr, FFIType.u32, FFIType.ptr],
        },
        nsm_get_random: {
          returns: FFIType.i32,
          args: [FFIType.ptr],
        },
        nsm_free: {
          returns: FFIType.void,
          args: [FFIType.ptr, FFIType.u32],
        },
      });
      return lib;
    }
  }

  return null;
}

/**
 * Request a Nitro Enclave attestation document bound to the given public key.
 * Returns the raw attestation document bytes (CBOR-encoded COSE_Sign1).
 * Returns null if not running inside a Nitro Enclave.
 */
export function getAttestation(publicKey: Uint8Array): Uint8Array | null {
  const l = getLib();
  if (!l) return null;

  const pkBuf = Buffer.from(publicKey);
  const outLen = Buffer.alloc(4);

  const resultPtr = l.symbols.nsm_get_attestation(
    ptr(pkBuf),
    pkBuf.length,
    ptr(outLen),
  ) as number;

  if (resultPtr === 0) return null;

  const len = outLen.readUInt32LE(0);
  const result = new Uint8Array(toBuffer(resultPtr, 0, len));
  l.symbols.nsm_free(resultPtr, len);

  return result;
}

/**
 * Get 256 bytes of random data from the NSM hardware RNG.
 * Returns null if not running inside a Nitro Enclave.
 */
export function getHardwareRandom(): Uint8Array | null {
  const l = getLib();
  if (!l) return null;

  const buf = Buffer.alloc(256);
  const rc = l.symbols.nsm_get_random(ptr(buf)) as number;
  if (rc !== 0) return null;
  return new Uint8Array(buf);
}

/**
 * Check if NSM is available (i.e., running inside a Nitro Enclave).
 */
export function isEnclave(): boolean {
  try {
    return existsSync("/dev/nsm");
  } catch {
    return false;
  }
}
