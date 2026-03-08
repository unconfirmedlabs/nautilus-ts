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

  test("rejects on proxy ERR response", async () => {
    // The mock proxy responds with ERR for the "FAIL" method.
    // We need to send a raw FAIL request — use sendRequest indirectly.
    // Since the client only exposes ATT and RND, we test by sending
    // a request that the real proxy would reject (e.g., invalid hex).
    // Use a custom mock that always returns ERR.
    const errMock = resolve(import.meta.dir, "fixtures/mock-nsm-err.ts");
    await Bun.write(errMock, `
      const reader = Bun.stdin.stream().getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buffered.indexOf("\\n");
          if (nl === -1) break;
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (!line) continue;
          const id = line.split(" ")[0];
          process.stdout.write(id + " ERR simulated_failure\\n");
        }
      }
    `);
    client = new NsmProxyClient("bun", [errMock]);

    await expect(client.getAttestation(new Uint8Array(32))).rejects.toThrow("simulated_failure");
    await expect(client.getRandom()).rejects.toThrow("simulated_failure");
  });

  test("handles large attestation documents", async () => {
    // Production attestation docs are 3-5KB. Test with a mock that returns large hex.
    const largeMock = resolve(import.meta.dir, "fixtures/mock-nsm-large.ts");
    const largeHex = "ab".repeat(4096); // 4KB attestation doc
    await Bun.write(largeMock, `
      const reader = Bun.stdin.stream().getReader();
      const decoder = new TextDecoder();
      let buffered = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffered += decoder.decode(value, { stream: true });
        for (;;) {
          const nl = buffered.indexOf("\\n");
          if (nl === -1) break;
          const line = buffered.slice(0, nl).trim();
          buffered = buffered.slice(nl + 1);
          if (!line) continue;
          const id = line.split(" ")[0];
          process.stdout.write(id + " OK ${largeHex}\\n");
        }
      }
    `);
    client = new NsmProxyClient("bun", [largeMock]);

    const result = await client.getAttestation(new Uint8Array(32));
    expect(result.length).toBe(4096);
    expect(result.every((b) => b === 0xab)).toBe(true);
  });
});
