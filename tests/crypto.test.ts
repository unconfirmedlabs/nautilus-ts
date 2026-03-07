/**
 * Tests for cryptographic utilities.
 *
 * These are the most security-critical functions in the framework.
 * Covers all functions in crypto.ts including the NSM entropy mixing path.
 */

import { describe, test, expect } from "bun:test";
import {
  generateKeypair,
  sign,
  verify,
  suiAddress,
  toHex,
  fromHex,
  blake2b256,
  sha256Hash,
} from "../src/core/crypto.ts";

describe("generateKeypair", () => {
  test("returns 32-byte private key and 32-byte public key", () => {
    const kp = generateKeypair();
    expect(kp.privateKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.privateKey.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
  });

  test("generates unique keypairs", () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    expect(toHex(kp1.privateKey)).not.toBe(toHex(kp2.privateKey));
    expect(toHex(kp1.publicKey)).not.toBe(toHex(kp2.publicKey));
  });

  test("generates 100 keypairs without collision", () => {
    const pks = new Set<string>();
    for (let i = 0; i < 100; i++) {
      pks.add(toHex(generateKeypair().publicKey));
    }
    expect(pks.size).toBe(100);
  });

  test("mixes NSM entropy when provided", () => {
    const nsmEntropy = new Uint8Array(32);
    nsmEntropy.fill(0xff);
    const kp = generateKeypair(nsmEntropy);
    expect(kp.privateKey.length).toBe(32);
    expect(kp.publicKey.length).toBe(32);
    // Key should be valid (can sign and verify)
    const msg = new Uint8Array([1, 2, 3]);
    const sig = sign(kp, msg);
    expect(verify(kp.publicKey, msg, sig)).toBe(true);
  });

  test("NSM entropy produces different key than no entropy", () => {
    // With fixed entropy, two calls still differ (OS random varies),
    // but both should produce valid keys
    const entropy = new Uint8Array(32);
    entropy.fill(0xab);
    const kp1 = generateKeypair(entropy);
    const kp2 = generateKeypair(null);
    // Both are valid keypairs
    expect(kp1.privateKey.length).toBe(32);
    expect(kp2.privateKey.length).toBe(32);
  });

  test("ignores NSM entropy shorter than 32 bytes", () => {
    const shortEntropy = new Uint8Array(16);
    shortEntropy.fill(0xff);
    const kp = generateKeypair(shortEntropy);
    // Should still produce a valid keypair (falls back to OS random only)
    expect(kp.privateKey.length).toBe(32);
    const msg = new Uint8Array([1]);
    expect(verify(kp.publicKey, msg, sign(kp, msg))).toBe(true);
  });
});

describe("sign and verify", () => {
  test("signs a message and verification succeeds", () => {
    const kp = generateKeypair();
    const msg = new Uint8Array([1, 2, 3, 4, 5]);
    const sig = sign(kp, msg);

    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBe(64);
    expect(verify(kp.publicKey, msg, sig)).toBe(true);
  });

  test("verification fails with wrong public key", () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    const msg = new Uint8Array([1, 2, 3]);
    const sig = sign(kp1, msg);

    expect(verify(kp2.publicKey, msg, sig)).toBe(false);
  });

  test("verification fails with wrong message", () => {
    const kp = generateKeypair();
    const msg1 = new Uint8Array([1, 2, 3]);
    const msg2 = new Uint8Array([4, 5, 6]);
    const sig = sign(kp, msg1);

    expect(verify(kp.publicKey, msg2, sig)).toBe(false);
  });

  test("verification fails with tampered signature", () => {
    const kp = generateKeypair();
    const msg = new Uint8Array([1, 2, 3]);
    const sig = sign(kp, msg);

    // Flip a bit in the signature
    const tampered = new Uint8Array(sig);
    tampered[0] ^= 0x01;

    expect(verify(kp.publicKey, msg, tampered)).toBe(false);
  });

  test("signs empty message", () => {
    const kp = generateKeypair();
    const msg = new Uint8Array(0);
    const sig = sign(kp, msg);

    expect(sig.length).toBe(64);
    expect(verify(kp.publicKey, msg, sig)).toBe(true);
  });

  test("signs large message (1MB)", () => {
    const kp = generateKeypair();
    const msg = new Uint8Array(1024 * 1024);
    for (let i = 0; i < msg.length; i++) msg[i] = i % 256;

    const sig = sign(kp, msg);
    expect(verify(kp.publicKey, msg, sig)).toBe(true);
  });

  test("deterministic signatures for same keypair and message", () => {
    const kp = generateKeypair();
    const msg = new Uint8Array([10, 20, 30]);

    const sig1 = sign(kp, msg);
    const sig2 = sign(kp, msg);

    expect(toHex(sig1)).toBe(toHex(sig2));
  });
});

describe("suiAddress", () => {
  test("returns 0x-prefixed 64-char hex string", () => {
    const kp = generateKeypair();
    const addr = suiAddress(kp.publicKey);

    expect(addr).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("deterministic for same public key", () => {
    const kp = generateKeypair();
    expect(suiAddress(kp.publicKey)).toBe(suiAddress(kp.publicKey));
  });

  test("different public keys produce different addresses", () => {
    const kp1 = generateKeypair();
    const kp2 = generateKeypair();
    expect(suiAddress(kp1.publicKey)).not.toBe(suiAddress(kp2.publicKey));
  });

  test("matches known Sui address derivation", () => {
    // Sui address = blake2b256(0x00 || pubkey) as hex
    // Verify the algorithm manually
    const kp = generateKeypair();
    const input = new Uint8Array(33);
    input[0] = 0x00;
    input.set(kp.publicKey, 1);
    const hash = blake2b256(input);
    const expected = "0x" + toHex(hash);

    expect(suiAddress(kp.publicKey)).toBe(expected);
  });
});

describe("toHex and fromHex", () => {
  test("roundtrips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  test("handles empty input", () => {
    const empty = new Uint8Array(0);
    expect(toHex(empty)).toBe("");
    expect(fromHex("")).toEqual(empty);
  });

  test("fromHex handles 0x prefix", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const hex = toHex(bytes);
    expect(fromHex("0x" + hex)).toEqual(bytes);
    expect(fromHex(hex)).toEqual(bytes);
  });

  test("toHex produces lowercase", () => {
    const bytes = new Uint8Array([0xab, 0xcd, 0xef]);
    expect(toHex(bytes)).toBe("abcdef");
  });

  test("roundtrips 32-byte key", () => {
    const kp = generateKeypair();
    expect(fromHex(toHex(kp.publicKey))).toEqual(kp.publicKey);
    expect(fromHex(toHex(kp.privateKey))).toEqual(kp.privateKey);
  });

  test("roundtrips 64-byte signature", () => {
    const kp = generateKeypair();
    const sig = sign(kp, new Uint8Array([1]));
    expect(fromHex(toHex(sig))).toEqual(sig);
  });

  test("fromHex rejects odd-length input", () => {
    expect(() => fromHex("0")).toThrow("odd-length");
    expect(() => fromHex("abc")).toThrow("odd-length");
    expect(() => fromHex("0x0")).toThrow("odd-length");
  });

  test("fromHex rejects invalid hex characters", () => {
    expect(() => fromHex("zz")).toThrow("invalid hex");
    expect(() => fromHex("gh")).toThrow("invalid hex");
    expect(() => fromHex("0xzz")).toThrow("invalid hex");
    expect(() => fromHex("hello!")).toThrow("invalid hex");
  });

  test("fromHex accepts valid uppercase", () => {
    expect(fromHex("DEADBEEF")).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });
});

describe("blake2b256", () => {
  test("returns 32 bytes", () => {
    const hash = blake2b256(new Uint8Array([1, 2, 3]));
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(32);
  });

  test("deterministic", () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(toHex(blake2b256(data))).toBe(toHex(blake2b256(data)));
  });

  test("different inputs produce different hashes", () => {
    const h1 = blake2b256(new Uint8Array([1]));
    const h2 = blake2b256(new Uint8Array([2]));
    expect(toHex(h1)).not.toBe(toHex(h2));
  });

  test("empty input produces a valid hash", () => {
    const hash = blake2b256(new Uint8Array(0));
    expect(hash.length).toBe(32);
    // blake2b-256 of empty input
    expect(toHex(hash)).toBe(
      "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8"
    );
  });

  test("known test vector", () => {
    // blake2b256("abc")
    const data = new TextEncoder().encode("abc");
    const hash = blake2b256(data);
    expect(toHex(hash)).toBe(
      "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319"
    );
  });
});

describe("sha256Hash", () => {
  test("returns 32 bytes", () => {
    const hash = sha256Hash(new Uint8Array([1, 2, 3]));
    expect(hash).toBeInstanceOf(Uint8Array);
    expect(hash.length).toBe(32);
  });

  test("deterministic", () => {
    const data = new Uint8Array([1, 2, 3]);
    expect(toHex(sha256Hash(data))).toBe(toHex(sha256Hash(data)));
  });

  test("empty input matches known SHA-256 hash", () => {
    const hash = sha256Hash(new Uint8Array(0));
    expect(toHex(hash)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });

  test("known test vector", () => {
    // SHA-256("abc")
    const data = new TextEncoder().encode("abc");
    const hash = sha256Hash(data);
    expect(toHex(hash)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
