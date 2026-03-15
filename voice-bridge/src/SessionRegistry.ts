/**
 * SessionRegistry.ts
 *
 * In-process store of active VoiceBridgeSessions keyed by room name.
 * Thread-safe for Node's single-threaded event loop.
 */

import { VoiceBridgeSession } from "./bridge";
import { logger } from "./utils/logger";

export class SessionRegistry {
  private sessions = new Map<string, VoiceBridgeSession>();

  register(roomName: string, session: VoiceBridgeSession): void {
    this.sessions.set(roomName, session);
    logger.info({ roomName, sessionId: session.id }, "Session registered");
  }

  get(roomName: string): VoiceBridgeSession | undefined {
    return this.sessions.get(roomName);
  }

  remove(roomName: string): void {
    const session = this.sessions.get(roomName);
    if (session) {
      this.sessions.delete(roomName);
      logger.info({ roomName, sessionId: session.id }, "Session removed");
    }
  }

  getAll(): VoiceBridgeSession[] {
    return Array.from(this.sessions.values());
  }

  get size(): number {
    return this.sessions.size;
  }
}

// Singleton
export const registry = new SessionRegistry();
