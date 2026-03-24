import { Hono } from "hono";
import { db } from "@model_md/database";
import { users } from "@model_md/database";
import { createClient } from "@supabase/supabase-js";
import { env } from "../env.js";

// Validate Supabase token and extract user info
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

const authApp = new Hono();

authApp.post("/register", async (c) => {
  let body;
  try {
    body = await c.req.json();
  } catch (e) {
    console.error("Failed to parse JSON body:", e);
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const { fullName } = body;

  const authHeader = c.req.header("Authorization");
  if (!authHeader) return c.json({ error: "No token" }, 401);

  const token = authHeader.replace("Bearer ", "");

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser(token);

  if (authError || !user) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  try {
    const [newUser] = await db
      .insert(users)
      .values({
        id: user.id,
        fullName: fullName,
        email: user.email!,
      })
      .returning();

    return c.json({ success: true, user: newUser }, 201);
  } catch (dbError) {
    console.error("Database Error:", dbError);
    return c.json({ error: "Database insertion failed" }, 500);
  }
});

export default authApp;
