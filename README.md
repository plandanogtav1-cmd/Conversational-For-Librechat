# Conversational-For-LibreChat

A headless, low-latency voice pipeline that adds **ChatGPT-style voice conversations** to [LibreChat](https://github.com/danny-avila/LibreChat).

Built on **LiveKit** (WebRTC transport) · **Deepgram** (streaming STT) · pluggable **TTS** (OpenAI / Piper / ElevenLabs).

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  Browser / LibreChat Client                                         │
│                                                                     │
│  1. POST /api/token  → gets LiveKit JWT                             │
│  2. Joins LiveKit room (WebRTC)                                     │
│  3. Publishes mic track  ──────────────────────────────────┐        │
│  4. Subscribes to assistant audio track  ◄─────────────┐  │        │
│  5. Receives captions via DataChannel    ◄───────────┐  │  │        │
└──────────────────────────────────────────────────────│──│──│────────┘
                                                       │  │  │
                                            LiveKit Room (WebRTC SFU)
                                                       │  │  │
┌──────────────────────────────────────────────────────│──│──│────────┐
│  Voice Bridge (TypeScript / Node)                     │  │  │        │
│                                                       │  │  │        │
│  RoomWorker ─────── subscribes ◄──────────────────────┘  │  │        │
│      │                                                    │  │        │
│      ▼  AudioFrame (48kHz stereo PCM)                     │  │        │
│  webrtcToStt()  →  16kHz mono PCM                         │  │        │
│      │                                                    │  │        │
│      ▼                                                    │  │        │
│  DeepgramAdapter ──── Deepgram Realtime WS                │  │        │
│      │  (interim + final transcripts)                     │  │        │
│      │  [fallback → WhisperAdapter on disconnect]         │  │        │
│      ▼                                                    │  │        │
│  LibreChatClient ─── LibreChat OpenAI-compat API          │  │        │
│      │  (SSE streaming tokens)                            │  │        │
│      │  sentence-boundary buffering ──► onSentence()      │  │        │
│      ▼                                                    │  │        │
│  TTS Adapter ─────── OpenAI / Piper / ElevenLabs          │  │        │
│      │  (48kHz mono PCM chunks)                           │  │        │
│      ▼                                                    │  │        │
│  AudioSource.captureFrame() ──────────────────────────────┘  │        │
│                                                               │        │
│  DataChannel publish (captions, state) ───────────────────────┘        │
│                                                                        │
│  VAD: RMS energy per frame → barge-in detection                        │
│       Cancels TTS + LLM on new speech                                  │
└────────────────────────────────────────────────────────────────────────┘
```

### Latency targets

| Stage | Target | Notes |
|---|---|---|
| mic → interim transcript | < 700 ms | Deepgram streaming |
| mic → final transcript | < 1.5 s | Deepgram endpointing |
| transcript → first LLM token | < 1.2 s | LibreChat SSE |
| first LLM sentence → first audio | < 800 ms | TTS starts at sentence boundary |
| **end-to-end (mic → audio out)** | **< 2.5 s** | Network permitting |

---

## Quick Start

### Prerequisites

- **Node.js 18+**
- API keys: **Deepgram** + **OpenAI** (or LibreChat running locally)
- LiveKit CLI (for demo mode): `winget install LiveKit.LiveKitCLI` (Windows) or `brew install livekit` (Mac)

### 1. Clone and configure

```bash
git clone https://github.com/your-org/conversational-for-librechat
cd conversational-for-librechat
cp .env.example .env
# Edit .env — fill in DEEPGRAM_API_KEY, OPENAI_API_KEY, LLM_BASE_URL etc.
```

### 2. Install dependencies

```bash
cd voice-bridge
npm install
```

### 3. Demo Mode (Windows PowerShell)

```powershell
cd conversational-for-librechat
.\demo\Start-Demo.ps1
```

This opens two terminal windows (LiveKit server + Voice Bridge) and prints curl commands to test every endpoint.

**Flags:**
```powershell
.\demo\Start-Demo.ps1 -BridgePort 8080     # custom port
.\demo\Start-Demo.ps1 -SkipLiveKit         # if LiveKit already running
.\demo\Start-Demo.ps1 -SkipInstall         # if deps already installed
```

### 4. Docker Compose (recommended for teams)

```bash
# Standard (OpenAI TTS, Deepgram STT)
docker compose up

# With local Piper TTS
docker compose --profile piper up

# With Whisper STT fallback
docker compose --profile whisper up
```

---

## API Reference

All endpoints except `/health`, `/ready`, `/metrics` require:
```
Authorization: Bearer <BRIDGE_API_SECRET>
```

### `POST /api/token`

Issue a LiveKit access token for a browser client. Also starts the voice bridge worker in that room.

**Request:**
```json
{
  "participantName": "Alice",
  "roomName": "room-123",          // optional — auto-generated if omitted
  "participantIdentity": "uid-456", // optional
  "conversationId": "librechat-abc" // optional — binds to LibreChat thread
}
```

**Response:**
```json
{
  "token": "<livekit-jwt>",
  "url": "ws://localhost:7880",
  "roomName": "room-123",
  "sessionId": "uuid-of-bridge-session",
  "participantIdentity": "uid-456"
}
```

**Usage in LibreChat:**
1. Call `/api/token` with `Authorization: Bearer <BRIDGE_API_SECRET>`
2. Use `token` + `url` to connect the browser LiveKit SDK to the room
3. Publish mic track; subscribe to assistant audio track
4. Listen on DataChannel for captions and state events

---

### `GET /api/sessions`

List all active bridge sessions.

```json
{
  "count": 1,
  "activeRooms": ["room-123"],
  "sessions": [
    { "sessionId": "uuid", "state": "listening" }
  ]
}
```

### `GET /api/sessions/:roomName`

Get state of a specific session.

```json
{ "sessionId": "uuid", "roomName": "room-123", "state": "speaking" }
```

Session states: `idle` → `listening` → `transcribing` → `thinking` → `speaking` → `listening`

### `POST /api/sessions/:roomName/stop`

Stop and clean up the bridge session for a room.

### `POST /api/sessions/:roomName/interrupt`

Force a barge-in (useful for testing).

### `GET /health`

Liveness probe. No auth required.

```json
{ "status": "ok", "uptime": 42, "activeSessions": 1 }
```

### `GET /ready`

Readiness probe — checks Deepgram, LLM, and TTS reachability.

```json
{
  "ready": true,
  "checks": { "deepgram": "ok", "llm": "ok", "tts_openai": "ok" }
}
```

### `GET /metrics`

Prometheus text metrics for p50/p90/p99 latency per pipeline stage.

---

## DataChannel Events

The voice bridge publishes JSON messages on the LiveKit DataChannel (reliable mode). Browser clients can decode them to show captions and state.

```typescript
type BridgeDataMessage =
  | { type: "transcript_interim"; text: string; speechId: string }
  | { type: "transcript_final";   text: string; speechId: string }
  | { type: "llm_token";          token: string }
  | { type: "llm_complete";       fullText: string }
  | { type: "tts_started";        utteranceId: string }
  | { type: "tts_complete";       utteranceId: string }
  | { type: "state_changed";      state: string }
  | { type: "barge_in" }
  | { type: "error";              message: string };
```

**Example (browser):**
```javascript
room.on(RoomEvent.DataReceived, (payload) => {
  const msg = JSON.parse(new TextDecoder().decode(payload));
  if (msg.type === "transcript_interim") showCaption(msg.text);
  if (msg.type === "state_changed") updateStateUI(msg.state);
});
```

---

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `LIVEKIT_URL` | ✅ | — | LiveKit server WebSocket URL |
| `LIVEKIT_API_KEY` | ✅ | — | LiveKit API key |
| `LIVEKIT_API_SECRET` | ✅ | — | LiveKit API secret |
| `DEEPGRAM_API_KEY` | ✅ | — | Deepgram API key |
| `LLM_BASE_URL` | ✅ | — | LibreChat/OpenAI base URL |
| `LLM_API_KEY` | ✅ | — | LibreChat JWT or OpenAI key |
| `BRIDGE_API_SECRET` | ✅ | — | Secret for bridge HTTP endpoints |
| `TTS_PROVIDER` | | `openai` | `openai` \| `piper` \| `elevenlabs` |
| `OPENAI_API_KEY` | ✅ if openai TTS | — | OpenAI API key |
| `DEEPGRAM_MODEL` | | `nova-2` | Deepgram model |
| `DEEPGRAM_ENDPOINTING_MS` | | `400` | VAD silence before finalising (ms) |
| `LLM_MODEL` | | `gpt-4o-mini` | LLM model name |
| `LLM_SYSTEM_PROMPT` | | built-in | Voice assistant persona |
| `PORT` | | `8080` | HTTP server port |
| `LOG_LEVEL` | | `info` | `trace`/`debug`/`info`/`warn`/`error` |
| `LOG_JSON` | | `false` | Emit JSON logs (for log aggregators) |

See `.env.example` for the complete list including Piper/ElevenLabs/Whisper options.

---

## TTS Providers

| Provider | Latency | Cost | Quality | Notes |
|---|---|---|---|---|
| `openai` | ~300ms | Paid | ⭐⭐⭐⭐ | Default; streams 24kHz PCM |
| `piper` | ~100ms | Free | ⭐⭐⭐ | Local; run via Docker profile |
| `elevenlabs` | ~400ms | Paid | ⭐⭐⭐⭐⭐ | Best quality; streams 44kHz PCM |

---

## STT Fallback

Deepgram is the primary STT. If it disconnects (network issue, quota exceeded), the bridge automatically switches to **faster-whisper** after 5 failed reconnect attempts.

Whisper is non-streaming (buffers full utterance then transcribes), so latency increases to ~1–3s depending on utterance length. Start the Whisper container:

```bash
docker compose --profile whisper up whisper
```

---

## Barge-in

When the user speaks while the assistant is talking:

1. VAD detects RMS energy above threshold in the incoming audio frame
2. Bridge emits `barge_in` event and DataChannel message
3. TTS generator is cancelled (mid-sentence if needed)
4. In-flight LLM HTTP request is aborted
5. Partial LLM response is appended `[interrupted]` in history
6. Session transitions to `transcribing`

---

## Running Tests

```bash
cd voice-bridge
npm test

# With coverage
npm test -- --coverage

# Watch mode
npm run test:watch
```

Tests cover:
- PCM resampling (16kHz ↔ 48kHz, stereo→mono, peak normalization)
- Deepgram adapter (connection, transcripts, reconnect, queueing)
- TTS adapters (sentence splitting, cancel idempotency, factory)
- LibreChat client (SSE streaming, sentence callbacks, cancel, history)

---

## Project Structure

```
conversational-for-librechat/
├── .env.example                  All config variables, documented
├── docker-compose.yml            Full local stack (LiveKit + bridge + Piper + Whisper)
├── demo/
│   └── Start-Demo.ps1            Windows PowerShell launcher
└── voice-bridge/
    ├── src/
    │   ├── index.ts              Express server entry point
    │   ├── config.ts             Zod-validated env config
    │   ├── bridge.ts             VoiceBridgeSession (pipeline orchestrator)
    │   ├── SessionRegistry.ts    Active session store
    │   ├── adapters/
    │   │   ├── stt/
    │   │   │   ├── SttAdapter.ts       Interface + types
    │   │   │   ├── DeepgramAdapter.ts  Primary STT (auto-reconnect)
    │   │   │   ├── WhisperAdapter.ts   Fallback STT
    │   │   │   └── index.ts            Factory + fallback wiring
    │   │   └── tts/
    │   │       ├── TtsAdapter.ts       Interface + types
    │   │       ├── OpenAITtsAdapter.ts 24kHz PCM streaming
    │   │       ├── PiperAdapter.ts     Local TTS (22kHz PCM)
    │   │       ├── ElevenLabsAdapter.ts 44kHz PCM streaming
    │   │       └── index.ts            Factory + sentence splitter
    │   ├── audio/
    │   │   └── resampler.ts      Pure-Node PCM resampling utilities
    │   ├── llm/
    │   │   └── LibreChatClient.ts SSE streaming LLM, history, sentence callbacks
    │   ├── livekit/
    │   │   └── RoomWorker.ts     LiveKit room participant + DataChannel
    │   ├── routes/
    │   │   ├── token.ts          POST /api/token
    │   │   ├── sessions.ts       GET/POST /api/sessions/*
    │   │   ├── health.ts         /health  /ready  /metrics
    │   │   └── middleware.ts     Bearer auth
    │   └── utils/
    │       ├── logger.ts         Pino logger
    │       └── metrics.ts        Latency tracker + Prometheus
    ├── tests/
    │   ├── resampler.test.ts
    │   ├── DeepgramAdapter.test.ts
    │   ├── TtsAdapters.test.ts
    │   └── LibreChatClient.test.ts
    ├── Dockerfile
    ├── package.json
    └── tsconfig.json
```

---

## LibreChat Integration

To wire this bridge into LibreChat's client:

1. Add `BRIDGE_URL` and `BRIDGE_API_SECRET` to LibreChat's environment
2. In LibreChat's voice button handler, call `POST {BRIDGE_URL}/api/token`
3. Use the returned `token` + `url` with the [LiveKit JS SDK](https://docs.livekit.io/realtime/client/connect/) to join the room
4. Publish mic track; subscribe to the `assistant-audio` track
5. Listen to DataChannel for captions / state

This milestone delivers the **server-side headless pipeline**. The client-side LiveKit integration is the next milestone.
