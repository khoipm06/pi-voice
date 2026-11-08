# pi-voice

Voice input extension for Pi powered by Google Gemini multimodal intelligence, workspace context biasing, and terminal TUI integration.

## Why this exists

Generic speech-to-text tools perform poorly in technical CLI coding workflows:

1. Locale locking. Standard engines bind to a single locale. When speaking a native language with embedded English technical terms (such as `kubectl`, `JWT`, `gRPC`, `mutex`), fixed-locale models produce corrupted syntax. Gemini handles multi-lingual code-switching natively.
2. Missing workspace context. Conventional transcription models have no knowledge of your repository. They cannot infer whether you said an ordinary dictionary word or an exact function name defined in your project.
3. Quota exhaustion. Polling public REST transcription endpoints consumes Free Tier limits (5 requests per minute) within seconds of speaking.
4. Blind recording. Most terminal voice utilities record silently into a buffer with no visual audio feedback, leaving the user unsure whether microphone input is active or clipping.

`pi-voice` resolves these issues through repository-aware context biasing, live VU meter amplitude feedback, and an adaptive single-pass transcription pipeline designed to operate cleanly within standard API quotas.

## Architecture

The extension implements the transcription architecture reverse-engineered from Google internal language servers:

### 1. Workspace Context Biasing (`extractAsrContext`)
Before finalizing an audio recording, the extension indexes:
- Git status: currently modified files, tracked file basenames, and active branch name.
- Codebase symbols: top exported identifiers, functions, and types from local project source files (`.ts`, `.py`, `.go`, `.rs`, `.json`).
- Editor context: current text in the terminal prompt.

These tokens are injected into the multimodal prompt instructions, biasing the model towards exact identifiers and syntax used in your repository.

### 2. Post-Processing Pipeline
- Spacing normalization (`collapseCJKSpaces`): automatically removes unwanted whitespace between CJK runes while preserving natural spacing for alphanumeric languages.
- Syntax sanitization: strips conversational filler, markdown formatting blocks, and extraneous quotes.

### 3. Rate-Limit Protected Pipeline
- Operates via adaptive single-pass multimodal reconciliation on utterance completion. Exactly one request is dispatched per utterance, eliminating the 429 quota exhaustion that occurs with continuous polling on Free Tier keys.
- Real-time visual feedback is handled locally through the TUI VU meter and status banner without consuming API quota during speech.
- Compatible with `gemini-2.5-flash` and `gemini-3.5-flash-lite`.

### 4. Optional ConnectRPC Local Bridge
If Google Antigravity is active on localhost, `pi-voice` can opportunistically connect to the local language server bridge for zero-configuration, token-free streaming. This is completely optional; no IDE dependency is required.

## Prerequisites

- Linux with ALSA `arecord` (`sudo dnf install alsa-utils` or `sudo apt-get install alsa-utils`)
- A Google Gemini API key (Free Tier or Pay-as-you-go)

## Installation

Copy `index.ts` to your Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp index.ts ~/.pi/agent/extensions/pi-voice.ts
```

Reload Pi:

```text
/reload
```

## Configuration

Set your Gemini API key using the interactive command:

```text
/voice-key
```

The key is saved in `~/.pi/agent/auth.json` under the `google` provider. Alternatively, export the environment variable:

```bash
export GEMINI_API_KEY="your-api-key"
```

To switch models:

```text
/voice-model gemini-3.5-flash-lite
```

## Keybindings and Controls

- `Alt+V` or `F4`: Toggle recording on or off (inserts transcribed text into prompt)
- `Enter` (while recording): Stop recording, transcribe, and immediately submit prompt to agent
- `Esc` (while recording): Cancel recording and discard captured audio
- `/voice`: Toggle recording
- `/voice-status`: Inspect active engine mode, model, and key status
- `/voice-model [name]`: Inspect or change the active transcription model
- `/voice-key`: Set or update the Gemini API key
- `/voice-log`: Display recent audio levels and transcription logs

## Visual Interface

- Dynamic prompt border tint: switches to accent color while recording, warning color during transcription, and restores default when idle.
- Top border VU meter: real-time amplitude wave (` ▂▃▅▆█`) reacting dynamically to your voice level.
- Live streaming banner: displays duration counter (`[● REC 00:04]`) and floating speech status above the prompt.

## Diagnostics

If speech is not captured, run `/voice-log` to check audio diagnostics:

- RMS audio level: values below 35 indicate low microphone input or an inactive device.
- Duration and total bytes captured.

Verify your default ALSA recording source:

```bash
arecord -l
pactl get-default-source
```

## License

MIT
