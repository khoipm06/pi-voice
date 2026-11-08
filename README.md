# pi-voice

Voice input extension for Pi with real-time draft transcription and project context biasing.

## Prerequisites

- Linux system with ALSA `arecord` installed
- Gemini API key

## Installation

### Manual

Copy `index.ts` to your Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
cp index.ts ~/.pi/agent/extensions/pi-voice.ts
```

Reload Pi or restart your session:

```text
/reload
```

## Setup

Set your Gemini API key once:

```text
/voice-key
```

This writes the key to `~/.pi/agent/auth.json` with file mode `0600` under the `google` provider.

You can also pass it through the environment before launching Pi:

```bash
export GEMINI_API_KEY="AIzaSy..."
```

## Usage

- Press `Alt+V` or `F4` to start recording.
- Talk in English or Vietnamese. Draft text streams into the prompt line while you speak.
- Press `Alt+V` or `F4` again to finish. The extension sends the full audio buffer to Gemini 2.5 Flash to correct punctuation, spelling, and code identifiers.

Commands available in Pi:

- `/voice`: toggle recording on or off
- `/voice-key`: set or update API key
- `/voice-log`: view recent recording diagnostic logs

## Context biasing

Before transcribing, the extension collects identifiers from open files and the current working directory. These tokens are passed in the prompt so variable names, function names, and technical terms are transcribed accurately instead of being misheard as common words.

## Troubleshooting

Run `/voice-log` inside Pi to inspect:

- Audio duration in seconds
- Total bytes recorded
- Root mean square (RMS) amplitude level

If the log reports RMS below 40, check your system microphone input levels or default capture device:

```bash
arecord -l
pactl get-default-source
```

## License

MIT
