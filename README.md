# pi-voice

Voice input extension for Pi with live draft transcription and workspace context biasing.

## Why this exists

Most speech-to-text tools fail when coding in bilingual environments:

1. Locale lock: engines like Whisper or browser Web Speech require selecting a fixed language locale up front. When speaking Vietnamese mixed with English technical terms, traditional engines attempt to spell English words using Vietnamese phonetic rules, mangling camelCase names and library identifiers.
2. Missing project context: standard transcription has no awareness of your repository. It cannot tell whether you said a common word or an exact function name defined in your workspace.
3. Blind dictation: batch-only tools force you to speak into silence and wait for a final block of text, offering no visual confirmation while speaking.
4. Heavy local overhead: running local speech models requires dedicated GPU memory or continuous CPU load that drains laptop batteries.

## How it works

This extension solves those issues through three design choices:

- Native code-switching via Gemini: Gemini processes speech directly as multimodal audio tokens. It switches between Vietnamese and English naturally without phonetic warping.
- Workspace context biasing: before transcribing, the extension gathers exported identifiers, function names, and variable symbols from your active files. It injects these into the prompt so technical names like `fetchData`, `AuthController`, or `useMemo` match your codebase.
- Dual-stage live transcription: while recording, a low-latency background worker streams rolling draft text directly into your Pi prompt line every 1.2 seconds. When you press stop, the full audio buffer undergoes a final reconciliation pass to correct punctuation, grammar, and technical spelling across the entire sentence.

## Prerequisites

- Linux with ALSA `arecord` installed
- Gemini API key

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

Set your Gemini API key:

```text
/voice-key
```

This saves your key persistently to `~/.pi/agent/auth.json` under the `google` provider.

Alternatively, set an environment variable before starting Pi:

```bash
export GEMINI_API_KEY="your-key-here"
```

## Keybindings and commands

- `Alt+V` or `F4`: toggle recording on or off
- `/voice`: command alternative to toggle recording
- `/voice-key`: set or update API key
- `/voice-log`: display recent audio diagnostics

## Troubleshooting

Run `/voice-log` to inspect:

- Recorded duration in seconds
- Total bytes captured
- Root mean square (RMS) audio level

If the log shows RMS below 40, check your default capture device:

```bash
arecord -l
pactl get-default-source
```

## License

MIT
