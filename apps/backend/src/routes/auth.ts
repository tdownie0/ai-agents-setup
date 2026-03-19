import { Hono } from "hono";
import { db } from "@model_md/database";
import { users } from "@model_md/database";
import { eq } from "drizzle-orm";
import { createClient } from "@supabase/supabase-js";
import { env } from "../env.js";

// Validate Supabase token and extract user info
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

const authApp = new Hono();

// POST /register - Create user profile in local DB after Supabase signup
authApp.post("/register", async (c) => {
  const { fullName, supabaseUserId, email } = await c.req.json();

  if (!fullName || !supabaseUserId || !email) {
    return c.json({ error: "Missing required fields: fullName, supabaseUserId, email" }, 400);
  }

  // Verify the supabaseUserId is valid (token verification)
  // Optional: verify the Supabase user exists

  // Check if user already exists
  const existingUser = await db
    .select()
    .from(users)
    .where(eq(users.id, supabaseUserId))
    .limit(1);

  if (existingUser.length > 0) {
    return c.json({ error: "User profile already exists" }, 409);
  }

  // Create user in local database
  const [newUser] = await db
    .insert(users)
    .values({
      id: supabaseUserId,
      fullName,
      email,
    })
    .returning();

  return c.json({ 
    success: true, 
    user: {
      id: newUser.id,
      fullName: newUser.fullName,
      email: newUser.email,
      createdAt: newUser.createdAt
    }
  }, 201);
});

export default authApp;
