# pi-voice

Voice input extension for Pi with live draft transcription and workspace context biasing.

## Why this exists

Standard speech-to-text tools struggle in technical terminal workflows:

1. Locale lock. Traditional engines like Whisper or browser speech APIs require binding to a single fixed locale. When speaking a native language while referencing English programming terms, flags, or acronyms like JWT and gRPC, fixed-locale engines attempt to match those terms against common dictionary words, corrupting technical syntax.
2. Domain mismatch. General-purpose models train on everyday conversational speech. Programming jargon like async, mutex, stdout, or camelCase identifiers are easily misheard as similar-sounding common phrases without domain guidance.
3. Lack of repository context. Off-the-shelf voice input has no visibility into the active project. It cannot tell whether you meant an ordinary word or an exact function name defined in your workspace.
4. Blind dictation. Most command line voice tools record into silence and dump a block of text only after stopping, offering no feedback while speaking.
5. Resource consumption. Running heavy local models consumes memory and compute that compete with language servers, compilers, and test suites.

## How it works

- Multilingual code-switching. Gemini processes speech directly as multimodal audio tokens without an upfront locale lock. It handles natural transitions between languages and technical vocabulary in the same sentence.
- Workspace context biasing. Before transcribing, the extension collects identifiers, function names, and types from open files and the current repository. Passing these tokens guides the model to match your codebase's exact spelling and casing.
- Dual-stage live transcription. While recording, a background worker streams rolling draft text directly into the Pi prompt line every 1.2 seconds. When you finish, the full audio buffer undergoes a reconciliation pass to correct punctuation, grammar, and technical terms across the entire statement.
- Lightweight capture. Audio is captured via native ALSA `arecord` at 16kHz PCM, avoiding local model inference overhead.

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
