# pi-voice

Voice input extension for Pi with live streaming transcription, Antigravity engine bridge, and workspace context biasing.

## Why this exists

Standard speech-to-text tools struggle in technical terminal workflows:

1. Locale lock. Traditional engines require binding to a single fixed locale. When speaking a native language while referencing English programming terms, flags, or acronyms like JWT and gRPC, fixed-locale engines corrupt technical syntax.
2. Domain mismatch. General-purpose models mishear technical jargon like async, mutex, stdout, or camelCase identifiers without domain guidance.
3. Lack of repository context. Off-the-shelf voice input has no visibility into the active project. It cannot tell whether you meant an ordinary word or an exact function name defined in your workspace.
4. Blind dictation. Most command line voice tools record into silence and dump a block of text only after stopping, offering no feedback while speaking.
5. Quota exhaustion on Free Tier keys. Fast polling of REST STT endpoints consumes standard Free Tier limits (5 requests per minute) within seconds of speaking.

## How it works

The extension operates with a dual-engine architecture:

### 1. Antigravity Bridge Engine (Primary)

When running alongside Google Antigravity, `pi-voice` automatically detects the local `language_server` on `127.0.0.1` and establishes a bidirectional ConnectRPC audio stream:

- Real-time token streaming: Audio chunks (40ms PCM) stream continuously over ConnectRPC, updating the editor prompt in real time as you speak.
- Unlimited quota: Routes through Antigravity's persistent gRPC cloud channel rather than discrete public REST requests. Zero quota limits, zero 5 RPM ceiling.
- Zero credential overhead: Inherits authenticated IDE session credentials; does not require a standalone Gemini API key when the bridge is active.

### 2. Standalone Cloud Gemini Engine (Fallback)

When Antigravity is not active, the extension falls back to direct Gemini 2.5 Flash API calls:

- Rate-limit protected: Uses a single-turn reconciliation pass on stop by default. Exactly one API call per utterance prevents hitting the 5 RPM Free Tier ceiling.
- Context biasing: Gathers active tokens, types, and identifiers from open files and prompt history to steer transcription accuracy.
- Configurable live drafts: For paid tier keys with high request ceilings, draft streaming can be enabled via `~/.pi/agent/voice.json` (`"liveDraft": true`).

## Prerequisites

- Linux with ALSA `arecord` installed
- Google Antigravity running locally (recommended for unlimited real-time streaming) OR a Gemini API key

## Installation

### Manual

Copy `index.ts` to your Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp index.ts ~/.pi/agent/extensions/pi-voice.ts
```

Reload Pi:

```text
/reload
```

## Setup

When running Antigravity, no configuration is necessary; the bridge connects automatically.

To configure a standalone fallback API key:

```text
/voice-key
```

This saves your key persistently to `~/.pi/agent/auth.json` under the `google` provider.

Alternatively, export the environment variable:

```bash
export GEMINI_API_KEY="your-key-here"
```

## Keybindings and commands

- `Alt+V` or `F4`: toggle recording on or off
- `/voice`: toggle recording on or off
- `/voice-status`: inspect active engine mode, bridge port, and key status
- `/voice-key`: set or update standalone API key
- `/voice-log`: display recent audio diagnostics

## Troubleshooting

Run `/voice-status` to inspect whether the Antigravity bridge is connected or if cloud fallback is in use.

Run `/voice-log` to inspect:

- Recorded duration in seconds
- Total bytes captured
- Root mean square (RMS) audio level

If the log shows RMS below 35, check your default capture device:

```bash
arecord -l
pactl get-default-source
```

## License

MIT
