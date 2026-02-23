import { db } from "./index";
import { users, notifications } from "./schema";
import { faker } from '@faker-js/faker';
import { sql } from "drizzle-orm";

async function seed() {
  const shouldClear = process.argv.includes('--clear');
  try {
    if (shouldClear) {
      console.log("🧹 Resetting all tables and ID sequences...");
      await db.execute(sql`TRUNCATE TABLE ${notifications}, ${users} RESTART IDENTITY CASCADE`);
    }

    console.log("🌱 Generating 50 users...");
    const fakeUsers = Array.from({ length: 50 }).map(() => ({
      fullName: faker.person.fullName(),
      email: faker.internet.email(),
    }));

    const createdUsers = await db.insert(users).values(fakeUsers).returning();
    const user1Id = createdUsers[0].id;
    console.log(`🔔 Seeding notifications for User ID: ${user1Id}...`);

    const initialNotifications = [
      {
        userId: user1Id,
        type: 'info',
        title: 'Welcome to the Platform',
        message: 'Your account has been successfully created and seeded.',
      },
      {
        userId: user1Id,
        type: 'success',
        title: 'Database Synced',
        message: 'The notification system is communicating with the Postgres backend.',
      },
      {
        userId: user1Id,
        type: 'warning',
        title: 'System Maintenance',
        message: 'Scheduled maintenance will occur at midnight.',
      }
    ];
    await db.insert(notifications).values(initialNotifications);

    console.log("✅ Seeding complete! User 1 has 3 notifications.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Seeding failed:", err);
    process.exit(1);
  }
}

seed();
