/**
 * routes/sessions.ts
 *
 * Session management endpoints:
 *
 *   GET  /api/sessions              — list active sessions
 *   GET  /api/sessions/:roomName    — get session state + metadata
 *   POST /api/sessions/:roomName/stop — stop bridge session for a room
 *   POST /api/sessions/:roomName/interrupt — force barge-in (for testing)
 *
 * All endpoints require Bearer auth (BRIDGE_API_SECRET).
 */

import { Router, Request, Response } from "express";
import { logger } from "../utils/logger";
import { requireBridgeSecret } from "./middleware";
import { registry } from "../SessionRegistry";
import { stopWorker, listWorkers } from "../livekit/RoomWorker";

export const sessionsRouter = Router();
sessionsRouter.use(requireBridgeSecret);

// ─── List sessions ────────────────────────────────────────────────────────────

sessionsRouter.get("/api/sessions", (_req: Request, res: Response) => {
  const sessions = registry.getAll().map((s) => ({
    sessionId: s.id,
    state: s.getState(),
  }));

  res.json({
    count: sessions.length,
    activeRooms: listWorkers(),
    sessions,
  });
});

// ─── Get session ──────────────────────────────────────────────────────────────

sessionsRouter.get(
  "/api/sessions/:roomName",
  (req: Request, res: Response) => {
    const { roomName } = req.params as { roomName: string };
    const session = registry.get(roomName);

    if (!session) {
      res.status(404).json({ error: "No active session for this room" });
      return;
    }

    res.json({
      sessionId: session.id,
      roomName,
      state: session.getState(),
    });
  }
);

// ─── Stop session ─────────────────────────────────────────────────────────────

sessionsRouter.post(
  "/api/sessions/:roomName/stop",
  async (req: Request, res: Response) => {
    const { roomName } = req.params as { roomName: string };
    logger.info({ roomName }, "Stopping session via API");

    try {
      await stopWorker(roomName);
      res.json({ ok: true });
    } catch (err) {
      logger.error({ roomName, err }, "Error stopping session");
      res.status(500).json({ error: "Failed to stop session" });
    }
  }
);

// ─── Force interrupt (barge-in test) ─────────────────────────────────────────

sessionsRouter.post(
  "/api/sessions/:roomName/interrupt",
  (req: Request, res: Response) => {
    const { roomName } = req.params as { roomName: string };
    const session = registry.get(roomName);

    if (!session) {
      res.status(404).json({ error: "No active session" });
      return;
    }

    // Trigger barge-in event synthetically
    (session as unknown as { emit: (e: string) => void }).emit("barge_in");
    logger.info({ roomName }, "Force-interrupted session via API");
    res.json({ ok: true, state: session.getState() });
  }
);
