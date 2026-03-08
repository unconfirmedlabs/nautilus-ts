/**
 * Example Nautilus server — Elysia.
 *
 * Uses `boot()` for enclave setup, Elysia for routing.
 *
 *   bun add elysia
 *   bun --hot src/server-elysia.ts
 */

import { boot } from "./nautilus.ts";
import { Elysia } from "elysia";

const ctx = await boot({ port: 3000 });

new Elysia()
  .get("/", () => "Pong!")
  .get("/health_check", () => ({
    pk: ctx.publicKey,
    address: ctx.address,
  }))
  .get("/get_attestation", async () => {
    const doc = await ctx.attest();
    if (!doc) return new Response(JSON.stringify({ error: "not running in enclave" }), { status: 503 });
    return { attestation: ctx.toHex(doc) };
  })
  // Add your routes here:
  // .post("/my_endpoint", async ({ body }) => { ... })
  .listen({ port: 3000, hostname: "127.0.0.1" });
