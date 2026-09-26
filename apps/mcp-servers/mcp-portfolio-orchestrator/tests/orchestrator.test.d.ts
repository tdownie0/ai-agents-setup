/**
 * Unit tests for the portfolio-orchestrator MCP server.
 *
 * `src/index.ts` is intentionally NOT imported (it connects the stdio
 * transport at module scope and requires runtime env). Everything tested
 * here is a parameter-driven module: config, agent resolution, the bounded
 * pool, the backend client (stubbed fetch), the docker-exec spawner (injected
 * exec), the durable round store, and the round runner (injected store +
 * spawner).
 *
 * The runner/store tests are the regression net for the original failure: the
 * docker MCP gateway runs this server as a throwaway container per tool call,
 * so unawaited work died mid-round and in-memory state was unreachable from the
 * next call. Progress must therefore be persisted through the store, and
 * `start_agent_round` must await the pool.
 */
export {};
//# sourceMappingURL=orchestrator.test.d.ts.map