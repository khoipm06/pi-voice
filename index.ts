import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");
const VOICE_CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "voice.json");
const VOICE_LOG_FILE = path.join(os.homedir(), ".pi", "agent", "voice.log");

const SESSION_ID = crypto.randomUUID();

interface VoiceConfig {
  apiKey?: string;
  model?: string;
  sampleRate?: number;
}

function logVoice(message: string): void {
  try {
    const timestamp = new Date().toISOString();
    fs.mkdirSync(path.dirname(VOICE_LOG_FILE), { recursive: true });
    fs.appendFileSync(VOICE_LOG_FILE, `[${timestamp}] ${message}\n`, { mode: 0o600 });
  } catch {}
}

function resolveApiKey(): string | null {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY.trim();

  try {
    if (fs.existsSync(AUTH_FILE)) {
      const authData = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
      if (authData.google?.key) return String(authData.google.key).trim();
      if (authData.gemini?.key) return String(authData.gemini.key).trim();
    }
  } catch (err) {
    logVoice(`Error reading auth.json: ${err}`);
  }

  try {
    if (fs.existsSync(VOICE_CONFIG_FILE)) {
      const voiceData = JSON.parse(fs.readFileSync(VOICE_CONFIG_FILE, "utf8"));
      if (voiceData.apiKey) return String(voiceData.apiKey).trim();
    }
  } catch {}

  return null;
}

function persistApiKey(apiKey: string): void {
  const cleanKey = apiKey.trim();

  try {
    let authData: Record<string, any> = {};
    if (fs.existsSync(AUTH_FILE)) {
      try {
        authData = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
      } catch {}
    }
    authData.google = {
      type: "api_key",
      key: cleanKey,
    };
    fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(authData, null, 2), { mode: 0o600 });
    logVoice(`Saved API key in ${AUTH_FILE}`);
  } catch (err: any) {
    logVoice(`Failed to save key in auth.json: ${err.message}`);
  }

  try {
    let voiceConfig: VoiceConfig = {};
    if (fs.existsSync(VOICE_CONFIG_FILE)) {
      try {
        voiceConfig = JSON.parse(fs.readFileSync(VOICE_CONFIG_FILE, "utf8"));
      } catch {}
    }
    voiceConfig.apiKey = cleanKey;
    fs.mkdirSync(path.dirname(VOICE_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(VOICE_CONFIG_FILE, JSON.stringify(voiceConfig, null, 2), { mode: 0o600 });
  } catch {}
}

function extractProjectTokens(cwd: string, limit = 40): string[] {
  const tokens = new Set<string>();
  const tokenRegex = /\b[a-zA-Z_$][a-zA-Z0-9_$]{2,35}\b/g;

  try {
    const files = fs.readdirSync(cwd, { withFileTypes: true });
    for (const dirent of files) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      if (dirent.isFile() && /\.(ts|js|py|go|rs|json|md)$/i.test(dirent.name)) {
        try {
          const content = fs.readFileSync(path.join(cwd, dirent.name), "utf8").slice(0, 5000);
          let match;
          while ((match = tokenRegex.exec(content)) !== null) {
            tokens.add(match[0]);
            if (tokens.size >= limit) break;
          }
        } catch {}
      }
      if (tokens.size >= limit) break;
    }
  } catch {}

  return Array.from(tokens);
}

function pcmToWav(pcmBuffer: Buffer, sampleRate = 16000): Buffer {
  const wav = Buffer.alloc(44 + pcmBuffer.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + pcmBuffer.length, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcmBuffer.length, 40);
  pcmBuffer.copy(wav, 44);
  return wav;
}

async function transcribeFastDraft(
  wavBuffer: Buffer,
  apiKey: string,
  biasingHints: string
): Promise<string> {
  const model = "gemini-2.5-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const payload = {
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: "audio/wav",
              data: wavBuffer.toString("base64"),
            },
          },
          {
            text:
              "Fast draft speech to text. Transcribe spoken words verbatim. " +
              "Output only the words spoken without commentary or quotes. " +
              (biasingHints ? `Prioritize these code identifiers: ${biasingHints}. ` : "") +
              "If silence or inaudible noise, output exactly: [NO_SPEECH].",
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.0,
      thinkingConfig: {
        thinkingBudget: 0,
      },
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-session-id": SESSION_ID,
      "session-id": SESSION_ID,
      "x-session-affinity": SESSION_ID,
      "x-opencode-session-id": SESSION_ID,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) return "";
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  return text.replace(/^["'`]+|["'`]+$/g, "").trim();
}

async function transcribeFinalReconciliation(
  wavBuffer: Buffer,
  apiKey: string,
  editorContext: string,
  projectTokens: string[]
): Promise<string> {
  const model = "gemini-2.5-flash";
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const biasingContext = [
    editorContext ? `Editor context: "${editorContext}"` : "",
    projectTokens.length ? `Workspace identifiers: ${projectTokens.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const systemInstruction =
    "You are a speech transcriber for a terminal coding assistant. " +
    "Accurately transcribe speech across multiple languages with seamless code-switching. " +
    "Reconcile punctuation, capitalization, and technical terms.\n" +
    "Rules:\n" +
    "1. Output only the verbatim transcription. No markdown formatting, quotes, or explanations.\n" +
    "2. If silence or background noise only, output exactly: [NO_SPEECH].\n" +
    "3. Prioritize matching identifiers and symbols from the project:\n" +
    biasingContext;

  const payload = {
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: "audio/wav",
              data: wavBuffer.toString("base64"),
            },
          },
          {
            text: "Transcribe the audio input verbatim following the rules.",
          },
        ],
      },
    ],
    systemInstruction: {
      parts: [{ text: systemInstruction }],
    },
    generationConfig: {
      temperature: 0.0,
      thinkingConfig: {
        thinkingBudget: 0,
      },
    },
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-session-id": SESSION_ID,
      "session-id": SESSION_ID,
      "x-session-affinity": SESSION_ID,
      "x-opencode-session-id": SESSION_ID,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Gemini API error (HTTP ${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
  return candidateText.replace(/^["'`]+|["'`]+$/g, "").trim();
}

export default function (pi: ExtensionAPI) {
  let isRecording = false;
  let recordProcess: ChildProcess | null = null;
  let recordedChunks: Buffer[] = [];
  let recordStartTime = 0;
  let liveTimer: NodeJS.Timeout | null = null;
  let liveDraftInterval: NodeJS.Timeout | null = null;
  let draftInProgress = false;
  let initialEditorText = "";
  let latestDraftText = "";

  async function startRecording(ctx: ExtensionContext) {
    if (isRecording) return;

    const apiKey = resolveApiKey();
    if (!apiKey) {
      ctx.ui.notify("No Gemini API key found. Run '/voice-key' to set it.", "warning");
      return;
    }

    isRecording = true;
    recordedChunks = [];
    recordStartTime = Date.now();
    initialEditorText = ctx.ui.getEditorText() || "";
    latestDraftText = "";
    draftInProgress = false;

    const projectTokens = extractProjectTokens(ctx.cwd, 35);
    const biasingHints = projectTokens.slice(0, 10).join(", ");

    ctx.ui.setStatus("pi-voice", "[rec] 0.0s (alt+v to stop)");
    ctx.ui.setWidget("pi-voice", [
      "Voice recording active",
      biasingHints ? `Biasing: ${biasingHints}...` : "Biasing: ready",
      "Press Alt+V or F4 to finish",
    ]);

    liveTimer = setInterval(() => {
      if (!isRecording) return;
      const elapsed = ((Date.now() - recordStartTime) / 1000).toFixed(1);
      const draftHint = latestDraftText ? ` | "${latestDraftText}"` : "";
      ctx.ui.setStatus("pi-voice", `[rec ${elapsed}s]${draftHint}`);
    }, 300);

    liveDraftInterval = setInterval(async () => {
      if (!isRecording || draftInProgress) return;

      const pcmSnapshot = Buffer.concat(recordedChunks);
      if (pcmSnapshot.length < 16000 * 2 * 0.8) return;

      const recentWindowBytes = Math.min(pcmSnapshot.length, 16000 * 2 * 1.5);
      const recentSlice = pcmSnapshot.slice(pcmSnapshot.length - recentWindowBytes);
      let sumSq = 0;
      for (let i = 0; i < recentSlice.length; i += 2) {
        const s = recentSlice.readInt16LE(i);
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / (recentSlice.length / 2));
      if (rms < 35) return;

      draftInProgress = true;
      try {
        const wavSnapshot = pcmToWav(pcmSnapshot, 16000);
        const draft = await transcribeFastDraft(wavSnapshot, apiKey, biasingHints);

        if (isRecording && draft && draft !== "[NO_SPEECH]") {
          latestDraftText = draft;
          const sep = initialEditorText && !initialEditorText.endsWith(" ") ? " " : "";
          ctx.ui.setEditorText(initialEditorText + sep + draft);
          ctx.ui.setWidget("pi-voice", [
            `Draft: "${draft}"`,
            "Press Alt+V or F4 to finish",
          ]);
        }
      } catch (err: any) {
        logVoice(`Live draft error: ${err.message}`);
      } finally {
        draftInProgress = false;
      }
    }, 1200);

    try {
      recordProcess = spawn("arecord", ["-q", "-r", "16000", "-c", "1", "-f", "S16_LE", "-t", "raw"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      isRecording = false;
      if (liveTimer) clearInterval(liveTimer);
      if (liveDraftInterval) clearInterval(liveDraftInterval);
      ctx.ui.setStatus("pi-voice", undefined);
      ctx.ui.setWidget("pi-voice", undefined);
      ctx.ui.notify(`Failed to start arecord: ${err.message}`, "error");
      logVoice(`arecord spawn error: ${err.message}`);
      return;
    }

    recordProcess.stdout?.on("data", (chunk: Buffer) => {
      recordedChunks.push(chunk);
    });

    recordProcess.on("error", (err: any) => {
      logVoice(`arecord process error: ${err.message}`);
    });
  }

  async function stopRecording(ctx: ExtensionContext) {
    if (!isRecording) return;
    isRecording = false;

    if (liveTimer) {
      clearInterval(liveTimer);
      liveTimer = null;
    }
    if (liveDraftInterval) {
      clearInterval(liveDraftInterval);
      liveDraftInterval = null;
    }

    ctx.ui.setStatus("pi-voice", "finalizing transcript...");
    ctx.ui.setWidget("pi-voice", [
      "Finalizing transcript...",
      latestDraftText ? `Draft: "${latestDraftText}"` : "Processing context...",
    ]);

    if (recordProcess) {
      const proc = recordProcess;
      recordProcess = null;
      await new Promise<void>((resolve) => {
        proc.on("close", () => resolve());
        proc.kill("SIGTERM");
        setTimeout(resolve, 300);
      });
    }

    const pcmBuffer = Buffer.concat(recordedChunks);
    const totalBytes = pcmBuffer.length;
    const durationSec = (totalBytes / (16000 * 2)).toFixed(1);

    if (totalBytes < 4800) {
      ctx.ui.setStatus("pi-voice", undefined);
      ctx.ui.setWidget("pi-voice", undefined);
      ctx.ui.setEditorText(initialEditorText);
      ctx.ui.notify(`Recording too short (${durationSec}s).`, "warning");
      return;
    }

    let sumSq = 0;
    const numSamples = Math.floor(totalBytes / 2);
    for (let i = 0; i < totalBytes; i += 2) {
      const sample = pcmBuffer.readInt16LE(i);
      sumSq += sample * sample;
    }
    const rms = Math.sqrt(sumSq / (numSamples || 1));

    logVoice(`Recording stopped: ${durationSec}s, ${totalBytes} bytes, RMS: ${rms.toFixed(1)}`);

    if (rms < 40) {
      ctx.ui.setStatus("pi-voice", undefined);
      ctx.ui.setWidget("pi-voice", undefined);
      ctx.ui.setEditorText(initialEditorText);
      ctx.ui.notify(`Microphone level low (RMS: ${rms.toFixed(1)}).`, "warning");
      logVoice("Warning: audio RMS below threshold (< 40)");
      return;
    }

    const apiKey = resolveApiKey();
    if (!apiKey) {
      ctx.ui.setStatus("pi-voice", undefined);
      ctx.ui.setWidget("pi-voice", undefined);
      ctx.ui.notify("No Gemini API key found. Run '/voice-key' to set it.", "error");
      return;
    }

    try {
      const wavBuffer = pcmToWav(pcmBuffer, 16000);
      const projectTokens = extractProjectTokens(ctx.cwd, 40);

      const finalTranscript = await transcribeFinalReconciliation(
        wavBuffer,
        apiKey,
        initialEditorText,
        projectTokens
      );

      ctx.ui.setStatus("pi-voice", undefined);
      ctx.ui.setWidget("pi-voice", undefined);

      if (!finalTranscript || finalTranscript === "[NO_SPEECH]") {
        if (latestDraftText) {
          const sep = initialEditorText && !initialEditorText.endsWith(" ") ? " " : "";
          ctx.ui.setEditorText(initialEditorText + sep + latestDraftText);
          ctx.ui.notify(`[${durationSec}s]: "${latestDraftText}"`, "info");
        } else {
          ctx.ui.setEditorText(initialEditorText);
          ctx.ui.notify(`Recorded ${durationSec}s. No speech detected.`, "info");
          logVoice(`Transcribed (${durationSec}s): [NO_SPEECH]`);
        }
        return;
      }

      const sep = initialEditorText && !initialEditorText.endsWith(" ") ? " " : "";
      ctx.ui.setEditorText(initialEditorText + sep + finalTranscript);

      ctx.ui.notify(`[${durationSec}s]: "${finalTranscript}"`, "info");
      logVoice(`Finalized (${durationSec}s): "${finalTranscript}"`);
    } catch (err: any) {
      ctx.ui.setStatus("pi-voice", undefined);
      ctx.ui.setWidget("pi-voice", undefined);
      if (latestDraftText) {
        const sep = initialEditorText && !initialEditorText.endsWith(" ") ? " " : "";
        ctx.ui.setEditorText(initialEditorText + sep + latestDraftText);
      }
      ctx.ui.notify(`Transcription error: ${err.message}`, "error");
      logVoice(`Final reconciliation error: ${err.message}`);
    }
  }

  function toggleVoice(ctx: ExtensionContext) {
    if (isRecording) {
      stopRecording(ctx);
    } else {
      startRecording(ctx);
    }
  }

  pi.registerShortcut("alt+v", {
    description: "Toggle voice input",
    handler: async (ctx) => {
      toggleVoice(ctx);
    },
  });

  pi.registerShortcut("f4", {
    description: "Toggle voice input",
    handler: async (ctx) => {
      toggleVoice(ctx);
    },
  });

  pi.registerCommand("voice", {
    description: "Toggle voice input on or off",
    handler: async (_args, ctx) => {
      toggleVoice(ctx);
    },
  });

  pi.registerCommand("voice-key", {
    description: "Set persistent Gemini API key",
    handler: async (args, ctx) => {
      let key = args.trim();

      if (!key) {
        const inputKey = await ctx.ui.input("Enter Gemini API key:");
        if (!inputKey || !inputKey.trim()) {
          ctx.ui.notify("Key configuration cancelled.", "warning");
          return;
        }
        key = inputKey.trim();
      }

      persistApiKey(key);
      ctx.ui.notify("Saved Gemini API key.", "info");
    },
  });

  pi.registerCommand("voice-log", {
    description: "View recent voice debugging logs",
    handler: async (_args, ctx) => {
      try {
        if (!fs.existsSync(VOICE_LOG_FILE)) {
          ctx.ui.notify("No log file found at ~/.pi/agent/voice.log", "info");
          return;
        }
        const lines = fs.readFileSync(VOICE_LOG_FILE, "utf8").trim().split("\n");
        const recent = lines.slice(-8).join("\n");
        ctx.ui.notify(`Voice log:\n${recent}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Cannot read log: ${err.message}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const hasKey = !!resolveApiKey();
    if (hasKey) {
      ctx.ui.notify("pi-voice loaded (Alt+V or F4 to toggle)", "info");
    } else {
      ctx.ui.notify("pi-voice loaded. Run /voice-key to set API key.", "info");
    }
  });
}
