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
  vsock_port: number;
}

export interface BootConfig {
  /** External endpoints the enclave needs to reach. */
  endpoints: Endpoint[];
  /** Optional secrets as key-value pairs. */
  secrets?: Record<string, string>;
  /** Log level (default: "info") */
  log_level?: string;
  /** Application-specific config (opaque to the platform layer). */
  app?: Record<string, unknown>;
}

/**
 * Receive boot config from the host via VSOCK port 7777.
 * Blocks until the host sends the JSON blob and closes the connection.
 */
export async function receiveBootConfig(): Promise<BootConfig> {
  // Dynamic import to avoid loading VSOCK module outside enclave
  const { vsockListen, vsockAccept, vsockReadAll, vsockClose } = await import("./vsock.ts");

  console.log("[config] waiting for boot config on VSOCK:7777...");
  const listenFd = vsockListen(7777);
  const clientFd = vsockAccept(listenFd);
  const data = vsockReadAll(clientFd);
  vsockClose(clientFd);
  vsockClose(listenFd);

  const json = data.toString("utf-8");
  console.log(`[config] received ${json.length} bytes`);

  const config: BootConfig = JSON.parse(json);

  // Inject secrets into environment
  if (config.secrets) {
    for (const [key, value] of Object.entries(config.secrets)) {
      process.env[key] = value;
    }
    console.log(`[config] injected ${Object.keys(config.secrets).length} secrets`);
  }

  return config;
}

/**
 * Dev mode: read config from a local file or environment.
 */
export async function devBootConfig(path?: string): Promise<BootConfig> {
  if (path) {
    const content = await Bun.file(path).text();
    return JSON.parse(content);
  }
  return {
    endpoints: [],
    log_level: process.env.LOG_LEVEL ?? "debug",
    app: {},
  };
}
