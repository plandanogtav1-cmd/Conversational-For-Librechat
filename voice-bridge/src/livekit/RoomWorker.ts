/**
 * livekit/RoomWorker.ts
 *
 * Manages the lifecycle of a LiveKit room connection for the voice bridge.
 *
 * Responsibilities:
 * - Connect to LiveKit as a server-side participant
 * - Instantiate and start a VoiceBridgeSession when a user joins
 * - Clean up on room empty / disconnect
 * - Publish session events back over the DataChannel (captions etc.)
 */

import {
  Room,
  RoomEvent,
  RoomOptions,
  DataPacketKind,
  RemoteParticipant,
} from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import { config } from "../config";
import { logger } from "../utils/logger";
import { registry } from "../SessionRegistry";
import { VoiceBridgeSession } from "../bridge";

// ─── Data channel message types (sent to browser clients) ───────────────────

export type BridgeDataMessage =
  | { type: "transcript_interim"; text: string; speechId: string }
  | { type: "transcript_final"; text: string; speechId: string }
  | { type: "llm_token"; token: string }
  | { type: "llm_complete"; fullText: string }
  | { type: "tts_started"; utteranceId: string }
  | { type: "tts_complete"; utteranceId: string }
  | { type: "state_changed"; state: string }
  | { type: "barge_in" }
  | { type: "error"; message: string };

// ─── Worker ───────────────────────────────────────────────────────────────────

export class RoomWorker {
  private room: Room | null = null;
  private session: VoiceBridgeSession | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(
    private readonly roomName: string,
    private readonly workerIdentity = `voice-bridge-${Date.now()}`
  ) {}

  async connect(): Promise<void> {
    logger.info({ room: this.roomName }, "RoomWorker connecting…");

    const token = await this._generateToken();

    const roomOpts = new RoomOptions();

    const room = new Room(roomOpts);
    this.room = room;

    // Wire room-level events
    room.on(RoomEvent.Connected, () => {
      logger.info({ room: this.roomName }, "LiveKit room connected");
      void this._startSession(room);
    });

    room.on(RoomEvent.Disconnected, () => {
      logger.warn({ room: this.roomName }, "LiveKit room disconnected");
      void this._teardownSession();
      if (!this.stopping) this._scheduleReconnect();
    });

    room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => {
      logger.info(
        { room: this.roomName, participant: participant.identity },
        "Participant joined"
      );
    });

    room.on(RoomEvent.ParticipantDisconnected, (participant: RemoteParticipant) => {
      logger.info(
        { room: this.roomName, participant: participant.identity },
        "Participant left"
      );
      // If room is now empty of human participants, optionally clean up
      if (room.remoteParticipants.size === 0) {
        logger.info({ room: this.roomName }, "Room empty — idling session");
      }
    });

    await room.connect(config.LIVEKIT_URL, token);
  }

  async disconnect(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    await this._teardownSession();
    if (this.room) {
      await this.room.disconnect();
      this.room = null;
    }
  }

  // ── Session lifecycle ───────────────────────────────────────────────────

  private async _startSession(room: Room): Promise<void> {
    if (this.session) {
      await this.session.stop();
    }

    const session = new VoiceBridgeSession({
      room,
      roomName: this.roomName,
      participantIdentity: this.workerIdentity,
    });

    // Forward session events → LiveKit DataChannel so browser clients
    // can show captions and state without polling REST
    session.on("transcript_interim", (text, speechId) => {
      void this._publishData({
        type: "transcript_interim",
        text,
        speechId,
      });
    });

    session.on("transcript_final", (text, speechId) => {
      void this._publishData({ type: "transcript_final", text, speechId });
    });

    session.on("llm_token", (token) => {
      void this._publishData({ type: "llm_token", token });
    });

    session.on("llm_complete", (fullText) => {
      void this._publishData({ type: "llm_complete", fullText });
    });

    session.on("tts_started", (utteranceId) => {
      void this._publishData({ type: "tts_started", utteranceId });
    });

    session.on("tts_complete", (utteranceId) => {
      void this._publishData({ type: "tts_complete", utteranceId });
    });

    session.on("state_changed", (_prev, next) => {
      void this._publishData({ type: "state_changed", state: next });
    });

    session.on("barge_in", () => {
      void this._publishData({ type: "barge_in" });
    });

    session.on("error", (err) => {
      void this._publishData({ type: "error", message: err.message });
    });

    session.on("closed", () => {
      registry.remove(this.roomName);
      this.session = null;
    });

    registry.register(this.roomName, session);
    this.session = session;

    await session.start();
  }

  private async _teardownSession(): Promise<void> {
    if (this.session) {
      await this.session.stop();
      registry.remove(this.roomName);
      this.session = null;
    }
  }

  // ── DataChannel publish ──────────────────────────────────────────────────

  private async _publishData(msg: BridgeDataMessage): Promise<void> {
    if (!this.room) return;
    try {
      const payload = Buffer.from(JSON.stringify(msg));
      await this.room.localParticipant?.publishData(
        payload,
        DataPacketKind.RELIABLE
      );
    } catch (err) {
      logger.debug({ err }, "DataChannel publish failed (non-fatal)");
    }
  }

  // ── Token generation ─────────────────────────────────────────────────────

  private async _generateToken(): Promise<string> {
    const at = new AccessToken(
      config.LIVEKIT_API_KEY,
      config.LIVEKIT_API_SECRET,
      {
        identity: this.workerIdentity,
        name: "Voice Bridge",
        ttl: 86400, // 24 hours in seconds
      }
    );
    at.addGrant({
      roomJoin: true,
      room: this.roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    });
    return await at.toJwt();
  }

  // ── Reconnect ────────────────────────────────────────────────────────────

  private _scheduleReconnect(): void {
    logger.info({ room: this.roomName }, "Scheduling reconnect in 3s…");
    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, 3000);
  }
}

// ─── Worker pool ─────────────────────────────────────────────────────────────

const workers = new Map<string, RoomWorker>();

export async function ensureWorker(roomName: string): Promise<RoomWorker> {
  if (workers.has(roomName)) {
    return workers.get(roomName)!;
  }
  const worker = new RoomWorker(roomName);
  workers.set(roomName, worker);
  await worker.connect();
  return worker;
}

export async function stopWorker(roomName: string): Promise<void> {
  const worker = workers.get(roomName);
  if (worker) {
    await worker.disconnect();
    workers.delete(roomName);
  }
}

export function listWorkers(): string[] {
  return Array.from(workers.keys());
}
