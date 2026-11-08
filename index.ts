import { type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");
const VOICE_CONFIG_FILE = path.join(os.homedir(), ".pi", "agent", "voice.json");
const VOICE_LOG_FILE = path.join(os.homedir(), ".pi", "agent", "voice.log");

const CLOUD_SESSION_ID = crypto.randomUUID();

interface VoiceConfig {
  apiKey?: string;
  model?: string;
  sampleRate?: number;
  liveDraft?: boolean;
}

interface AntigravityBridge {
  port: number;
  csrfToken: string;
  pid: number;
}

function logVoice(message: string): void {
  try {
    const timestamp = new Date().toISOString();
    fs.mkdirSync(path.dirname(VOICE_LOG_FILE), { recursive: true });
    fs.appendFileSync(VOICE_LOG_FILE, `[${timestamp}] ${message}\n`, { mode: 0o600 });
  } catch {}
}

function readVoiceConfig(): VoiceConfig {
  try {
    if (fs.existsSync(VOICE_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(VOICE_CONFIG_FILE, "utf8"));
    }
  } catch {}
  return {};
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

  const voiceConfig = readVoiceConfig();
  if (voiceConfig.apiKey) return String(voiceConfig.apiKey).trim();

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
    const voiceConfig = readVoiceConfig();
    voiceConfig.apiKey = cleanKey;
    fs.mkdirSync(path.dirname(VOICE_CONFIG_FILE), { recursive: true });
    fs.writeFileSync(VOICE_CONFIG_FILE, JSON.stringify(voiceConfig, null, 2), { mode: 0o600 });
  } catch {}
}

function getListeningPortsForPid(pid: number): number[] {
  const ports: number[] = [];
  try {
    const fdDir = `/proc/${pid}/fd`;
    if (!fs.existsSync(fdDir)) return ports;

    const fds = fs.readdirSync(fdDir);
    const inodes = new Set<string>();
    for (const fd of fds) {
      try {
        const link = fs.readlinkSync(`${fdDir}/${fd}`);
        const m = link.match(/^socket:\[(\d+)\]$/);
        if (m) inodes.add(m[1]);
      } catch {}
    }

    for (const netFile of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      if (!fs.existsSync(netFile)) continue;
      const content = fs.readFileSync(netFile, "utf8");
      const lines = content.split("\n");
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].trim().split(/\s+/);
        if (parts.length >= 10) {
          const state = parts[3];
          const inode = parts[9];
          if (state === "0A" && inodes.has(inode)) {
            const localAddr = parts[1];
            const portHex = localAddr.split(":")[1];
            if (portHex) {
              ports.push(parseInt(portHex, 16));
            }
          }
        }
      }
    }
  } catch {}
  return ports;
}

async function detectAntigravityBridge(): Promise<AntigravityBridge | null> {
  try {
    const procEntries = fs.readdirSync("/proc");
    for (const entry of procEntries) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = parseInt(entry, 10);
      try {
        const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
        if (cmdline.includes("language_server") && cmdline.includes("--csrf_token")) {
          const matchToken =
            cmdline.match(/--csrf_token\x00([^\x00]+)/) ||
            cmdline.match(/--csrf_token=([^\x00\s]+)/);
          if (!matchToken) continue;
          const csrfToken = matchToken[1];

          const ports = getListeningPortsForPid(pid);
          for (const port of ports) {
            try {
              const res = await fetch(
                `http://127.0.0.1:${port}/exa.language_server_pb.LanguageServerService/StreamAudioTranscription`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/connect+json",
                    "x-codeium-csrf-token": csrfToken,
                    Cookie: `csrfToken=${csrfToken}`,
                  },
                  body: new Uint8Array([0, 0, 0, 0, 2, 123, 125]),
                  signal: AbortSignal.timeout(600),
                }
              );
              if (res.status === 200 || res.status === 400) {
                return { port, csrfToken, pid };
              }
            } catch {}
          }
        }
      } catch {}
    }
  } catch {}
  return null;
}

function encodeConnectEnvelope(jsonObj: any): Buffer {
  const payload = Buffer.from(JSON.stringify(jsonObj));
  const envelope = Buffer.alloc(5 + payload.length);
  envelope.writeUInt8(0, 0);
  envelope.writeUInt32BE(payload.length, 1);
  payload.copy(envelope, 5);
  return envelope;
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
      "x-session-id": CLOUD_SESSION_ID,
      "session-id": CLOUD_SESSION_ID,
      "x-session-affinity": CLOUD_SESSION_ID,
      "x-opencode-session-id": CLOUD_SESSION_ID,
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
      "x-session-id": CLOUD_SESSION_ID,
      "session-id": CLOUD_SESSION_ID,
      "x-session-affinity": CLOUD_SESSION_ID,
      "x-opencode-session-id": CLOUD_SESSION_ID,
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
  let cloudDraftInterval: NodeJS.Timeout | null = null;
  let draftInProgress = false;
  let initialEditorText = "";
  let latestDraftText = "";

  let activeBridge: AntigravityBridge | null = null;
  let bridgeSessionId: string | null = null;
  let bridgeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let bridgeSeq = 0;
  let bridgeFinalTranscript = "";
  let bridgePendingAudio: Buffer[] = [];

  async function startBridgeStream(bridge: AntigravityBridge, editorText: string): Promise<boolean> {
    bridgeSessionId = null;
    bridgeFinalTranscript = "";
    bridgeSeq = 0;
    bridgePendingAudio = [];

    try {
      const res = await fetch(
        `http://127.0.0.1:${bridge.port}/exa.language_server_pb.LanguageServerService/StreamAudioTranscription`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/connect+json",
            "Connect-Protocol-Version": "1",
            "x-codeium-csrf-token": bridge.csrfToken,
            Cookie: `csrfToken=${bridge.csrfToken}`,
          },
          body: new Uint8Array(
            encodeConnectEnvelope({
              mimeType: "audio/pcm;rate=16000",
              preCursorText: editorText.slice(-100),
              postCursorText: "",
            })
          ),
        }
      );

      if (!res.ok || !res.body) {
        logVoice(`Bridge connection failed: HTTP ${res.status}`);
        return false;
      }

      bridgeReader = res.body.getReader();

      (async () => {
        let streamBuf = Buffer.alloc(0);
        try {
          while (bridgeReader) {
            while (streamBuf.length >= 5) {
              const flags = streamBuf.readUInt8(0);
              const len = streamBuf.readUInt32BE(1);
              if (streamBuf.length < 5 + len) break;
              const msgBytes = streamBuf.slice(5, 5 + len);
              streamBuf = streamBuf.slice(5 + len);

              try {
                const parsed = JSON.parse(msgBytes.toString("utf8"));
                if (parsed.ready?.sessionId) {
                  bridgeSessionId = parsed.ready.sessionId;
                  logVoice(`Bridge session established: ${bridgeSessionId}`);
                  drainBridgeQueue();
                }

                if (parsed.transcription?.text) {
                  const text = parsed.transcription.text.trim();
                  latestDraftText = text;
                  if (parsed.transcription.isFinal) {
                    bridgeFinalTranscript = text;
                  }
                }
              } catch {}
            }

            const { value, done } = await bridgeReader.read();
            if (done) break;
            streamBuf = Buffer.concat([streamBuf, Buffer.from(value)]);
          }
        } catch (err: any) {
          if (err.name !== "AbortError") {
            logVoice(`Bridge stream error: ${err.message}`);
          }
        }
      })();

      return true;
    } catch (err: any) {
      logVoice(`Bridge start error: ${err.message}`);
      return false;
    }
  }

  async function sendBridgeAudioChunk(chunk: Buffer): Promise<void> {
    if (!activeBridge || !bridgeSessionId) {
      bridgePendingAudio.push(chunk);
      return;
    }

    const currentSeq = bridgeSeq++;
    try {
      await fetch(
        `http://127.0.0.1:${activeBridge.port}/exa.language_server_pb.LanguageServerService/SendAudioChunk`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-codeium-csrf-token": activeBridge.csrfToken,
            Cookie: `csrfToken=${activeBridge.csrfToken}`,
          },
          body: JSON.stringify({
            sessionId: bridgeSessionId,
            data: chunk.toString("base64"),
            sequenceNumber: currentSeq,
          }),
        }
      );
    } catch (err: any) {
      logVoice(`Error sending audio chunk #${currentSeq}: ${err.message}`);
    }
  }

  async function drainBridgeQueue(): Promise<void> {
    if (!activeBridge || !bridgeSessionId) return;
    while (bridgePendingAudio.length > 0) {
      const chunk = bridgePendingAudio.shift();
      if (chunk) {
        await sendBridgeAudioChunk(chunk);
      }
    }
  }

  async function endBridgeSession(): Promise<string> {
    if (!activeBridge || !bridgeSessionId) {
      return bridgeFinalTranscript || latestDraftText;
    }

    try {
      await fetch(
        `http://127.0.0.1:${activeBridge.port}/exa.language_server_pb.LanguageServerService/EndAudioSession`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-codeium-csrf-token": activeBridge.csrfToken,
            Cookie: `csrfToken=${activeBridge.csrfToken}`,
          },
          body: JSON.stringify({
            sessionId: bridgeSessionId,
          }),
        }
      );
    } catch (err: any) {
      logVoice(`EndAudioSession error: ${err.message}`);
    }

    const startWait = Date.now();
    while (!bridgeFinalTranscript && Date.now() - startWait < 1500) {
      await new Promise((r) => setTimeout(r, 40));
    }

    try {
      if (bridgeReader) {
        await bridgeReader.cancel();
      }
    } catch {}
    bridgeReader = null;

    return bridgeFinalTranscript || latestDraftText;
  }

  async function startRecording(ctx: ExtensionContext) {
    if (isRecording) return;

    activeBridge = await detectAntigravityBridge();
    const apiKey = resolveApiKey();

    if (!activeBridge && !apiKey) {
      ctx.ui.notify(
        "No engine available. Run '/voice-key' to set Gemini key, or start Antigravity for unlimited local bridge.",
        "warning"
      );
      return;
    }

    isRecording = true;
    recordedChunks = [];
    recordStartTime = Date.now();
    initialEditorText = ctx.ui.getEditorText() || "";
    latestDraftText = "";
    draftInProgress = false;

    const voiceConfig = readVoiceConfig();
    const projectTokens = extractProjectTokens(ctx.cwd, 35);
    const biasingHints = projectTokens.slice(0, 10).join(", ");

    let usingBridge = false;
    if (activeBridge) {
      usingBridge = await startBridgeStream(activeBridge, initialEditorText);
    }

    const modeLabel = usingBridge ? "bridge" : "cloud";
    ctx.ui.setStatus("pi-voice", `[rec ${modeLabel}] 0.0s (alt+v to stop)`);
    ctx.ui.setWidget("pi-voice", [
      `Voice input active [${usingBridge ? "Antigravity Bridge (unlimited)" : "Cloud Gemini"}]`,
      biasingHints ? `Context: ${biasingHints}...` : "Context: ready",
      "Press Alt+V or F4 to finish",
    ]);

    liveTimer = setInterval(() => {
      if (!isRecording) return;
      const elapsed = ((Date.now() - recordStartTime) / 1000).toFixed(1);
      const draftHint = latestDraftText ? ` | "${latestDraftText}"` : "";
      ctx.ui.setStatus("pi-voice", `[rec ${modeLabel} ${elapsed}s]${draftHint}`);

      if (latestDraftText) {
        const sep = initialEditorText && !initialEditorText.endsWith(" ") ? " " : "";
        ctx.ui.setEditorText(initialEditorText + sep + latestDraftText);
        ctx.ui.setWidget("pi-voice", [
          `Draft: "${latestDraftText}"`,
          "Press Alt+V or F4 to finish",
        ]);
      }
    }, 200);

    if (!usingBridge && apiKey && voiceConfig.liveDraft === true) {
      cloudDraftInterval = setInterval(async () => {
        if (!isRecording || draftInProgress) return;

        const pcmSnapshot = Buffer.concat(recordedChunks);
        if (pcmSnapshot.length < 16000 * 2 * 1.0) return;

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
          }
        } catch {} finally {
          draftInProgress = false;
        }
      }, 1500);
    }

    try {
      recordProcess = spawn("arecord", ["-q", "-r", "16000", "-c", "1", "-f", "S16_LE", "-t", "raw"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      isRecording = false;
      if (liveTimer) clearInterval(liveTimer);
      if (cloudDraftInterval) clearInterval(cloudDraftInterval);
      ctx.ui.setStatus("pi-voice", undefined);
      ctx.ui.setWidget("pi-voice", undefined);
      ctx.ui.notify(`Failed to start arecord: ${err.message}`, "error");
      logVoice(`arecord spawn error: ${err.message}`);
      return;
    }

    let pcmSliceBuffer = Buffer.alloc(0);
    const CHUNK_SIZE = 1280; // 40ms at 16kHz 16-bit mono

    recordProcess.stdout?.on("data", (chunk: Buffer) => {
      recordedChunks.push(chunk);

      if (usingBridge) {
        pcmSliceBuffer = Buffer.concat([pcmSliceBuffer, chunk]);
        while (pcmSliceBuffer.length >= CHUNK_SIZE) {
          const slice = pcmSliceBuffer.slice(0, CHUNK_SIZE);
          pcmSliceBuffer = pcmSliceBuffer.slice(CHUNK_SIZE);
          sendBridgeAudioChunk(slice);
        }
      }
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
    if (cloudDraftInterval) {
      clearInterval(cloudDraftInterval);
      cloudDraftInterval = null;
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
        setTimeout(resolve, 250);
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

    if (rms < 35) {
      ctx.ui.setStatus("pi-voice", undefined);
      ctx.ui.setWidget("pi-voice", undefined);
      ctx.ui.setEditorText(initialEditorText);
      ctx.ui.notify(`Microphone level low (RMS: ${rms.toFixed(1)}).`, "warning");
      logVoice("Warning: audio RMS below threshold (< 35)");
      return;
    }

    if (activeBridge && bridgeSessionId) {
      try {
        const bridgeText = await endBridgeSession();
        ctx.ui.setStatus("pi-voice", undefined);
        ctx.ui.setWidget("pi-voice", undefined);

        if (bridgeText && bridgeText !== "[NO_SPEECH]") {
          const sep = initialEditorText && !initialEditorText.endsWith(" ") ? " " : "";
          ctx.ui.setEditorText(initialEditorText + sep + bridgeText);
          ctx.ui.notify(`[${durationSec}s bridge]: "${bridgeText}"`, "info");
          logVoice(`Bridge finalized (${durationSec}s): "${bridgeText}"`);
          return;
        }

        if (latestDraftText) {
          const sep = initialEditorText && !initialEditorText.endsWith(" ") ? " " : "";
          ctx.ui.setEditorText(initialEditorText + sep + latestDraftText);
          ctx.ui.notify(`[${durationSec}s bridge]: "${latestDraftText}"`, "info");
          return;
        }

        ctx.ui.setEditorText(initialEditorText);
        ctx.ui.notify(`Recorded ${durationSec}s. No speech detected.`, "info");
        logVoice(`Bridge transcribed (${durationSec}s): [NO_SPEECH]`);
        return;
      } catch (err: any) {
        logVoice(`Bridge finalize failed: ${err.message}, attempting cloud fallback`);
      }
    }

    const apiKey = resolveApiKey();
    if (!apiKey) {
      ctx.ui.setStatus("pi-voice", undefined);
      ctx.ui.setWidget("pi-voice", undefined);
      if (latestDraftText) {
        const sep = initialEditorText && !initialEditorText.endsWith(" ") ? " " : "";
        ctx.ui.setEditorText(initialEditorText + sep + latestDraftText);
      }
      ctx.ui.notify("No Gemini API key found for fallback. Run '/voice-key' to set it.", "error");
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

      ctx.ui.notify(`[${durationSec}s cloud]: "${finalTranscript}"`, "info");
      logVoice(`Finalized (${durationSec}s): "${finalTranscript}"`);
    } catch (err: any) {
      ctx.ui.setStatus("pi-voice", undefined);
      ctx.ui.setWidget("pi-voice", undefined);
      if (latestDraftText) {
        const sep = initialEditorText && !initialEditorText.endsWith(" ") ? " " : "";
        ctx.ui.setEditorText(initialEditorText + sep + latestDraftText);
      }

      if (err.message.includes("429") || err.message.includes("RESOURCE_EXHAUSTED") || err.message.includes("quota")) {
        const retryMatch = err.message.match(/retry in ([0-9.]+)s/i) || err.message.match(/retryDelay"?:\s*"([0-9]+)s"/i);
        const waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : 60;
        ctx.ui.notify(`Gemini API rate limit reached (5 req/min on Free Tier). Retry in ${waitSec}s, or start Antigravity for unlimited bridge.`, "warning");
        logVoice(`Rate limit 429: wait ${waitSec}s`);
      } else {
        ctx.ui.notify(`Transcription error: ${err.message}`, "error");
        logVoice(`Final reconciliation error: ${err.message}`);
      }
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

  pi.registerCommand("voice-status", {
    description: "Inspect voice transcription engine status",
    handler: async (_args, ctx) => {
      const bridge = await detectAntigravityBridge();
      const apiKey = resolveApiKey();
      const config = readVoiceConfig();

      const lines = [
        `Bridge: ${bridge ? `Connected (PID: ${bridge.pid}, port: ${bridge.port})` : "Not detected"}`,
        `Cloud key: ${apiKey ? `Configured (...${apiKey.slice(-6)})` : "Not set"}`,
        `Live draft: ${config.liveDraft ? "Enabled" : "Disabled (default for Free Tier)"}`,
        `Engine priority: ${bridge ? "Antigravity Bridge (unlimited streaming)" : "Cloud Gemini (single-turn)"}`,
      ];

      ctx.ui.notify(lines.join("\n"), "info");
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
    const bridge = await detectAntigravityBridge();
    const hasKey = !!resolveApiKey();

    if (bridge) {
      ctx.ui.notify("pi-voice loaded [Antigravity bridge active, Alt+V to toggle]", "info");
    } else if (hasKey) {
      ctx.ui.notify("pi-voice loaded [Cloud Gemini mode, Alt+V to toggle]", "info");
    } else {
      ctx.ui.notify("pi-voice loaded. Run /voice-key or start Antigravity for voice input.", "info");
    }
  });
}
