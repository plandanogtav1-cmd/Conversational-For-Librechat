/**
 * routes/health.ts
 *
 * GET /health        — liveness probe (no auth)
 * GET /ready         — readiness probe: checks STT/TTS reachability
 * GET /metrics       — Prometheus text metrics (no auth, internal only)
 */

import { Router, Request, Response } from "express";
import axios from "axios";
import { config } from "../config";
import { logger } from "../utils/logger";
import { metrics } from "../utils/metrics";
import { registry } from "../SessionRegistry";

export const healthRouter = Router();

// ─── Liveness ─────────────────────────────────────────────────────────────────

healthRouter.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    activeSessions: registry.size,
    ts: new Date().toISOString(),
  });
});

// ─── Readiness ────────────────────────────────────────────────────────────────

healthRouter.get("/ready", async (_req: Request, res: Response) => {
  const checks: Record<string, "ok" | "error"> = {};

  // Check Deepgram (just HTTPS reachability — we don't open a WS here)
  try {
    await axios.get("https://api.deepgram.com/v1/projects", {
      headers: { Authorization: `Token ${config.DEEPGRAM_API_KEY}` },
      timeout: 4000,
    });
    checks["deepgram"] = "ok";
  } catch {
    checks["deepgram"] = "error";
    logger.warn("Deepgram readiness check failed");
  }

  // Check TTS provider
  if (config.TTS_PROVIDER === "piper") {
    try {
      await axios.get(config.PIPER_URL.replace("/synthesize", "/"), {
        timeout: 3000,
      });
      checks["tts_piper"] = "ok";
    } catch {
      checks["tts_piper"] = "error";
    }
  } else {
    checks["tts_openai"] = "ok"; // Can't pre-check without a real request
  }

  // Check LLM
  try {
    await axios.get(`${config.LLM_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${config.LLM_API_KEY}` },
      timeout: 4000,
    });
    checks["llm"] = "ok";
  } catch {
    checks["llm"] = "error";
    logger.warn("LLM readiness check failed");
  }

  const allOk = Object.values(checks).every((v) => v === "ok");

  res.status(allOk ? 200 : 503).json({
    ready: allOk,
    checks,
    ts: new Date().toISOString(),
  });
});

// ─── Prometheus metrics ───────────────────────────────────────────────────────

healthRouter.get("/metrics", (_req: Request, res: Response) => {
  res.set("Content-Type", "text/plain; version=0.0.4");
  res.send(metrics.toPrometheusText());
});
