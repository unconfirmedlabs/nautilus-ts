/**
 * Mock nsm-proxy that implements the same line-based protocol
 * as the real Rust binary, for testing NsmProxyClient.
 *
 * Protocol:
 *   "<id> ATT <hex-public-key>" → "<id> OK <hex-public-key>" (echoes back)
 *   "<id> RND"                  → "<id> OK deadbeefcafebabe0123456789abcdef"
 *   "<id> FAIL"                 → "<id> ERR simulated_failure"
 *   "<id> <unknown>"            → "<id> ERR unknown_method"
 */

const FAKE_RANDOM = "deadbeefcafebabe0123456789abcdef";

const reader = Bun.stdin.stream().getReader();
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
    if (line.length === 0) continue;

    const firstSpace = line.indexOf(" ");
    const id = line.slice(0, firstSpace);
    const rest = line.slice(firstSpace + 1);

    if (rest.startsWith("ATT ")) {
      const hex = rest.slice(4);
      process.stdout.write(`${id} OK ${hex}\n`);
    } else if (rest === "RND") {
      process.stdout.write(`${id} OK ${FAKE_RANDOM}\n`);
    } else if (rest === "FAIL") {
      process.stdout.write(`${id} ERR simulated_failure\n`);
    } else {
      process.stdout.write(`${id} ERR unknown_method\n`);
    }
  }
}
