import "dotenv/config";
import { db } from "./index.js";
import { users, notifications } from "./schema.js";
import { faker } from "@faker-js/faker";
import { sql } from "drizzle-orm";

async function seed() {
  const shouldClear = process.argv.includes("--clear");
  const MY_REAL_USER_ID = process.env.TEST_USER_ID;

  if (!MY_REAL_USER_ID) {
    console.error("❌ ERROR: TEST_USER_ID is not defined in .env");
    process.exit(1);
  }

  try {
    if (shouldClear) {
      console.log("🧹 Resetting tables...");
      await db.execute(sql`TRUNCATE TABLE ${notifications}, ${users} CASCADE`);
    }

    console.log(`👤 Seeding your real test user...`);
    await db
      .insert(users)
      .values({
        id: MY_REAL_USER_ID,
        fullName: "Lead Developer",
        email: "test@test.com",
      })
      .onConflictDoNothing();

    console.log("🌱 Generating 50 fake users with UUIDs...");
    const fakeUsers = Array.from({ length: 50 }).map(() => ({
      id: faker.string.uuid(),
      fullName: faker.person.fullName(),
      email: faker.internet.email(),
    }));

    await db.insert(users).values(fakeUsers);

    console.log(
      `🔔 Seeding notifications for your Real ID: ${MY_REAL_USER_ID}...`,
    );
    const initialNotifications = [
      {
        userId: MY_REAL_USER_ID,
        type: "info" as const,
        title: "Auth System Active",
        message: "Your UUID-based auth is now the source of truth.",
      },
      {
        userId: MY_REAL_USER_ID,
        type: "success" as const,
        title: "RLS Verified",
        message:
          "Only you can see this notification because of Row Level Security.",
      },
    ];

    await db.insert(notifications).values(initialNotifications);

    console.log("✅ Seeding complete!");
    process.exit(0);
  } catch (err) {
    console.error("❌ Seeding failed:", err);
    process.exit(1);
  }
}

seed();
