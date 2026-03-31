import { spawn, ChildProcess } from "node:child_process";
import { test, expect, describe, beforeAll, afterAll } from "vitest";

const PROJECT_NAME = process.env.PROJECT_NAME || "model_md";
const NETWORK_NAME = `supabase_network_${PROJECT_NAME}`;
const DB_HOST = `supabase_db_${PROJECT_NAME}`;
const CONTAINER_NAME = `mcp-integration-test-${Date.now()}`;

const shouldLog = process.env.DEBUG === "true";
const logResponse = (label: string, data: any) => {
  if (shouldLog) {
    console.log(`🔍 ${label}:`, JSON.stringify(data, null, 2));
  }
};

let sharedContainer: ChildProcess | null = null;

async function callTool(name: string, args: Record<string, any>): Promise<any> {
  const stdin = sharedContainer?.stdin;
  const stdout = sharedContainer?.stdout;

  if (!sharedContainer || !stdin || !stdout) {
    throw new Error("Container is not initialized or streams are closed");
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanupListeners();
      reject(new Error(`Tool call '${name}' timed out after 10s`));
    }, 10000);

    const onData = (d: Buffer) => {
      const data = d.toString();
      if (data.includes('"jsonrpc":"2.0"')) {
        try {
          const jsonStart = data.indexOf("{");
          const jsonEnd = data.lastIndexOf("}") + 1;
          const result = JSON.parse(data.substring(jsonStart, jsonEnd));

          clearTimeout(timeout);
          cleanupListeners();
          resolve(result);
        } catch (e) {
          // Incomplete JSON chunk, keep waiting
        }
      }
    };

    const cleanupListeners = () => {
      stdout.removeListener("data", onData);
    };

    stdout.on("data", onData);

    const request = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    };

    stdin.write(JSON.stringify(request) + "\n");
  });
}

describe("MCP Database Service Container Integration", () => {
  beforeAll(async () => {
    sharedContainer = spawn("docker", [
      "run",
      "--rm",
      "-i",
      "--name",
      CONTAINER_NAME,
      "--network",
      NETWORK_NAME,
      "-e",
      `DATABASE_URL=postgresql://postgres:postgres@${DB_HOST}:5432/postgres`,
      "-e",
      "DOCKER_MCP_TRANSPORT=stdio",
      "supabase-manager:latest",
    ]);

    // Fail-safe: If the test process dies, take the container with it
    process.on("exit", () => spawn("docker", ["rm", "-f", CONTAINER_NAME]));

    // Wait for container to be ready
    await new Promise((resolve) => setTimeout(resolve, 2500));
  });

  afterAll(async () => {
    if (sharedContainer) {
      logResponse("System", "Shutting down container...");
      sharedContainer.stdin?.end();
      sharedContainer.kill("SIGTERM");
      // Force kill via Docker CLI as a final fallback
      spawn("docker", ["rm", "-f", CONTAINER_NAME]);
      sharedContainer = null;
    }
  });

  test("get_user_stats returns a formatted message for recent signups", async () => {
    const result = await callTool("get_user_stats", { days: 30 });
    logResponse("Recent Signups Response", result);

    expect(result.result.content[0].text).toContain("users who joined");
  });

  test("get_user_stats filters correctly by email", async () => {
    const result = await callTool("get_user_stats", {
      filterByEmail: "test@test.com",
    });
    logResponse("Email Filter Response", result);

    expect(result.result.content[0].text).toContain('matching "test@test.com"');
  });
});
