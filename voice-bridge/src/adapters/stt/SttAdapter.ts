/**
 * adapters/stt/SttAdapter.ts
 * Abstract contract every STT adapter must implement.
 */

import { EventEmitter } from "events";

export interface SttTranscript {
  /** Unique identifier for this speech segment */
  speechId: string;
  /** Text content of the transcript */
  text: string;
  /** True = confirmed final; false = still streaming (interim) */
  isFinal: boolean;
  /** Confidence score 0–1, if available */
  confidence?: number;
  /** Wall-clock time when transcript was received */
  receivedAt: number;
}

export interface SttEvents {
  /** Fired for both interim and final transcripts */
  transcript: (t: SttTranscript) => void;
  /** Fired when a speech segment is fully finalised */
  final: (t: SttTranscript) => void;
  /** Fired on recoverable error; adapter should attempt reconnect */
  error: (err: Error) => void;
  /** Fired when the adapter closes cleanly */
  close: () => void;
}

/**
 * SttAdapter — streaming speech-to-text.
 *
 * Call `sendAudio(pcm16Buffer)` with 16 kHz mono int16 PCM.
 * Listen to `transcript` events for interim results.
 * Listen to `final` events for end-of-turn text.
 */
export interface SttAdapter extends EventEmitter {
  /** Connect to the upstream STT service. */
  connect(): Promise<void>;

  /**
   * Push raw 16 kHz mono int16 PCM audio into the STT stream.
   * Implementations must handle backpressure internally.
   */
  sendAudio(pcm16: Buffer): void;

  /** Flush any buffered audio and signal end-of-speech to the service. */
  flush(): Promise<void>;

  /** Tear down the connection cleanly. */
  close(): Promise<void>;

  /** Whether the adapter is currently connected and healthy. */
  readonly isConnected: boolean;

  on<K extends keyof SttEvents>(event: K, listener: SttEvents[K]): this;
  emit<K extends keyof SttEvents>(event: K, ...args: Parameters<SttEvents[K]>): boolean;
}
