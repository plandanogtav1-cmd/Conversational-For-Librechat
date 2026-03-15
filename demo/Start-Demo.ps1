# demo/Start-Demo.ps1
# ─────────────────────────────────────────────────────────────────────────────
# Conversational-For-LibreChat  ·  Windows Demo Launcher
#
# Starts the full voice pipeline locally without Docker:
#   Window 1: LiveKit server (--dev mode)
#   Window 2: Voice Bridge (ts-node-dev)
#
# Prerequisites:
#   - Node.js 18+ in PATH
#   - npm install run inside voice-bridge/
#   - .env file in repo root with DEEPGRAM_API_KEY, OPENAI_API_KEY etc.
#   - LiveKit CLI installed:  winget install LiveKit.LiveKitCLI
#
# Usage:
#   cd conversational-for-librechat
#   .\demo\Start-Demo.ps1
#
# Stop: Ctrl+C in each terminal, or close the windows.
# ─────────────────────────────────────────────────────────────────────────────

param(
    [string]$EnvFile = ".env",
    [int]   $BridgePort = 8080,
    [switch]$SkipLiveKit,
    [switch]$SkipInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Helpers ───────────────────────────────────────────────────────────────────

function Write-Header([string]$msg) {
    Write-Host "`n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━" -ForegroundColor Cyan
    Write-Host "  $msg" -ForegroundColor Cyan
    Write-Host "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`n" -ForegroundColor Cyan
}

function Test-Command([string]$cmd) {
    return $null -ne (Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Start-TerminalWindow([string]$title, [string]$command) {
    Start-Process powershell -ArgumentList `
        "-NoExit", `
        "-Command", `
        "`$host.UI.RawUI.WindowTitle = '$title'; $command"
}

# ── Root check ────────────────────────────────────────────────────────────────

$repoRoot = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path (Join-Path $repoRoot "voice-bridge"))) {
    Write-Error "❌  Run this script from the repo root or the demo/ folder."
    exit 1
}

Set-Location $repoRoot
Write-Header "Conversational-For-LibreChat Demo"

# ── Load .env ─────────────────────────────────────────────────────────────────

if (-not (Test-Path $EnvFile)) {
    Write-Warning ".env not found — copying .env.example"
    Copy-Item ".env.example" ".env"
    Write-Host "⚠   Please edit .env and fill in your API keys, then re-run." -ForegroundColor Yellow
    exit 0
}

# Parse .env into current session's environment
Write-Host "📄  Loading $EnvFile…"
Get-Content $EnvFile | Where-Object { $_ -match '^\s*[^#]\w+=' } | ForEach-Object {
    $parts = $_ -split '=', 2
    $key   = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
}

# ── Prerequisite checks ───────────────────────────────────────────────────────

Write-Host "🔍  Checking prerequisites…"

if (-not (Test-Command "node")) {
    Write-Error "❌  Node.js not found. Install from https://nodejs.org"
    exit 1
}
$nodeVersion = (node --version)
Write-Host "   ✅  Node.js $nodeVersion"

if (-not (Test-Command "npm")) {
    Write-Error "❌  npm not found."
    exit 1
}

if (-not $SkipLiveKit -and -not (Test-Command "livekit-server")) {
    Write-Warning "   ⚠   livekit-server not found in PATH."
    Write-Warning "       Install: winget install LiveKit.LiveKitCLI"
    Write-Warning "       Or use Docker: docker run -p 7880:7880 livekit/livekit-server --dev"
    Write-Warning "       Skipping LiveKit window — start it manually."
    $SkipLiveKit = $true
}

# ── Install voice-bridge deps ────────────────────────────────────────────────

$bridgeDir = Join-Path $repoRoot "voice-bridge"

if (-not $SkipInstall) {
    Write-Host "`n📦  Installing voice-bridge dependencies…"
    Push-Location $bridgeDir
    npm install 2>&1 | Tail -ErrorAction SilentlyContinue
    Pop-Location
    Write-Host "   ✅  Dependencies installed"
}

# ── Start LiveKit ─────────────────────────────────────────────────────────────

if (-not $SkipLiveKit) {
    Write-Host "`n🚀  Starting LiveKit server (dev mode)…"

    $lvCmd = "Write-Host '🎙  LiveKit starting…' -ForegroundColor Green; " + `
             "livekit-server --dev --bind 0.0.0.0 --port 7880"
    Start-TerminalWindow "LiveKit Server" $lvCmd
    Start-Sleep -Seconds 2
    Write-Host "   ✅  LiveKit window opened on ws://localhost:7880"
} else {
    Write-Host "`n⏭   Skipping LiveKit (--SkipLiveKit flag set)"
}

# ── Start Voice Bridge ────────────────────────────────────────────────────────

Write-Host "`n🎤  Starting Voice Bridge on port $BridgePort…"

# Build the env override string for the bridge window
$envOverrides = "PORT=$BridgePort; " + `
    "`$env:LIVEKIT_URL='ws://localhost:7880'; " + `
    "`$env:PORT=$BridgePort; "

$bridgeCmd = "Set-Location '$bridgeDir'; " + `
             $envOverrides + `
             "Write-Host '🎤  Voice Bridge starting…' -ForegroundColor Green; " + `
             "npm run dev"

Start-TerminalWindow "Voice Bridge" $bridgeCmd
Start-Sleep -Seconds 3

# ── Health check ──────────────────────────────────────────────────────────────

Write-Host "`n⏳  Waiting for Voice Bridge to be ready…"
$maxWait = 30
$waited  = 0
$ready   = $false

while ($waited -lt $maxWait) {
    Start-Sleep -Seconds 1
    $waited++
    try {
        $resp = Invoke-WebRequest -Uri "http://localhost:$BridgePort/health" `
                                  -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($resp.StatusCode -eq 200) {
            $ready = $true
            break
        }
    } catch {
        # not ready yet
    }
    Write-Host "   … ($waited/$maxWait)"
}

if (-not $ready) {
    Write-Warning "⚠   Bridge didn't respond in ${maxWait}s. Check the terminal window."
} else {
    Write-Host "   ✅  Voice Bridge is ready!" -ForegroundColor Green
}

# ── Print usage ───────────────────────────────────────────────────────────────

$secret = [System.Environment]::GetEnvironmentVariable("BRIDGE_API_SECRET", "Process")
if (-not $secret) { $secret = "change_me_in_production" }

Write-Header "Demo Ready"
Write-Host "Bridge URL:  http://localhost:$BridgePort" -ForegroundColor White
Write-Host "LiveKit URL: ws://localhost:7880`n" -ForegroundColor White

Write-Host "── Quick tests ──────────────────────────────────────" -ForegroundColor DarkGray
Write-Host ""
Write-Host "# Health check:" -ForegroundColor DarkGray
Write-Host "  curl http://localhost:$BridgePort/health`n"

Write-Host "# Issue a LiveKit token (join room 'demo'):" -ForegroundColor DarkGray
Write-Host "  curl -X POST http://localhost:$BridgePort/api/token ``"
Write-Host "    -H `"Authorization: Bearer $secret`" ``"
Write-Host "    -H `"Content-Type: application/json`" ``"
Write-Host "    -d '{`"participantName`":`"tester`",`"roomName`":`"demo`"}'`n"

Write-Host "# Check active sessions:" -ForegroundColor DarkGray
Write-Host "  curl http://localhost:$BridgePort/api/sessions ``"
Write-Host "    -H `"Authorization: Bearer $secret`"`n"

Write-Host "# Readiness (checks Deepgram + LLM):" -ForegroundColor DarkGray
Write-Host "  curl http://localhost:$BridgePort/ready`n"

Write-Host "── LiveKit Playground ───────────────────────────────" -ForegroundColor DarkGray
Write-Host "  https://agents-playground.livekit.io/"
Write-Host "  Server URL: ws://localhost:7880"
Write-Host "  API Key:    $env:LIVEKIT_API_KEY"
Write-Host "  API Secret: $env:LIVEKIT_API_SECRET`n"

Write-Host "Press Ctrl+C or close terminal windows to stop." -ForegroundColor DarkGray
