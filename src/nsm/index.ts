/**
 * NSM (Nitro Secure Module) access via a persistent Rust proxy process.
 *
 * The proxy owns all /dev/nsm interaction and speaks a tiny line-based
 * protocol over stdin/stdout:
 *   - "<id> ATT <hex-public-key>"
 *   - "<id> RND"
 * Responses are:
 *   - "<id> OK <hex-bytes>"
 *   - "<id> ERR <reason>"
 */

import { existsSync } from "fs";
import { fromHex, toHex } from "../core/crypto.ts";

interface PendingRequest {
  resolve(hex: string): void;
  reject(error: Error): void;
}

export class NsmProxyClient {
  private proc: Bun.Subprocess<"pipe", "pipe", "inherit">;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private exited = false;

  constructor(path: string, args: string[] = []) {
    this.proc = Bun.spawn([path, ...args], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });

    void this.readResponses();
    this.proc.exited.then((code) => {
      this.exited = true;
      proxyClient = null;
      const error = new Error(`nsm-proxy exited with code ${code}`);
      for (const pending of this.pending.values()) {
        pending.reject(error);
      }
      this.pending.clear();
    });
  }

  async getAttestation(publicKey: Uint8Array): Promise<Uint8Array> {
    return fromHex(await this.sendRequest("ATT", publicKey));
  }

  async getRandom(): Promise<Uint8Array> {
    return fromHex(await this.sendRequest("RND"));
  }

  stop(): void {
    if (!this.exited) {
      this.proc.kill();
    }
    this.exited = true;
    proxyClient = null;
  }

  private async sendRequest(
    method: "ATT" | "RND",
    payload?: Uint8Array,
  ): Promise<string> {
    if (this.exited) {
      throw new Error("nsm-proxy is not running");
    }

    const id = this.nextId++;
    const line = method === "ATT"
      ? `${id} ATT ${toHex(payload!)}\n`
      : `${id} RND\n`;

    const response = new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });

    await this.proc.stdin.write(line);
    await this.proc.stdin.flush();
    return await response;
  }

  private async readResponses(): Promise<void> {
    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();
    let buffered = "";

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });

      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) break;
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) {
          this.handleResponse(line);
        }
      }
    }

    buffered += decoder.decode();
    if (buffered.trim().length > 0) {
      this.handleResponse(buffered.trim());
    }
  }

  private handleResponse(line: string): void {
    const firstSpace = line.indexOf(" ");
    const secondSpace = line.indexOf(" ", firstSpace + 1);
    if (firstSpace === -1 || secondSpace === -1) {
      console.error(`[nsm] malformed proxy response: ${line}`);
      return;
    }

    const id = Number(line.slice(0, firstSpace));
    const status = line.slice(firstSpace + 1, secondSpace);
    const payload = line.slice(secondSpace + 1);
    const pending = this.pending.get(id);
    if (!pending) {
      console.error(`[nsm] orphaned proxy response for id=${id}`);
      return;
    }

    this.pending.delete(id);
    if (status === "OK") {
      pending.resolve(payload);
      return;
    }

    pending.reject(new Error(`nsm-proxy error: ${payload}`));
  }
}

let proxyClient: NsmProxyClient | null = null;

function findProxyPath(): string | null {
  const candidates = [
    process.env.NSM_PROXY_PATH,
    "/nsm-proxy",
    "./target/x86_64-unknown-linux-musl/release/nsm-proxy",
    "./target/release/nsm-proxy",
  ].filter(Boolean) as string[];

  for (const path of candidates) {
    if (existsSync(path)) {
      return path;
    }
  }

  return null;
}

function getClient(): NsmProxyClient {
  if (proxyClient) return proxyClient;

  const path = findProxyPath();
  if (!path) {
    throw new Error("nsm-proxy binary not found");
  }

  proxyClient = new NsmProxyClient(path);
  return proxyClient;
}

/**
 * Request a Nitro Enclave attestation document bound to the given public key.
 * Returns the raw attestation document bytes (CBOR-encoded COSE_Sign1).
 * Returns null if not running inside a Nitro Enclave.
 */
export async function getAttestation(
  publicKey: Uint8Array,
): Promise<Uint8Array | null> {
  if (!isEnclave()) return null;
  return await getClient().getAttestation(publicKey);
}

/**
 * Get random data from the NSM hardware RNG.
 * Returns null if not running inside a Nitro Enclave.
 */
export async function getHardwareRandom(): Promise<Uint8Array | null> {
  if (!isEnclave()) return null;
  return await getClient().getRandom();
}

/** Stop the NSM proxy if it is running. */
export function stopNsmProxy(): void {
  proxyClient?.stop();
  proxyClient = null;
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
