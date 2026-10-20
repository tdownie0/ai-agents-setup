import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import usersHandler from "./routes/users.js";
import notificationsHandler from "./routes/notifications.js";
import authHandler from "./routes/auth.js";
import marketDataHandler from "./routes/marketData.js";
import portfolioHandler from "./routes/portfolio.js";
import portfolioCarryoverHandler from "./routes/portfolioCarryover.js";
import portfolioEvalReportHandler from "./routes/portfolioEvalReport.js";
import portfolioEvalsHandler from "./routes/portfolioEvals.js";
import portfolioJudgeHandler from "./routes/portfolioJudge.js";
import portfolioPromptSuggestionsHandler from "./routes/portfolioPromptSuggestions.js";
import roundsHandler from "./routes/rounds.js";
import roundJobsHandler from "./routes/roundJobs.js";

const app = new Hono().basePath("/api");

app.use("*", cors());
app.use("*", logger());

app.get("/health", (c) => c.json({ status: "ok", time: new Date().toISOString() }));

const routes = app
  .route("/users", usersHandler)
  .route("/notifications", notificationsHandler)
  .route("/auth", authHandler)
  .route("/market-data", marketDataHandler)
  .route("/portfolio", portfolioHandler)
  .route("/portfolio", portfolioCarryoverHandler)
  // Before portfolioEvals: Hono prefers the first-registered match, and this
  // static path must win over that app's /evals/:simId param route.
  .route("/portfolio", portfolioEvalReportHandler)
  .route("/portfolio", portfolioEvalsHandler)
  .route("/portfolio", portfolioJudgeHandler)
  .route("/portfolio", portfolioPromptSuggestionsHandler)
  .route("/portfolio", roundsHandler)
  .route("/portfolio", roundJobsHandler);

// Export Type for Hono RPC (Frontend Type Safety)
export type AppType = typeof routes;

const port = parseInt(process.env.PORT || "3000", 10);
console.log(`🚀 Server starting on http://0.0.0.0:${port}`);

serve({
  fetch: app.fetch,
  port,
  hostname: "0.0.0.0",
});
