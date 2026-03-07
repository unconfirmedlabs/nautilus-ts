/**
 * Enclave networking setup.
 *
 * Loopback interface setup only — all TCP↔VSOCK bridging and /etc/hosts
 * are handled by the Rust traffic-forwarder binary.
 */

/**
 * Set up loopback interface (required inside enclave — no network by default).
 */
export function setupLoopback(): void {
  try {
    Bun.spawnSync(["ip", "addr", "add", "127.0.0.1/8", "dev", "lo"]);
    Bun.spawnSync(["ip", "link", "set", "dev", "lo", "up"]);
    console.log("[net] loopback configured");
  } catch {
    // Outside enclave (dev mode), loopback already exists
  }
}
