# LibreChat Integration Guide
### Conversational-For-LibreChat — Voice Bridge Setup

This guide covers how to connect the voice bridge to **any LibreChat installation** —
local Docker (the most common setup) or a cloud-hosted instance.

> **What this adds vs. LibreChat's built-in speech tab**
> LibreChat already ships a speech tab that does turn-by-turn STT → text → TTS.
> This bridge adds **real-time, full-duplex, barge-in-capable** voice conversation
> over WebRTC — the same model as ChatGPT's Advanced Voice Mode. Both can exist
> side-by-side; they don't conflict.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| LibreChat running (Docker or cloud) | Any recent version |
| Docker + Docker Compose | For the voice bridge services |
| Deepgram API key | https://console.deepgram.com |
| OpenAI API key **or** LibreChat API access | For LLM + TTS |
| LiveKit CLI (demo mode only) | `winget install LiveKit.LiveKitCLI` (Windows) / `brew install livekit` (Mac/Linux) |

---

## Part 1 — Understand the Topology

```
┌─────────────────────────────────────────────────────────────┐
│  LibreChat  (port 3080)                                      │
│    └─ OpenAI-compatible API  →  /api/chat/completions       │
└────────────────────────────┬────────────────────────────────┘
                             │  HTTP (LLM calls)
┌────────────────────────────▼────────────────────────────────┐
│  Voice Bridge  (port 8080)                                   │
│    ├─ POST /api/token    ← LibreChat frontend calls this     │
│    ├─ GET  /api/sessions                                     │
│    └─ GET  /health                                           │
└────────────────────────────┬────────────────────────────────┘
                             │  WebSocket
┌────────────────────────────▼────────────────────────────────┐
│  LiveKit Server  (port 7880)                                 │
│    └─ WebRTC room — mic in / assistant audio out            │
└─────────────────────────────────────────────────────────────┘
```

The voice bridge sits **between** LibreChat and the browser.
LibreChat's existing chat UI and persistence are untouched.

---

## Part 2 — Configure the Voice Bridge

### Step 1: Copy and fill in `.env`

```bash
cd conversational-for-librechat
cp .env.example .env
```

Open `.env` and set these values. Everything else can stay as the default.

#### If LibreChat is running locally via Docker

```env
# ── LLM: point at your local LibreChat ──────────────────────
LLM_BASE_URL=http://host.docker.internal:3080/api
# OR if running on Linux (host.docker.internal may not resolve):
# LLM_BASE_URL=http://172.17.0.1:3080/api

# Your LibreChat user JWT token — see "Getting your JWT token" below
LLM_API_KEY=your_librechat_jwt_token

# ── OR: skip LibreChat and call OpenAI directly ──────────────
# LLM_BASE_URL=https://api.openai.com/v1
# LLM_API_KEY=sk-...

LLM_MODEL=gpt-4o-mini

# ── Deepgram ─────────────────────────────────────────────────
DEEPGRAM_API_KEY=your_deepgram_key

# ── TTS ──────────────────────────────────────────────────────
TTS_PROVIDER=openai
OPENAI_API_KEY=your_openai_key

# ── LiveKit (local dev) ───────────────────────────────────────
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=devsecret

# ── Bridge security ───────────────────────────────────────────
BRIDGE_API_SECRET=make_this_long_and_random_32chars
```

#### If LibreChat is running on the cloud

```env
LLM_BASE_URL=https://your-librechat-domain.com/api
LLM_API_KEY=your_librechat_jwt_token
LLM_MODEL=gpt-4o-mini

DEEPGRAM_API_KEY=your_deepgram_key

TTS_PROVIDER=openai
OPENAI_API_KEY=your_openai_key

# Point at your deployed LiveKit Cloud project
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=your_livekit_key
LIVEKIT_API_SECRET=your_livekit_secret

BRIDGE_API_SECRET=make_this_long_and_random_32chars
```

---

### Getting your LibreChat JWT token

The bridge calls LibreChat on your behalf. It needs a valid user token.

**Method A — Copy from browser (quickest for dev)**

1. Open LibreChat in your browser and log in
2. Open DevTools → Application → Local Storage → `http://localhost:3080`
3. Find the key named `token` — copy its value
4. Paste it as `LLM_API_KEY=` in your `.env`

> ⚠️ JWT tokens expire (typically 7 days). For production, use Method B.

**Method B — Use OpenAI directly (most reliable)**

If your LibreChat is configured to use OpenAI, just point the bridge
directly at OpenAI instead:

```env
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=sk-your-openai-key
```

This bypasses LibreChat for the LLM step but is fully compatible with the
bridge — conversation history is managed by the bridge itself.

---

## Part 3 — Run the Voice Bridge

### Option A: Demo mode (Windows, no Docker needed for the bridge)

```powershell
# Start LiveKit + bridge in separate terminal windows
.\demo\Start-Demo.ps1
```

The script prints a health check URL and ready curl commands when everything is up.

### Option B: Docker Compose (recommended)

```bash
# From conversational-for-librechat/
docker compose up -d
```

To verify it started:
```bash
curl http://localhost:8080/health
# Expected: {"status":"ok","uptime":5,"activeSessions":0}

curl http://localhost:8080/ready
# Expected: {"ready":true,"checks":{"deepgram":"ok","llm":"ok","tts_openai":"ok"}}
```

### Option C: Add the bridge INTO LibreChat's Docker Compose (advanced)

If you want a single `docker compose up` to start everything, add the bridge
as a service inside LibreChat's `docker-compose.override.yml`.

In your **LibreChat folder**, create or edit `docker-compose.override.yml`:

```yaml
version: '3.4'

services:
  # Mount your librechat.yaml config (required for speech config below)
  api:
    volumes:
      - ./librechat.yaml:/app/librechat.yaml
    environment:
      # Optional: tell LibreChat where the voice bridge lives
      VOICE_BRIDGE_URL: http://voice-bridge:8080
      VOICE_BRIDGE_SECRET: your_bridge_api_secret

  # LiveKit server
  livekit:
    image: livekit/livekit-server:latest
    command: --dev --bind 0.0.0.0
    ports:
      - "7880:7880"
      - "7881:7881"
      - "50100-50200:50100-50200/udp"
    environment:
      - LIVEKIT_KEYS=devkey:devsecret
    networks:
      - default

  # Voice bridge
  voice-bridge:
    image: node:20-slim
    working_dir: /app
    volumes:
      - ../conversational-for-librechat/voice-bridge:/app
      - ../conversational-for-librechat/.env:/app/.env
    command: sh -c "npm install && npm run dev"
    ports:
      - "8080:8080"
    environment:
      LIVEKIT_URL: ws://livekit:7880
      # LLM points to the LibreChat api service on the same Docker network
      LLM_BASE_URL: http://api:3080/api
    depends_on:
      - api
      - livekit
    networks:
      - default
```

Then start everything from your LibreChat folder:
```bash
docker compose up -d
```

---

## Part 4 — Configure LibreChat's `librechat.yaml`

This step enables LibreChat's **built-in** speech tab and sets sensible
defaults. It is **separate** from the voice bridge — think of it as
configuring the fallback/alternative STT-TTS for the text chat interface.

### Where is `librechat.yaml`?

- **Local Docker**: create it at the root of your LibreChat folder
  (same level as `docker-compose.yml`), then mount it via `docker-compose.override.yml` (shown above)
- **Cloud / non-Docker**: place it wherever `CONFIG_PATH` points in your `.env`,
  or in the project root

### Minimal `librechat.yaml` for speech

Add (or merge into your existing file):

```yaml
version: 1.2.9
cache: true

speech:
  tts:
    openai:
      apiKey: "${OPENAI_API_KEY}"
      model: "tts-1"
      voices: ["alloy", "echo", "fable", "onyx", "nova", "shimmer"]

  stt:
    openai:
      apiKey: "${OPENAI_API_KEY}"
      model: "whisper-1"

  speechTab:
    conversationMode: true        # enable push-to-talk / auto mode in UI
    advancedMode: false
    speechToText:
      engineSTT: "openai"
      autoTranscribeAudio: true
      decibelValue: -45           # mic sensitivity — lower = more sensitive
      autoSendText: 0             # 0 = don't auto-send, user presses send
    textToSpeech:
      engineTTS: "openai"
      voice: "echo"
      automaticPlayback: false    # set true for hands-free mode
      playbackRate: 1.0
      cacheTTS: true
```

After editing `librechat.yaml`:

```bash
# Docker: restart the api container to pick up changes
docker compose restart api
```

---

## Part 5 — Test the Voice Bridge

### 1. Health check
```bash
curl http://localhost:8080/health
```

### 2. Readiness check (verifies Deepgram + LLM are reachable)
```bash
curl http://localhost:8080/ready
```

### 3. Issue a LiveKit token and start a session
```bash
curl -X POST http://localhost:8080/api/token \
  -H "Authorization: Bearer your_bridge_api_secret" \
  -H "Content-Type: application/json" \
  -d '{"participantName":"test-user","roomName":"demo-room"}'
```

Expected response:
```json
{
  "token": "<livekit-jwt>",
  "url": "ws://localhost:7880",
  "roomName": "demo-room",
  "sessionId": "some-uuid",
  "participantIdentity": "some-uuid"
}
```

### 4. Test in the LiveKit Playground (no frontend needed)

1. Go to https://agents-playground.livekit.io/
2. Enter your LiveKit server URL: `ws://localhost:7880`
3. Enter API Key: `devkey` / Secret: `devsecret`
4. Click Connect — the bridge will join automatically and you can talk to it

### 5. Check session state
```bash
curl http://localhost:8080/api/sessions \
  -H "Authorization: Bearer your_bridge_api_secret"
```

---

## Part 6 — How a LibreChat Client Connects (for developers)

When LibreChat's frontend wants to open a voice session, it does this:

```
1. Frontend  →  POST /api/token  (with Authorization: Bearer <BRIDGE_API_SECRET>)
                Body: { participantName, roomName, conversationId }

2. Bridge returns: { token, url, roomName, sessionId }

3. Frontend uses LiveKit JS SDK to join the room:
     const room = new Room()
     await room.connect(url, token)
     await room.localParticipant.setMicrophoneEnabled(true)

4. Bridge auto-joins the room as server participant
   and starts the STT → LLM → TTS pipeline

5. Frontend listens for DataChannel messages (captions, state):
     room.on(RoomEvent.DataReceived, (payload) => {
       const msg = JSON.parse(new TextDecoder().decode(payload))
       // msg.type = "transcript_interim" | "transcript_final" |
       //            "state_changed" | "barge_in" | "llm_complete"
     })

6. Assistant audio plays automatically via the subscribed audio track
```

The `conversationId` field links the voice session to an existing
LibreChat thread, so the conversation history stays in sync.

---

## Part 7 — Connecting to LibreChat Cloud Deployments

If LibreChat is deployed on a VPS / cloud server:

### Voice bridge on the same server

```env
LLM_BASE_URL=http://localhost:3080/api   # same machine, no TLS needed
LIVEKIT_URL=ws://localhost:7880
```

Expose only port 8080 externally (or put it behind Nginx with TLS).
Keep port 7880 (LiveKit) accessible for WebRTC — it needs UDP ports too.

### Voice bridge on a separate machine

```env
LLM_BASE_URL=https://your-librechat.com/api
LIVEKIT_URL=wss://your-livekit-server.com    # TLS required for production
```

For LiveKit Cloud (managed):
1. Create a project at https://cloud.livekit.io
2. Copy the URL, API Key, and Secret into `.env`
3. No self-hosted LiveKit needed

---

## Part 8 — Environment Variable Reference (Quick Card)

| Variable | Where to get it | Example |
|---|---|---|
| `LIVEKIT_URL` | LiveKit Cloud dashboard or `ws://localhost:7880` for local | `wss://your-proj.livekit.cloud` |
| `LIVEKIT_API_KEY` | LiveKit Cloud → Settings → Keys | `APIxxxx` |
| `LIVEKIT_API_SECRET` | Same as above | `secret...` |
| `DEEPGRAM_API_KEY` | https://console.deepgram.com | `abc123...` |
| `LLM_BASE_URL` | Your LibreChat URL + `/api` | `http://localhost:3080/api` |
| `LLM_API_KEY` | LibreChat JWT or OpenAI key | `sk-...` or JWT |
| `LLM_MODEL` | Any model your LibreChat supports | `gpt-4o-mini` |
| `OPENAI_API_KEY` | https://platform.openai.com | `sk-...` |
| `BRIDGE_API_SECRET` | Generate any strong random string | 32+ random chars |
| `TTS_PROVIDER` | `openai` / `piper` / `elevenlabs` | `openai` |

---

## Troubleshooting

### Bridge says LLM check failed in `/ready`

- Confirm LibreChat is running: `curl http://localhost:3080/api/models`
- On Docker, use `host.docker.internal` instead of `localhost` in `LLM_BASE_URL`
- On Linux Docker, try `172.17.0.1` (default Docker bridge gateway) instead

### Deepgram check fails

- Verify `DEEPGRAM_API_KEY` is correct and has credits
- Check outbound HTTPS from the bridge container is not blocked by a firewall

### Voice bridge starts but no audio comes back

- Check `docker compose logs voice-bridge` for TTS errors
- Confirm `OPENAI_API_KEY` is set if `TTS_PROVIDER=openai`
- Try `TTS_PROVIDER=piper` with the piper profile for a free local alternative

### LiveKit Playground connects but bridge doesn't join

- The bridge joins lazily on the first `/api/token` call — hit that endpoint first
- Check `docker compose logs voice-bridge` for `RoomWorker connecting` log line

### `host.docker.internal` doesn't resolve on Linux

This hostname works automatically on Mac and Windows Docker Desktop.
On Linux, add it manually to `docker-compose.override.yml`:

```yaml
services:
  voice-bridge:
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

---

## File Locations Summary

```
LibreChat/
├── .env                          ← add OPENAI_API_KEY for speech if not already there
├── librechat.yaml                ← add the speech: block from Part 4
└── docker-compose.override.yml   ← mount librechat.yaml + optionally add bridge service

conversational-for-librechat/
├── .env                          ← fill in from Part 2
├── docker-compose.yml            ← run separately OR merged via override above
└── demo/Start-Demo.ps1           ← Windows one-command launcher
```
