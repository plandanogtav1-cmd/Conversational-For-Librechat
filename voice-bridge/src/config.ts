/**
 * config.ts
 * Reads environment variables, validates with Zod, exports a typed singleton.
 * Fail-fast on startup: missing required vars throw immediately.
 */

import { z } from "zod";
import dotenv from "dotenv";
import path from "path";

// Load .env from project root (two levels up from src/)
dotenv.config({ path: path.resolve(__dirname, "../../.env") });
// Also try local .env
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// ─── Schema ──────────────────────────────────────────────────────────────────

const configSchema = z.object({
  // Server
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default("0.0.0.0"),
  BRIDGE_API_SECRET: z.string().min(8),

  // LiveKit
  LIVEKIT_URL: z.string().url(),
  LIVEKIT_API_KEY: z.string().min(1),
  LIVEKIT_API_SECRET: z.string().min(1),

  // Deepgram
  DEEPGRAM_API_KEY: z.string().min(1),
  DEEPGRAM_MODEL: z.string().default("nova-2"),
  DEEPGRAM_LANGUAGE: z.string().default("en-US"),
  DEEPGRAM_ENDPOINTING_MS: z.coerce.number().default(400),

  // LLM
  LLM_BASE_URL: z.string().url(),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default("gpt-4o-mini"),
  LLM_MAX_TOKENS: z.coerce.number().default(1024),
  LLM_TEMPERATURE: z.coerce.number().default(0.7),
  LLM_SYSTEM_PROMPT: z
    .string()
    .default(
      "You are a helpful, concise voice assistant. Keep answers short and conversational."
    ),

  // TTS
  TTS_PROVIDER: z.enum(["piper", "openai", "elevenlabs"]).default("openai"),
  PIPER_URL: z.string().default("http://localhost:5000/synthesize"),
  PIPER_VOICE: z.string().default("en_US-lessac-medium"),
  OPENAI_API_KEY: z.string().default(""),
  OPENAI_TTS_VOICE: z.string().default("alloy"),
  OPENAI_TTS_MODEL: z.string().default("tts-1"),
  ELEVENLABS_API_KEY: z.string().default(""),
  ELEVENLABS_VOICE_ID: z.string().default("21m00Tcm4TlvDq8ikWAM"),
  ELEVENLABS_MODEL: z.string().default("eleven_turbo_v2_5"),

  // Fallback STT
  WHISPER_URL: z.string().default("http://localhost:9000/asr"),
  WHISPER_MODEL: z.string().default("base"),

  // Audio
  STT_SAMPLE_RATE: z.coerce.number().default(16000),
  PLAYBACK_SAMPLE_RATE: z.coerce.number().default(48000),
  VAD_SILENCE_PADDING_MS: z.coerce.number().default(300),

  // Observability
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),
  LOG_JSON: z
    .string()
    .transform((v) => v === "true")
    .default("false"),
  METRICS_PORT: z.coerce.number().optional(),
});

// ─── Parse & export ───────────────────────────────────────────────────────────

const parsed = configSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌  Invalid environment configuration:");
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
