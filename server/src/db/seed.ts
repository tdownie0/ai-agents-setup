import { db } from "./index";
import { users } from "./schema";


async function seed() {
  console.log("🌱 Seeding database...");

  await db.insert(users).values([
    {

      fullName: "Gemini AI",
      email: "hello@gemini.ai",
    },
    {
      fullName: "Test User",
      email: "test@example.com",
    }
  ]);

  console.log("✅ Seeding complete!");
  process.exit(0);
}

seed().catch((err) => {
  console.error("❌ Seeding failed:", err);
  process.exit(1);
});
