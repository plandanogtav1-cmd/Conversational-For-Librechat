/**
 * bridge.ts
 *
 * VoiceBridgeSession — one instance per LiveKit room participant.
 *
 * Orchestrates the full pipeline:
 *   LiveKit audio track
 *     → 16 kHz mono PCM
 *     → STT (Deepgram / Whisper fallback)
 *     → LibreChat LLM (streaming, sentence-boundary buffering)
 *     → TTS (sentence chunks → 48 kHz PCM)
 *     → LiveKit audio track publish
 *
 * Barge-in:
 *   When VAD detects new speech while TTS is playing, we:
 *   1. Cancel the TTS generator
 *   2. Cancel the in-flight LLM request
 *   3. Stop publishing audio
 *   4. Start a fresh STT segment
 *
 * State machine:
 *   idle → listening → transcribing → thinking → speaking → idle
 */

import { EventEmitter } from "events";
import {
  Room,
  RoomEvent,
  RemoteParticipant,
  RemoteTrackPublication,
  RemoteTrack,
  Track,
  AudioFrame,
  LocalAudioTrack,
  AudioSource,
  TrackPublishOptions,
  TrackSource,
} from "@livekit/rtc-node";
import { v4 as uuid } from "uuid";
import { config } from "./config";
import { logger } from "./utils/logger";
import { metrics } from "./utils/metrics";
import { webrtcToStt } from "./audio/resampler";
import { createSttAdapter, createWhisperAdapter } from "./adapters/stt";
import { createTtsAdapter } from "./adapters/tts";
import { LibreChatClient } from "./llm/LibreChatClient";
import type { SttAdapter, SttTranscript } from "./adapters/stt/SttAdapter";
import type { TtsAdapter } from "./adapters/tts/TtsAdapter";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SessionState =
  | "idle"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking";

export interface SessionEvents {
  state_changed: (prev: SessionState, next: SessionState) => void;
  transcript_interim: (text: string, speechId: string) => void;
  transcript_final: (text: string, speechId: string) => void;
  llm_token: (token: string) => void;
  llm_complete: (fullText: string) => void;
  tts_started: (utteranceId: string) => void;
  tts_complete: (utteranceId: string) => void;
  barge_in: () => void;
  error: (err: Error) => void;
  closed: () => void;
}

export interface BridgeSessionOptions {
  room: Room;
  roomName: string;
  participantIdentity: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Minimum text length before we send to TTS (avoid "Hmm.", "OK." alone)
const MIN_TTS_LENGTH = 8;
// Silence threshold: frames below this RMS are treated as silence for VAD
const VAD_RMS_THRESHOLD = 150;
// How many consecutive silent frames before we consider speech ended
const VAD_SILENCE_FRAMES = Math.ceil(
  (config.VAD_SILENCE_PADDING_MS / 1000) * (config.PLAYBACK_SAMPLE_RATE / 480)
);
// Audio frame size LiveKit uses (10ms at 48kHz = 480 samples)
const FRAME_SAMPLES = 480;

// ─── Session ─────────────────────────────────────────────────────────────────

export class VoiceBridgeSession extends EventEmitter {
  readonly id: string;
  private state: SessionState = "idle";
  private room: Room;
  private roomName: string;
  private participantIdentity: string;

  private sttAdapter: SttAdapter | null = null;
  private ttsAdapter: TtsAdapter;
  private llmClient: LibreChatClient;

  private audioSource: AudioSource | null = null;
  private localAudioTrack: LocalAudioTrack | null = null;
  private isTtsPlaying = false;
  private isCancelling = false;

  // VAD state
  private silentFrameCount = 0;
  private speechStartedAt: number | null = null;
  private currentSpeechId: string | null = null;

  // Barge-in detection: track when we start speaking
  private ttsStartedAt: number | null = null;

  constructor(opts: BridgeSessionOptions) {
    super();
    this.id = uuid();
    this.room = opts.room;
    this.roomName = opts.roomName;
    this.participantIdentity = opts.participantIdentity;
    this.ttsAdapter = createTtsAdapter();
    this.llmClient = new LibreChatClient(this.id);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    logger.info(
      { sessionId: this.id, room: this.roomName },
      "Starting voice bridge session"
    );

    // Set up STT
    this.sttAdapter = await createSttAdapter();
    this._wireSttEvents(this.sttAdapter);

    // Listen for fallback signal from Deepgram adapter
    (this.sttAdapter as EventEmitter).on(
      "fallback_requested",
      this._handleSttFallback.bind(this)
    );

    // Set up LiveKit audio output (assistant voice)
    this.audioSource = new AudioSource(
      config.PLAYBACK_SAMPLE_RATE,
      1 // mono
    );
    this.localAudioTrack = LocalAudioTrack.createAudioTrack(
      "assistant-audio",
      this.audioSource
    );

    const publishOpts = new TrackPublishOptions();
    publishOpts.source = TrackSource.SOURCE_MICROPHONE;

    await this.room.localParticipant?.publishTrack(
      this.localAudioTrack,
      publishOpts
    );

    // Subscribe to remote audio tracks
    this.room.on(RoomEvent.TrackSubscribed, this._onTrackSubscribed.bind(this));

    // Also handle already-subscribed tracks
    for (const [, participant] of this.room.remoteParticipants) {
      for (const [, pub] of participant.trackPublications) {
        if (
          pub.kind === Track.Kind.Audio &&
          pub.track !== undefined &&
          pub.track !== null
        ) {
          await this._subscribeToAudioTrack(pub.track as RemoteTrack);
        }
      }
    }

    this._setState("listening");
    logger.info({ sessionId: this.id }, "Voice bridge session ready");
  }

  async stop(): Promise<void> {
    logger.info({ sessionId: this.id }, "Stopping voice bridge session");

    this._cancelInFlight();

    if (this.sttAdapter) {
      await this.sttAdapter.close();
      this.sttAdapter = null;
    }

    if (this.localAudioTrack) {
      await this.room.localParticipant?.unpublishTrack(this.localAudioTrack);
      this.localAudioTrack = null;
    }

    this.audioSource = null;
    this._setState("idle");
    this.emit("closed");
  }

  getState(): SessionState {
    return this.state;
  }

  // ── Track subscription ──────────────────────────────────────────────────────

  private _onTrackSubscribed(
    track: RemoteTrack,
    _pub: RemoteTrackPublication,
    _participant: RemoteParticipant
  ): void {
    if (track.kind === Track.Kind.Audio) {
      void this._subscribeToAudioTrack(track);
    }
  }

  private async _subscribeToAudioTrack(track: RemoteTrack): Promise<void> {
    logger.debug({ sessionId: this.id }, "Subscribed to remote audio track");

    // Receive audio frames from LiveKit
    track.on("audioFrameReceived" as never, (frame: AudioFrame) => {
      this._onAudioFrame(frame);
    });
  }

  // ── Audio frame processing (hot path) ────────────────────────────────────

  private _onAudioFrame(frame: AudioFrame): void {
    if (!this.sttAdapter) return;

    // Convert to Buffer from Int16Array
    const pcm48k = Buffer.from(
      frame.data.buffer,
      frame.data.byteOffset,
      frame.data.byteLength
    );

    // Basic VAD: compute RMS energy
    const rms = this._computeRms(frame.data);
    const isSpeech = rms > VAD_RMS_THRESHOLD;

    if (isSpeech) {
      this.silentFrameCount = 0;

      if (this.speechStartedAt === null) {
        // New speech segment started
        this.speechStartedAt = Date.now();
        this.currentSpeechId = uuid();

        // Barge-in: if TTS is playing, interrupt it
        if (this.isTtsPlaying) {
          this._handleBargeIn();
        } else if (this.state === "listening") {
          this._setState("transcribing");
        }

        metrics.start("stt_interim", this.id);
        metrics.start("stt_final", this.id);
        metrics.start("e2e", this.id);
      }

      // Downsample 48kHz stereo (or mono) → 16kHz mono for STT
      const pcm16 = webrtcToStt(pcm48k);
      this.sttAdapter.sendAudio(pcm16);
    } else {
      if (this.speechStartedAt !== null) {
        this.silentFrameCount++;

        // Still send audio during short pauses (Deepgram handles endpointing)
        const pcm16 = webrtcToStt(pcm48k);
        this.sttAdapter.sendAudio(pcm16);

        if (this.silentFrameCount >= VAD_SILENCE_FRAMES) {
          // Speech ended — flush STT
          this.speechStartedAt = null;
          this.silentFrameCount = 0;
          void this.sttAdapter.flush();
        }
      }
    }
  }

  private _computeRms(samples: Int16Array): number {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] ?? 0;
      sum += s * s;
    }
    return Math.sqrt(sum / Math.max(samples.length, 1));
  }

  // ── STT event wiring ─────────────────────────────────────────────────────

  private _wireSttEvents(adapter: SttAdapter): void {
    adapter.on("transcript", (t: SttTranscript) => {
      if (!t.isFinal) {
        metrics.end("stt_interim", this.id);
        metrics.start("stt_interim", this.id); // reset for next interim
        this.emit("transcript_interim", t.text, t.speechId);
      }
    });

    adapter.on("final", (t: SttTranscript) => {
      metrics.end("stt_final", this.id);

      if (!t.text.trim() || this.isCancelling) return;

      this.emit("transcript_final", t.text, t.speechId);
      logger.info(
        { sessionId: this.id, text: t.text },
        "Final transcript received"
      );

      void this._handleFinalTranscript(t.text);
    });

    adapter.on("error", (err: Error) => {
      logger.error({ sessionId: this.id, err }, "STT error");
      this.emit("error", err);
    });
  }

  // ── Pipeline: transcript → LLM → TTS ─────────────────────────────────────

  private async _handleFinalTranscript(text: string): Promise<void> {
    if (this.state === "speaking") {
      // Mid-speech final — barge-in was already triggered by VAD
      // but transcript arrived; still process it
    }

    this._setState("thinking");
    metrics.start("llm_first", this.id);
    metrics.start("llm_complete", this.id);

    // TTS sentence queue — we pipeline LLM streaming with TTS
    const sentenceQueue: string[] = [];
    let ttsRunning = false;
    let llmDone = false;

    const processSentenceQueue = async () => {
      if (ttsRunning) return;
      ttsRunning = true;

      while (sentenceQueue.length > 0 || !llmDone) {
        if (sentenceQueue.length === 0) {
          // Wait briefly for next sentence
          await new Promise((r) => setTimeout(r, 20));
          continue;
        }

        const sentence = sentenceQueue.shift()!;
        if (sentence.length < MIN_TTS_LENGTH) continue;

        await this._speakSentence(sentence);

        if (this.isCancelling) break;
      }

      ttsRunning = false;
    };

    let firstToken = true;
    let firstSentence = true;

    await this.llmClient.streamResponse(text, {
      onToken: (token) => {
        if (firstToken) {
          metrics.end("llm_first", this.id);
          firstToken = false;
          metrics.start("tts_first", this.id);
        }
        this.emit("llm_token", token);
      },

      onSentence: (sentence) => {
        if (this.isCancelling) return;
        sentenceQueue.push(sentence);

        if (firstSentence) {
          firstSentence = false;
          this._setState("speaking");
          void processSentenceQueue();
        }
      },

      onComplete: (fullText) => {
        metrics.end("llm_complete", this.id);
        llmDone = true;
        this.emit("llm_complete", fullText);
        logger.debug(
          { sessionId: this.id, chars: fullText.length },
          "LLM complete"
        );
      },

      onError: (err) => {
        llmDone = true;
        logger.error({ sessionId: this.id, err }, "LLM error");
        this.emit("error", err);
        this._setState("listening");
      },
    });

    // Wait for TTS queue to drain
    while (ttsRunning) {
      await new Promise((r) => setTimeout(r, 20));
    }

    if (!this.isCancelling) {
      metrics.end("tts_complete", this.id);
      metrics.end("e2e", this.id);
      this._setState("listening");
    }
  }

  // ── TTS playback ─────────────────────────────────────────────────────────

  private async _speakSentence(sentence: string): Promise<void> {
    if (this.isCancelling || !this.audioSource) return;

    const utteranceId = uuid();
    this.isTtsPlaying = true;
    this.ttsStartedAt = Date.now();
    this.emit("tts_started", utteranceId);

    // Create a fresh TTS adapter per sentence for clean cancel semantics
    const tts = createTtsAdapter();

    logger.debug(
      { sessionId: this.id, utteranceId, sentence: sentence.slice(0, 60) },
      "Speaking sentence"
    );

    try {
      let isFirstChunk = true;
      for await (const chunk of tts.synthesizeStream(sentence)) {
        if (this.isCancelling) {
          tts.cancel();
          break;
        }
        if (chunk.pcm48k.length === 0) continue;

        if (isFirstChunk) {
          metrics.end("tts_first", this.id);
          isFirstChunk = false;
        }

        await this._publishPcmChunk(chunk.pcm48k);
      }
    } catch (err) {
      logger.error({ sessionId: this.id, utteranceId, err }, "TTS error");
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    } finally {
      this.isTtsPlaying = false;
      this.ttsStartedAt = null;
      this.emit("tts_complete", utteranceId);
    }
  }

  /**
   * Publish a 48 kHz mono int16 PCM buffer as an AudioFrame to LiveKit.
   * Slices the buffer into 10 ms frames (480 samples).
   */
  private async _publishPcmChunk(pcm48k: Buffer): Promise<void> {
    if (!this.audioSource) return;

    const bytesPerFrame = FRAME_SAMPLES * 2; // 2 bytes per int16

    for (let offset = 0; offset + bytesPerFrame <= pcm48k.length; offset += bytesPerFrame) {
      if (this.isCancelling) break;

      const slice = pcm48k.subarray(offset, offset + bytesPerFrame);
      const samples = new Int16Array(
        slice.buffer,
        slice.byteOffset,
        FRAME_SAMPLES
      );

      const frame = new AudioFrame(
        samples,
        config.PLAYBACK_SAMPLE_RATE,
        1,
        FRAME_SAMPLES
      );

      await this.audioSource.captureFrame(frame);
    }
  }

  // ── Barge-in ─────────────────────────────────────────────────────────────

  private _handleBargeIn(): void {
    logger.info({ sessionId: this.id }, "Barge-in detected — interrupting");
    this.emit("barge_in");
    this._cancelInFlight();
    this._setState("transcribing");
  }

  private _cancelInFlight(): void {
    this.isCancelling = true;
    this.isTtsPlaying = false;
    this.ttsAdapter.cancel();
    this.llmClient.cancel();
    // Allow new pipeline after a tick
    setTimeout(() => {
      this.isCancelling = false;
    }, 50);
  }

  // ── STT fallback ─────────────────────────────────────────────────────────

  private async _handleSttFallback(): Promise<void> {
    logger.warn(
      { sessionId: this.id },
      "Switching STT from Deepgram → Whisper"
    );
    const old = this.sttAdapter;
    const whisper = await createWhisperAdapter();
    this._wireSttEvents(whisper);
    this.sttAdapter = whisper;
    if (old) await old.close();
  }

  // ── State machine ─────────────────────────────────────────────────────────

  private _setState(next: SessionState): void {
    if (this.state === next) return;
    const prev = this.state;
    this.state = next;
    logger.debug({ sessionId: this.id, prev, next }, "Session state →");
    this.emit("state_changed", prev, next);
  }
}
