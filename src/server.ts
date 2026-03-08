/**
 * Example Nautilus server — built-in router.
 *
 * This file shows the batteries-included approach.
 * For Hono/Elysia/custom frameworks, see server-hono.ts.
 */

import { Nautilus } from "./nautilus.ts";

const app = new Nautilus();

// Add your routes here:
// app.post("/my_endpoint", async (req, ctx) => { ... });

app.start();
