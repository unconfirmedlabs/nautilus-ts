/**
 * Tests for boot configuration parsing and dev config.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { devBootConfig, validateBootConfig } from "../src/core/config.ts";
import type { BootConfig } from "../src/core/config.ts";

describe("devBootConfig", () => {
  test("returns defaults when no path given", async () => {
    const config = await devBootConfig();
    expect(config.endpoints).toEqual([]);
    expect(config.log_level).toBeDefined();
    expect(config.app).toEqual({});
  });

  test("reads config from file", async () => {
    const tmpPath = "/tmp/nautilus-test-config.json";
    const testConfig: BootConfig = {
      endpoints: [
        { host: "example.com", vsock_port: 8443 },
      ],
      secrets: { API_KEY: "test-key" },
      log_level: "debug",
      app: { foo: "bar" },
    };

    await Bun.write(tmpPath, JSON.stringify(testConfig));
    const config = await devBootConfig(tmpPath);

    expect(config.endpoints).toHaveLength(1);
    expect(config.endpoints[0].host).toBe("example.com");
    expect(config.endpoints[0].vsock_port).toBe(8443);
    expect(config.secrets?.API_KEY).toBe("test-key");
    expect(config.log_level).toBe("debug");
    expect(config.app?.foo).toBe("bar");
  });

  test("throws on invalid JSON", async () => {
    const tmpPath = "/tmp/nautilus-test-bad-config.json";
    await Bun.write(tmpPath, "not valid json {{{");

    expect(devBootConfig(tmpPath)).rejects.toThrow();
  });

  test("throws on nonexistent file", async () => {
    expect(devBootConfig("/tmp/nautilus-nonexistent.json")).rejects.toThrow();
  });

  test("respects LOG_LEVEL env var", async () => {
    const prev = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "warn";

    const config = await devBootConfig();
    expect(config.log_level).toBe("warn");

    if (prev !== undefined) process.env.LOG_LEVEL = prev;
    else delete process.env.LOG_LEVEL;
  });
});

describe("BootConfig shape", () => {
  test("minimal config is valid", async () => {
    const tmpPath = "/tmp/nautilus-test-minimal.json";
    await Bun.write(tmpPath, JSON.stringify({ endpoints: [] }));
    const config = await devBootConfig(tmpPath);

    expect(config.endpoints).toEqual([]);
    expect(config.secrets).toBeUndefined();
    expect(config.log_level).toBeUndefined();
    expect(config.app).toBeUndefined();
  });

  test("config with multiple endpoints", async () => {
    const tmpPath = "/tmp/nautilus-test-multi.json";
    await Bun.write(tmpPath, JSON.stringify({
      endpoints: [
        { host: "sui.io", vsock_port: 8001 },
        { host: "walrus.io", vsock_port: 8002 },
        { host: "seal.io", vsock_port: 8003 },
      ],
    }));
    const config = await devBootConfig(tmpPath);
    expect(config.endpoints).toHaveLength(3);
  });
});

describe("validateBootConfig", () => {
  const valid: BootConfig = {
    endpoints: [{ host: "sui.io", vsock_port: 8443 }],
    secrets: { API_KEY: "test" },
    log_level: "debug",
    app: { foo: "bar" },
  };

  test("accepts valid full config", () => {
    expect(validateBootConfig(valid)).toEqual(valid);
  });

  test("accepts minimal config", () => {
    expect(validateBootConfig({ endpoints: [] })).toEqual({ endpoints: [] });
  });

  // top-level shape
  test("rejects null", () => {
    expect(() => validateBootConfig(null)).toThrow("must be a JSON object");
  });

  test("rejects array", () => {
    expect(() => validateBootConfig([])).toThrow("must be a JSON object");
  });

  test("rejects string", () => {
    expect(() => validateBootConfig("hello")).toThrow("must be a JSON object");
  });

  // endpoints
  test("rejects missing endpoints", () => {
    expect(() => validateBootConfig({})).toThrow("endpoints must be an array");
  });

  test("rejects non-array endpoints", () => {
    expect(() => validateBootConfig({ endpoints: "oops" })).toThrow("endpoints must be an array");
  });

  test("rejects endpoint with missing host", () => {
    expect(() => validateBootConfig({ endpoints: [{ vsock_port: 100 }] })).toThrow("host must be a non-empty string");
  });

  test("rejects endpoint with empty host", () => {
    expect(() => validateBootConfig({ endpoints: [{ host: "", vsock_port: 100 }] })).toThrow("host must be a non-empty string");
  });

  test("rejects endpoint with oversized host", () => {
    expect(() => validateBootConfig({ endpoints: [{ host: "a".repeat(254), vsock_port: 100 }] })).toThrow("host must be a non-empty string");
  });

  test("rejects endpoint host with whitespace", () => {
    expect(() => validateBootConfig({ endpoints: [{ host: "evil.com localhost", vsock_port: 100 }] })).toThrow("invalid characters");
  });

  test("rejects endpoint host with newline", () => {
    expect(() => validateBootConfig({ endpoints: [{ host: "evil.com\n127.0.0.1 admin", vsock_port: 100 }] })).toThrow("invalid characters");
  });

  test("rejects endpoint host with tab", () => {
    expect(() => validateBootConfig({ endpoints: [{ host: "evil.com\tlocalhost", vsock_port: 100 }] })).toThrow("invalid characters");
  });

  test("rejects endpoint with non-integer port", () => {
    expect(() => validateBootConfig({ endpoints: [{ host: "sui.io", vsock_port: 1.5 }] })).toThrow("vsock_port must be an integer in 1..65535");
  });

  test("rejects endpoint with port 0", () => {
    expect(() => validateBootConfig({ endpoints: [{ host: "sui.io", vsock_port: 0 }] })).toThrow("vsock_port must be an integer in 1..65535");
  });

  test("rejects endpoint with port > 65535", () => {
    expect(() => validateBootConfig({ endpoints: [{ host: "sui.io", vsock_port: 70000 }] })).toThrow("vsock_port must be an integer in 1..65535");
  });

  test("rejects endpoint with negative port", () => {
    expect(() => validateBootConfig({ endpoints: [{ host: "sui.io", vsock_port: -1 }] })).toThrow("vsock_port must be an integer in 1..65535");
  });

  test("rejects endpoint that is not an object", () => {
    expect(() => validateBootConfig({ endpoints: ["bad"] })).toThrow("endpoints[0] must be an object");
  });

  // secrets
  test("rejects non-object secrets", () => {
    expect(() => validateBootConfig({ endpoints: [], secrets: "bad" })).toThrow("secrets must be a string-to-string map");
  });

  test("rejects array secrets", () => {
    expect(() => validateBootConfig({ endpoints: [], secrets: ["a"] })).toThrow("secrets must be a string-to-string map");
  });

  test("rejects non-string secret value", () => {
    expect(() => validateBootConfig({ endpoints: [], secrets: { key: 123 } })).toThrow('secrets["key"] must be a string');
  });

  // log_level
  test("rejects non-string log_level", () => {
    expect(() => validateBootConfig({ endpoints: [], log_level: 5 })).toThrow("log_level must be a string");
  });

  // app
  test("rejects non-object app", () => {
    expect(() => validateBootConfig({ endpoints: [], app: "bad" })).toThrow("app must be an object");
  });

  test("rejects array app", () => {
    expect(() => validateBootConfig({ endpoints: [], app: [1, 2] })).toThrow("app must be an object");
  });

  // devBootConfig validates too
  test("devBootConfig rejects invalid config from file", async () => {
    const tmpPath = "/tmp/nautilus-test-invalid-shape.json";
    await Bun.write(tmpPath, JSON.stringify({ endpoints: "not-an-array" }));
    expect(devBootConfig(tmpPath)).rejects.toThrow("endpoints must be an array");
  });

  test("rejects endpoint host with slash", () => {
    expect(() => validateBootConfig({ endpoints: [{ host: "evil.com/path", vsock_port: 100 }] })).toThrow("invalid characters");
  });

  test("rejects endpoint host with colon", () => {
    expect(() => validateBootConfig({ endpoints: [{ host: "evil.com:443", vsock_port: 100 }] })).toThrow("invalid characters");
  });

  test("accepts endpoint with port 1", () => {
    expect(validateBootConfig({ endpoints: [{ host: "sui.io", vsock_port: 1 }] })).toBeDefined();
  });

  test("accepts endpoint with port 65535", () => {
    expect(validateBootConfig({ endpoints: [{ host: "sui.io", vsock_port: 65535 }] })).toBeDefined();
  });

  test("rejects endpoint with NaN port", () => {
    expect(() => validateBootConfig({ endpoints: [{ host: "sui.io", vsock_port: NaN }] })).toThrow("vsock_port must be an integer");
  });
});

describe("secrets isolation", () => {
  test("secrets are not injected into process.env", async () => {
    const uniqueKey = `NAUTILUS_TEST_SECRET_${Date.now()}`;
    const tmpPath = "/tmp/nautilus-test-secrets-isolation.json";
    await Bun.write(tmpPath, JSON.stringify({
      endpoints: [],
      secrets: { [uniqueKey]: "should-not-leak" },
    }));

    const config = await devBootConfig(tmpPath);
    expect(config.secrets?.[uniqueKey]).toBe("should-not-leak");
    expect(process.env[uniqueKey]).toBeUndefined();
  });
});
