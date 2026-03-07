/**
 * Integration tests for the Nautilus framework.
 *
 * Tests the HTTP server, built-in routes, custom routes, error handling,
 * and body size enforcement. Uses Bun.serve() in dev mode.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Nautilus } from "../src/nautilus.ts";

let baseUrl: string;
let app: Nautilus;

beforeAll(async () => {
  app = new Nautilus();
  app.setPort(0); // ephemeral port — avoids conflicts
  app.setMaxBodySize(1024); // 1KB limit for testing

  // Custom routes
  app.get("/echo", (req, ctx) => {
    return Response.json({ pk: ctx.publicKey, address: ctx.address });
  });

  app.post("/sign", async (req, ctx) => {
    const body = await req.arrayBuffer();
    const data = new Uint8Array(body);
    const sig = ctx.sign(ctx.blake2b256(data));
    return Response.json({
      hash: ctx.toHex(ctx.blake2b256(data)),
      signature: ctx.toHex(sig),
      public_key: ctx.publicKey,
    });
  });

  app.post("/json_echo", async (req, ctx) => {
    const body = await req.json();
    return Response.json({ received: body, inEnclave: ctx.inEnclave });
  });

  app.get("/throws", () => {
    throw new Error("intentional test error");
  });

  await app.start();
  baseUrl = `http://127.0.0.1:${app.listeningPort}`;
});

afterAll(() => {
  app?.stop();
});

describe("built-in routes", () => {
  test("GET / returns Pong!", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("Pong!");
  });

  test("GET /health_check returns pk and address", async () => {
    const res = await fetch(`${baseUrl}/health_check`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pk).toMatch(/^[0-9a-f]{64}$/);
    expect(data.address).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("GET /health_check returns consistent keys", async () => {
    const r1 = await (await fetch(`${baseUrl}/health_check`)).json();
    const r2 = await (await fetch(`${baseUrl}/health_check`)).json();
    expect(r1.pk).toBe(r2.pk);
    expect(r1.address).toBe(r2.address);
  });

  test("GET /get_attestation returns 503 outside enclave", async () => {
    const res = await fetch(`${baseUrl}/get_attestation`);
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error).toBe("not running in enclave");
  });
});

describe("custom routes", () => {
  test("GET /echo returns context data", async () => {
    const res = await fetch(`${baseUrl}/echo`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.pk).toMatch(/^[0-9a-f]{64}$/);
    expect(data.address).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("POST /sign signs data correctly", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const res = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      body: payload,
    });
    expect(res.status).toBe(200);
    const data = await res.json();

    expect(data.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.signature).toMatch(/^[0-9a-f]{128}$/);
    expect(data.public_key).toMatch(/^[0-9a-f]{64}$/);
  });

  test("POST /sign produces deterministic signatures", async () => {
    const payload = new Uint8Array([10, 20, 30]);
    const r1 = await (await fetch(`${baseUrl}/sign`, { method: "POST", body: payload })).json();
    const r2 = await (await fetch(`${baseUrl}/sign`, { method: "POST", body: payload })).json();

    expect(r1.signature).toBe(r2.signature);
    expect(r1.hash).toBe(r2.hash);
  });

  test("POST /json_echo echoes JSON body", async () => {
    const res = await fetch(`${baseUrl}/json_echo`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ test: true, value: 42 }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.received).toEqual({ test: true, value: 42 });
    expect(data.inEnclave).toBe(false);
  });
});

describe("error handling", () => {
  test("404 for unknown route", async () => {
    const res = await fetch(`${baseUrl}/nonexistent`);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toBe("not found");
  });

  test("404 for wrong method", async () => {
    const res = await fetch(`${baseUrl}/echo`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("500 for route that throws", async () => {
    const res = await fetch(`${baseUrl}/throws`);
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data.error).toBe("intentional test error");
  });
});

describe("body size limit", () => {
  test("rejects request body exceeding maxBodySize", async () => {
    const oversized = new Uint8Array(2048); // 2KB > 1KB limit
    const res = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      body: oversized,
    });
    // Bun returns 413 when maxRequestBodySize is exceeded
    expect(res.status).toBe(413);
  });

  test("accepts request body within maxBodySize", async () => {
    const ok = new Uint8Array(512); // 512B < 1KB limit
    const res = await fetch(`${baseUrl}/sign`, {
      method: "POST",
      body: ok,
    });
    expect(res.status).toBe(200);
  });
});

describe("security", () => {
  test("address derivation matches pk from health_check", async () => {
    const { pk, address } = await (await fetch(`${baseUrl}/health_check`)).json();

    // Verify address is derived from pk using the Sui algorithm
    const { suiAddress, fromHex } = await import("../src/core/crypto.ts");
    const pubkeyBytes = fromHex(pk);
    expect(suiAddress(pubkeyBytes)).toBe(address);
  });

  test("signatures are verifiable", async () => {
    const payload = new Uint8Array([99, 88, 77]);
    const { signature, hash, public_key } = await (await fetch(`${baseUrl}/sign`, {
      method: "POST",
      body: payload,
    })).json();

    const { verify, fromHex, blake2b256 } = await import("../src/core/crypto.ts");
    const pk = fromHex(public_key);
    const sig = fromHex(signature);
    const expectedHash = blake2b256(payload);

    expect(hash).toBe(Buffer.from(expectedHash).toString("hex"));
    expect(verify(pk, expectedHash, sig)).toBe(true);
  });

  test("signature cannot be forged", async () => {
    const { signature, public_key } = await (await fetch(`${baseUrl}/sign`, {
      method: "POST",
      body: new Uint8Array([1, 2, 3]),
    })).json();

    const { verify, fromHex, blake2b256 } = await import("../src/core/crypto.ts");
    const pk = fromHex(public_key);
    const sig = fromHex(signature);

    // Different message should fail verification
    const wrongHash = blake2b256(new Uint8Array([4, 5, 6]));
    expect(verify(pk, wrongHash, sig)).toBe(false);

    // Tampered signature should fail
    const tampered = new Uint8Array(sig);
    tampered[0] ^= 0x01;
    const correctHash = blake2b256(new Uint8Array([1, 2, 3]));
    expect(verify(pk, correctHash, tampered)).toBe(false);
  });

  test("ctx.keypair is not exposed to route handlers", async () => {
    // The /echo route uses ctx — verify it doesn't leak private key
    const res = await fetch(`${baseUrl}/echo`);
    const data = await res.json();
    // Only pk and address should be present, no privateKey
    expect(Object.keys(data).sort()).toEqual(["address", "pk"]);
  });
});
