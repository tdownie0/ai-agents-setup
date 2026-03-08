import { createMiddleware } from "hono/factory";
import { createClient } from "@supabase/supabase-js";
import { HTTPException } from "hono/http-exception";
import { env } from "../env.js";

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);

export const authMiddleware = createMiddleware(async (c, next) => {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new HTTPException(401, { message: "Unauthorized: Missing Token" });
  }

  const token = authHeader.split(" ")[1];

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    throw new HTTPException(401, { message: "Unauthorized: Invalid Token" });
  }

  c.set("userId", user.id);

  await next();
});
