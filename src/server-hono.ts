/**
 * Example Nautilus server — Hono.
 *
 * Uses `boot()` for enclave setup, Hono for routing.
 *
 *   bun add hono
 *   bun --hot src/server-hono.ts
 */

import { boot } from "./nautilus.ts";
import { Hono } from "hono";

const ctx = await boot({ port: 3000 });
const app = new Hono();

app.get("/", (c) => c.text("Pong!"));

app.get("/health_check", (c) =>
  c.json({ pk: ctx.publicKey, address: ctx.address }),
);

app.get("/get_attestation", async (c) => {
  const doc = await ctx.attest();
  if (!doc) return c.json({ error: "not running in enclave" }, 503);
  return c.json({ attestation: ctx.toHex(doc) });
});

// Add your routes here:
// app.post("/my_endpoint", async (c) => { ... });

export default {
  port: 3000,
  hostname: "127.0.0.1",
  fetch: app.fetch,
};
