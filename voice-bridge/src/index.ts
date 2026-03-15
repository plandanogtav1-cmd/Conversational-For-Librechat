/**
 * index.ts
 *
 * Voice Bridge server entry point.
 *
 * Starts:
 *   1. Express HTTP server (token issuing, session management, health)
 *   2. Optional Prometheus metrics server on a separate port
 *   3. Graceful shutdown handler
 *
 * The LiveKit RoomWorker connects lazily when the first /api/token
 * request arrives, or eagerly if LIVEKIT_ROOMS env var lists pre-joined rooms.
 */

import express from "express";
import cors from "cors";
import { config } from "./config";
import { logger } from "./utils/logger";
import { tokenRouter } from "./routes/token";
import { sessionsRouter } from "./routes/sessions";
import { healthRouter } from "./routes/health";
import { stopWorker, listWorkers } from "./livekit/RoomWorker";
import { metrics } from "./utils/metrics";

// ─── App ──────────────────────────────────────────────────────────────────────

const app = express();

app.use(express.json({ limit: "1mb" }));

// CORS: allow any origin in dev; tighten in prod via ALLOWED_ORIGIN env
const allowedOrigin = process.env["ALLOWED_ORIGIN"] ?? "*";
app.use(
  cors({
    origin: allowedOrigin,
    methods: ["GET", "POST", "DELETE"],
    allowedHeaders: ["Authorization", "Content-Type"],
  })
);

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use(healthRouter);   // /health, /ready, /metrics (no auth)
app.use(tokenRouter);    // /api/token
app.use(sessionsRouter); // /api/sessions/*

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Global error handler
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    logger.error({ err }, "Unhandled route error");
    res.status(500).json({ error: "Internal server error" });
  }
);

// ─── Start ────────────────────────────────────────────────────────────────────

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info(
    {
      host: config.HOST,
      port: config.PORT,
      ttsProvider: config.TTS_PROVIDER,
      llmModel: config.LLM_MODEL,
      livekitUrl: config.LIVEKIT_URL,
    },
    `🎙  Voice Bridge listening on http://${config.HOST}:${config.PORT}`
  );
});

// ─── Metrics server (separate port for internal scraping) ─────────────────────

if (config.METRICS_PORT) {
  const metricsApp = express();
  metricsApp.get("/metrics", (_req, res) => {
    res.set("Content-Type", "text/plain; version=0.0.4");
    res.send(metrics.toPrometheusText());
  });
  metricsApp.listen(config.METRICS_PORT, () => {
    logger.info({ port: config.METRICS_PORT }, "📊  Metrics server listening");
  });
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, "Shutting down…");

  server.close();

  // Stop all active room workers
  const rooms = listWorkers();
  await Promise.allSettled(rooms.map((r) => stopWorker(r)));

  logger.info("Shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Catch unhandled promise rejections — log and continue (don't crash)
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled promise rejection");
});
