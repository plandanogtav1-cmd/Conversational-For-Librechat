/**
 * routes/token.ts
 *
 * POST /api/token
 * Issues a LiveKit access token for a browser client to join a room.
 * Also triggers the voice bridge worker to join the same room.
 *
 * Request body:
 *   { roomName: string; participantName: string; participantIdentity?: string }
 *
 * Response:
 *   { token: string; url: string; roomName: string; sessionId?: string }
 *
 * Called by: LibreChat frontend before opening a voice session.
 */

import { Router, Request, Response } from "express";
import { z } from "zod";
import { AccessToken } from "livekit-server-sdk";
import { v4 as uuid } from "uuid";
import { config } from "../config";
import { logger } from "../utils/logger";
import { requireBridgeSecret } from "./middleware";
import { ensureWorker } from "../livekit/RoomWorker";
import { registry } from "../SessionRegistry";

export const tokenRouter = Router();

const tokenRequestSchema = z.object({
  roomName: z.string().min(1).max(64).optional(),
  participantName: z.string().min(1).max(64),
  participantIdentity: z.string().min(1).max(64).optional(),
  /** Pass LibreChat conversationId to bind this voice session to a chat thread */
  conversationId: z.string().optional(),
});

tokenRouter.post(
  "/api/token",
  requireBridgeSecret,
  async (req: Request, res: Response) => {
    const parsed = tokenRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.format() });
      return;
    }

    const {
      participantName,
      participantIdentity = uuid(),
      conversationId,
    } = parsed.data;

    // Auto-generate a room name tied to the participant (or conversation)
    const roomName =
      parsed.data.roomName ??
      (conversationId ? `librechat-${conversationId}` : `voice-${uuid()}`);

    logger.info(
      { roomName, participantIdentity, conversationId },
      "Issuing LiveKit token"
    );

    // Issue client token
    const at = new AccessToken(
      config.LIVEKIT_API_KEY,
      config.LIVEKIT_API_SECRET,
      {
        identity: participantIdentity,
        name: participantName,
        ttl: 7200, // 2 hours in seconds
        metadata: conversationId ? JSON.stringify({ conversationId }) : undefined,
      }
    );
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });

    const token = await at.toJwt();

    // Ensure voice bridge is listening in this room
    try {
      await ensureWorker(roomName);
    } catch (err) {
      logger.error({ roomName, err }, "Failed to start room worker");
      // Still return token — client can connect; bridge will retry
    }

    // Return current session ID if already active
    const session = registry.get(roomName);

    res.json({
      token,
      url: config.LIVEKIT_URL,
      roomName,
      sessionId: session?.id ?? null,
      participantIdentity,
    });
  }
);
