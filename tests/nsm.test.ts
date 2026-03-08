/**
 * Tests for NSM module.
 *
 * We can't test actual NSM attestation (requires /dev/nsm in a Nitro Enclave),
 * but we can test the detection logic, graceful fallback behavior, and the
 * NsmProxyClient protocol over a mock proxy subprocess.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { isEnclave, getAttestation, getHardwareRandom, NsmProxyClient } from "../src/nsm/index.ts";
import { toHex, fromHex } from "../src/core/crypto.ts";
import { resolve } from "path";

const MOCK_PROXY = resolve(import.meta.dir, "fixtures/mock-nsm-proxy.ts");

describe("isEnclave", () => {
  test("returns false outside enclave", () => {
    // We're running on macOS/Linux dev machine, not inside an enclave
    expect(isEnclave()).toBe(false);
  });

  test("returns a boolean", () => {
    expect(typeof isEnclave()).toBe("boolean");
  });
});

describe("getAttestation", () => {
  test("returns null outside enclave", async () => {
    const kp = new Uint8Array(32);
    crypto.getRandomValues(kp);
    expect(await getAttestation(kp)).toBeNull();
  });
});

describe("getHardwareRandom", () => {
  test("returns null outside enclave", async () => {
    expect(await getHardwareRandom()).toBeNull();
  });
});

describe("NsmProxyClient", () => {
  let client: NsmProxyClient;

  afterEach(() => {
    client?.stop();
  });

  test("getAttestation round-trips public key through proxy", async () => {
    client = new NsmProxyClient("bun", [MOCK_PROXY]);
    const publicKey = new Uint8Array(32);
    crypto.getRandomValues(publicKey);

    const result = await client.getAttestation(publicKey);
    // Mock echoes the public key back as the "attestation document"
    expect(toHex(result)).toBe(toHex(publicKey));
  });

  test("getRandom returns bytes from proxy", async () => {
    client = new NsmProxyClient("bun", [MOCK_PROXY]);
    const result = await client.getRandom();

    expect(toHex(result)).toBe("deadbeefcafebabe0123456789abcdef");
  });

  test("multiplexed concurrent requests resolve correctly", async () => {
    client = new NsmProxyClient("bun", [MOCK_PROXY]);

    const keys = Array.from({ length: 10 }, () => {
      const k = new Uint8Array(32);
      crypto.getRandomValues(k);
      return k;
    });

    const results = await Promise.all([
      ...keys.map((k) => client.getAttestation(k)),
      ...Array.from({ length: 5 }, () => client.getRandom()),
    ]);

    // First 10: attestation results should match input keys
    for (let i = 0; i < 10; i++) {
      expect(toHex(results[i])).toBe(toHex(keys[i]));
    }
    // Last 5: random results should all be the mock constant
    for (let i = 10; i < 15; i++) {
      expect(toHex(results[i])).toBe("deadbeefcafebabe0123456789abcdef");
    }
  });

  test("rejects pending requests when proxy exits", async () => {
    // Use a proxy that reads stdin but never responds, so the request stays pending
    client = new NsmProxyClient("bun", ["-e", "await Bun.sleep(999999)"]);

    const promise = client.getAttestation(new Uint8Array(32));
    await Bun.sleep(10);
    client.stop();

    expect(promise).rejects.toThrow();
  });

  test("rejects requests after proxy has exited", async () => {
    client = new NsmProxyClient("bun", [MOCK_PROXY]);
    client.stop();
    // Small delay for the exit handler to fire
    await Bun.sleep(10);

    expect(client.getAttestation(new Uint8Array(32))).rejects.toThrow("not running");
  });
});
