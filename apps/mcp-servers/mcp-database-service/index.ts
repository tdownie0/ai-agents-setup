import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { db } from "@model_md/database";
import { users } from "@model_md/database";
import { count as drizzleCount, eq, gte, sql } from "drizzle-orm";

const server = new McpServer({ name: "supabase-manager", version: "1.0.0" });

server.registerTool(
  "get_user_stats",
  {
    description: "Returns the total count of users or recent signups.",
    inputSchema: z.object({
      filterByEmail: z.string().optional().describe("Filter by email"),
      days: z
        .number()
        .optional()
        .describe("Count users joined in the last X days"),
    }),
  },

  async ({ filterByEmail, days }) => {
    let query = db.select({ value: drizzleCount() }).from(users);

    if (filterByEmail) {
      query = query.where(eq(users.email, filterByEmail)) as any;
    }

    if (days) {
      query = query.where(
        gte(
          users.createdAt,
          sql`now() - interval '${sql.raw(days.toString())} days'`,
        ),
      ) as any;
    }

    const [result] = await query;
    const total = result?.value ?? 0;

    let message = `There are ${total} users total.`;
    if (days)
      message = `There are ${total} users who joined in the last ${days} days.`;
    if (filterByEmail)
      message = `There are ${total} users matching "${filterByEmail}".`;

    return { content: [{ type: "text", text: message }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
