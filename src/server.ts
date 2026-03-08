/**
 * Example Nautilus server.
 *
 * This file is a starting point — add your routes below.
 * The framework provides GET /attestation (NSM hardware attestation).
 * All other routes are yours to define.
 */

import { boot } from "./nautilus.ts";

const { app, ctx } = await boot({ port: 3000 });

// Example: health check
app.get("/health_check", (c) =>
  c.json({ pk: ctx.publicKey, address: ctx.address }),
);

// Example: sign data
// app.post("/sign", async (c) => {
//   const body = await c.req.arrayBuffer();
//   const sig = ctx.sign(ctx.blake2b256(new Uint8Array(body)));
//   return c.json({ signature: ctx.toHex(sig) });
// });

export default { port: 3000, hostname: "127.0.0.1", fetch: app.fetch };
