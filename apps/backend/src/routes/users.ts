import { Hono } from "hono";
import { db } from "@model_md/database";
import { users } from "@model_md/database";
import { eq } from "drizzle-orm";
import { authMiddleware } from "../middleware/authMiddleware.js";

// Define the context type so Hono knows 'userId' exists
const usersApp = new Hono<{ Variables: { userId: string } }>();

usersApp.get("/me", authMiddleware, async (c) => {
  const userId = c.get("userId");
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return c.json({ error: "User profile not found" }, 404);
  }

  return c.json(user);
});

usersApp.get("/", authMiddleware, async (c) => {
  const allUsers = await db.select().from(users);
  return c.json(allUsers);
});

export default usersApp;
