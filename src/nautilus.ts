/**
 * Nautilus — TypeScript enclave framework.
 *
 * Two usage patterns:
 *
 * **1. Standalone boot (bring your own framework):**
 *
 * ```ts
 * import { boot } from "./nautilus.ts";
 * import { Hono } from "hono";
 *
 * const ctx = await boot({ port: 3000 });
 * const app = new Hono();
 *
 * app.get("/health", (c) => c.json({ pk: ctx.publicKey }));
 *
 * export default { port: 3000, hostname: "127.0.0.1", fetch: app.fetch };
 * ```
 *
 * **2. Built-in server (batteries included):**
 *
 * ```ts
 * import { Nautilus } from "./nautilus.ts";
 *
 * const app = new Nautilus();
 * app.post("/my_endpoint", async (req, ctx) => {
 *   return Response.json({ received: await req.json() });
 * });
 * app.start();
 * ```
 */

import {
  type BootConfig,
  receiveBootConfig,
  devBootConfig,
  setupLoopback,
  generateKeypair,
  sign,
  suiAddress,
  toHex,
  fromHex,
  blake2b256,
  sha256Hash,
} from "./core/index.ts";
import { isEnclave, getAttestation, getHardwareRandom, stopNsmProxy } from "./nsm/index.ts";

export interface NautilusContext {
  /** Hex-encoded public key. */
  publicKey: string;
  /** Sui address derived from the public key. */
  address: string;
  /** Boot config received from host. */
  config: BootConfig;
  /** Whether we're running inside a Nitro Enclave. */
  inEnclave: boolean;
  /** Sign bytes with the ephemeral keypair. */
  sign(message: Uint8Array): Uint8Array;
  /** Get NSM attestation document (null if not in enclave). */
  attest(): Promise<Uint8Array | null>;
  /** Hex encode. */
  toHex: typeof toHex;
  /** Hex decode. */
  fromHex: typeof fromHex;
  /** Blake2b-256 hash. */
  blake2b256: typeof blake2b256;
  /** SHA-256 hash. */
  sha256: typeof sha256Hash;
  /** Clean up resources (NSM proxy). Call when shutting down. */
  shutdown(): void;
}

export interface BootOptions {
  /** Port the HTTP server will listen on (default: 3000). */
  port?: number;
  /** Path to a local config file for dev mode. */
  devConfigPath?: string;
  /** @internal Override enclave detection for testing. */
  _testAsEnclave?: boolean;
}

/** Spawn the traffic proxy as a child process. */
function startTrafficProxy(config: BootConfig, httpPort: number): void {
  const proxyConfig = JSON.stringify({
    httpVsockPort: httpPort,
    httpTcpPort: httpPort,
    endpoints: config.endpoints,
  });

  const proc = Bun.spawn(["/traffic-proxy", "enclave"], {
    stdin: new Blob([proxyConfig]),
    stdout: "inherit",
    stderr: "inherit",
  });

  proc.exited.then((code) => {
    console.error(`[nautilus] traffic-proxy exited with code ${code}`);
    process.exit(1);
  });

  console.log(`[nautilus] traffic-proxy started (pid ${proc.pid})`);
}

/**
 * Boot the enclave and return a context object.
 *
 * Use this when you want to bring your own HTTP framework
 * (Hono, Elysia, or bare Bun.serve). Nautilus handles enclave
 * boot, networking, key generation, and attestation — you
 * handle routing.
 *
 * In enclave mode:
 *   1. Set up loopback networking
 *   2. Receive config from host via VSOCK:7777
 *   3. Spawn traffic proxy (handles /etc/hosts, TCP↔VSOCK bridges)
 *
 * In dev mode:
 *   1. Read config from file or use defaults
 */
export async function boot(options: BootOptions = {}): Promise<NautilusContext> {
  const port = options.port ?? 3000;
  const inEnclave = options._testAsEnclave || isEnclave();
  let config: BootConfig;

  if (inEnclave && !options._testAsEnclave) {
    console.log("[nautilus] booting in enclave mode");
    setupLoopback();
    config = await receiveBootConfig();

    // Spawn traffic proxy — handles /etc/hosts, inbound + outbound bridges
    startTrafficProxy(config, port);
  } else {
    console.log("[nautilus] booting in dev mode");
    config = await devBootConfig(options.devConfigPath);
  }

  // Generate ephemeral keypair (mix NSM hardware entropy when available)
  const nsmEntropy = inEnclave ? await getHardwareRandom() : null;
  const keypair = generateKeypair(nsmEntropy);
  const publicKey = toHex(keypair.publicKey);
  const address = suiAddress(keypair.publicKey);

  console.log(`[nautilus] public key: ${publicKey}`);
  console.log(`[nautilus] address:    ${address}`);

  return {
    publicKey,
    address,
    config,
    inEnclave,
    sign: (msg) => sign(keypair, msg),
    attest: () => getAttestation(keypair.publicKey),
    toHex,
    fromHex,
    blake2b256,
    sha256: sha256Hash,
    shutdown: () => stopNsmProxy(),
  };
}

// ---------------------------------------------------------------------------
// Built-in server (batteries-included option)
// ---------------------------------------------------------------------------

type RouteHandler = (
  req: Request,
  ctx: NautilusContext,
) => Response | Promise<Response>;

interface Route {
  method: string;
  path: string;
  handler: RouteHandler;
}

export class Nautilus {
  private routes: Route[] = [];
  private port = 3000;
  private maxBodySize = Number(process.env.MAX_BODY_SIZE) || 10 * 1024 * 1024;
  private configPath?: string;
  private server?: ReturnType<typeof Bun.serve>;
  private ctx?: NautilusContext;
  /** @internal Override enclave detection for testing error suppression. */
  _testAsEnclave = false;

  /** Actual port the server is listening on (useful when port 0 is used). */
  get listeningPort(): number | undefined {
    return this.server?.port;
  }

  /** Stop the HTTP server and clean up resources. */
  stop(): void {
    this.server?.stop(true);
    this.server = undefined;
    this.ctx?.shutdown();
    this.ctx = undefined;
  }

  /**
   * Register a route handler.
   */
  route(method: string, path: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), path, handler });
    return this;
  }

  /** Shorthand for GET routes. */
  get(path: string, handler: RouteHandler): this {
    return this.route("GET", path, handler);
  }

  /** Shorthand for POST routes. */
  post(path: string, handler: RouteHandler): this {
    return this.route("POST", path, handler);
  }

  /** Set the server port (default: 3000). */
  setPort(port: number): this {
    this.port = port;
    return this;
  }

  /** Set max request body size in bytes (default: 10MB). */
  setMaxBodySize(bytes: number): this {
    this.maxBodySize = bytes;
    return this;
  }

  /** Set a local config file path for dev mode. */
  setDevConfig(path: string): this {
    this.configPath = path;
    return this;
  }

  /**
   * Boot the enclave and start the built-in HTTP server.
   */
  async start(): Promise<void> {
    const ctx = await boot({
      port: this.port,
      devConfigPath: this.configPath,
      _testAsEnclave: this._testAsEnclave,
    });
    this.ctx = ctx;

    // Built-in routes
    this.get("/health_check", (_req, ctx) => {
      return Response.json({
        pk: ctx.publicKey,
        address: ctx.address,
      });
    });

    this.get("/get_attestation", async (_req, ctx) => {
      const doc = await ctx.attest();
      if (!doc) {
        return Response.json(
          { error: "not running in enclave" },
          { status: 503 },
        );
      }
      return Response.json({ attestation: toHex(doc) });
    });

    this.get("/", () => new Response("Pong!"));

    // Start HTTP server
    const routes = this.routes;
    const inEnclave = ctx.inEnclave;
    this.server = Bun.serve({
      port: this.port,
      hostname: "127.0.0.1",
      maxRequestBodySize: this.maxBodySize,
      development: false,
      async fetch(req) {
        const url = new URL(req.url);
        const method = req.method;
        const path = url.pathname;

        const route = routes.find(
          (r) => r.method === method && r.path === path,
        );

        if (!route) {
          return Response.json({ error: "not found" }, { status: 404 });
        }

        try {
          return await route.handler(req, ctx);
        } catch (e: any) {
          console.error(`[nautilus] ${method} ${path} error:`, e);
          return Response.json(
            { error: inEnclave ? "internal error" : (e.message ?? "internal error") },
            { status: 500 },
          );
        }
      },
      error(err) {
        console.error("[nautilus] unhandled server error:", err);
        return Response.json(
          { error: "internal server error" },
          { status: 500 },
        );
      },
    });

    console.log(`[nautilus] listening on 127.0.0.1:${this.server.port}`);
  }
}
