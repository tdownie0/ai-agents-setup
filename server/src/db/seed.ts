import { db } from "./index";
import { users } from "./schema";
import { faker } from '@faker-js/faker';
import { sql } from "drizzle-orm"; // 👈 Add this import

async function seed() {
  const shouldClear = process.argv.includes('--clear');
  try {
    if (shouldClear) {
      console.log("🧹 Resetting table and ID sequences...");
      await db.execute(sql`TRUNCATE TABLE ${users} RESTART IDENTITY CASCADE`);
    }

    console.log("🌱 Generating 50 users...");

    const fakeUsers = Array.from({ length: 50 }).map(() => ({
      fullName: faker.person.fullName(),
      email: faker.internet.email(),
    }));

    await db.insert(users).values(fakeUsers);

    console.log("✅ Seeding complete! IDs have been reset.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Seeding failed:", err);
    process.exit(1);
  }
}

seed();
