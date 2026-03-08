/**
 * Boot configuration received from the EC2 host via VSOCK:7777.
 *
 * The enclave blocks on startup until this config is received,
 * then uses it to set up networking, endpoints, and secrets.
 */

export interface Endpoint {
  /** Domain name (e.g. "fullnode.testnet.sui.io") */
  host: string;
  /** VSOCK port on the parent VM that forwards to this host:443 */
  vsockPort: number;
}

export interface BootConfig {
  /** External endpoints the enclave needs to reach. */
  endpoints: Endpoint[];
  /** Optional secrets as key-value pairs. */
  secrets?: Record<string, string>;
  /** Log level (default: "info") */
  logLevel?: string;
  /** Application-specific config (opaque to the platform layer). */
  app?: Record<string, unknown>;
}

/** Validate a parsed object against the BootConfig shape. Throws on invalid input. */
export function validateBootConfig(raw: unknown): BootConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("boot config must be a JSON object");
  }

  const obj = raw as Record<string, unknown>;

  // endpoints (required, array)
  if (!Array.isArray(obj.endpoints)) {
    throw new Error("boot config: endpoints must be an array");
  }
  for (let i = 0; i < obj.endpoints.length; i++) {
    const ep = obj.endpoints[i];
    if (ep === null || typeof ep !== "object" || Array.isArray(ep)) {
      throw new Error(`boot config: endpoints[${i}] must be an object`);
    }
    const { host, vsockPort } = ep as Record<string, unknown>;
    if (typeof host !== "string" || host.length === 0 || host.length > 253) {
      throw new Error(`boot config: endpoints[${i}].host must be a non-empty string (max 253 chars)`);
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(host)) {
      throw new Error(`boot config: endpoints[${i}].host contains invalid characters`);
    }
    if (typeof vsockPort !== "number" || !Number.isInteger(vsockPort) || vsockPort < 1 || vsockPort > 65535) {
      throw new Error(`boot config: endpoints[${i}].vsockPort must be an integer in 1..65535`);
    }
  }

  // secrets (optional, Record<string, string>)
  if (obj.secrets !== undefined) {
    if (obj.secrets === null || typeof obj.secrets !== "object" || Array.isArray(obj.secrets)) {
      throw new Error("boot config: secrets must be a string-to-string map");
    }
    for (const [k, v] of Object.entries(obj.secrets as Record<string, unknown>)) {
      if (typeof v !== "string") {
        throw new Error(`boot config: secrets["${k}"] must be a string`);
      }
    }
  }

  // logLevel (optional, string)
  if (obj.logLevel !== undefined && typeof obj.logLevel !== "string") {
    throw new Error("boot config: logLevel must be a string");
  }

  // app (optional, object)
  if (obj.app !== undefined) {
    if (obj.app === null || typeof obj.app !== "object" || Array.isArray(obj.app)) {
      throw new Error("boot config: app must be an object");
    }
  }

  return obj as unknown as BootConfig;
}

/**
 * Receive boot config from the host via VSOCK port 7777.
 * Spawns `traffic-proxy config recv 7777` which listens on VSOCK,
 * accepts one connection, and writes the received data to stdout.
 */
export async function receiveBootConfig(): Promise<BootConfig> {
  console.log("[config] waiting for boot config on VSOCK:7777...");

  const proc = Bun.spawn(["/traffic-proxy", "config", "recv", "7777"], {
    stdout: "pipe",
    stderr: "inherit",
  });

  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`traffic-proxy config recv exited with code ${code}`);
  }

  const json = await new Response(proc.stdout).text();
  console.log(`[config] received ${json.length} bytes`);

  const config = validateBootConfig(JSON.parse(json));

  // Secrets are available to handlers via ctx.config.secrets —
  // we intentionally do NOT inject them into process.env to prevent
  // the host from overwriting internal env vars (e.g. NSM_PROXY_PATH,
  // which is read when resolving the NSM proxy binary).
  if (config.secrets) {
    console.log(`[config] ${Object.keys(config.secrets).length} secrets available via ctx.config.secrets`);
  }

  return config;
}

/**
 * Dev mode: read config from a local file or environment.
 */
export async function devBootConfig(path?: string): Promise<BootConfig> {
  if (path) {
    const content = await Bun.file(path).text();
    return validateBootConfig(JSON.parse(content));
  }
  return {
    endpoints: [],
    logLevel: process.env.LOG_LEVEL ?? "debug",
    app: {},
  };
}
