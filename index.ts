import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type EditorComponent,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
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

type VoiceMode = "idle" | "recording" | "finalizing" | "cancelled";
type VoiceEngine = "bridge" | "cloud";

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

function collapseCJKSpaces(text: string): string {
  return text.replace(
    /([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af])\s+([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af])/gu,
    "$1$2"
  );
}

function extractProjectTokens(cwd: string, limit = 50): string[] {
  const tokens = new Set<string>();
  const tokenRegex = /\b[a-zA-Z_$][a-zA-Z0-9_$]{2,35}\b/g;

  // 1. Git branch and modified files context (inspired by language_server AsrContext)
  try {
    const gitBranch = spawnSync("git", ["branch", "--show-current"], { cwd, encoding: "utf8" });
    if (gitBranch.stdout) {
      for (const part of gitBranch.stdout.trim().split(/[\/_\-\s]+/)) {
        if (part.length > 2 && /^[a-zA-Z0-9]+$/.test(part)) tokens.add(part);
      }
    }
    const gitStatus = spawnSync("git", ["status", "--short"], { cwd, encoding: "utf8" });
    if (gitStatus.stdout) {
      for (const line of gitStatus.stdout.split("\n")) {
        const file = line.trim().split(/\s+/).pop();
        if (file) {
          const base = path.basename(file, path.extname(file));
          if (base.length > 2) tokens.add(base);
        }
      }
    }
  } catch {}

  // 2. Workspace source files scanning
  try {
    const files = fs.readdirSync(cwd, { withFileTypes: true });
    for (const dirent of files) {
      if (dirent.name.startsWith(".") || dirent.name === "node_modules") continue;
      if (dirent.isFile() && /\.(ts|js|py|go|rs|json|md)$/i.test(dirent.name)) {
        try {
          const content = fs.readFileSync(path.join(cwd, dirent.name), "utf8").slice(0, 6000);
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

  return Array.from(tokens).slice(0, limit);
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

function computeRms(buffer: Buffer): number {
  if (buffer.length < 2) return 0;
  let sumSq = 0;
  const numSamples = Math.floor(buffer.length / 2);
  for (let i = 0; i < buffer.length; i += 2) {
    const s = buffer.readInt16LE(i);
    sumSq += s * s;
  }
  return Math.sqrt(sumSq / (numSamples || 1));
}

function getVuWave(rms: number): string {
  if (rms < 40) return "····";
  if (rms < 200) return " ▂  ";
  if (rms < 600) return " ▂▃ ";
  if (rms < 1500) return " ▂▃▄";
  if (rms < 3000) return "▂▃▅▆";
  return "▃▅▆█";
}

async function transcribeFastDraft(
  wavBuffer: Buffer,
  apiKey: string,
  biasingHints: string
): Promise<string> {
  const voiceConfig = readVoiceConfig();
  const model = voiceConfig.model || "gemini-2.5-flash";
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
  const voiceConfig = readVoiceConfig();
  const model = voiceConfig.model || "gemini-2.5-flash";
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
  const cleaned = candidateText.replace(/^["'`]+|["'`]+$/g, "").trim();
  return collapseCJKSpaces(cleaned);
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface VoiceEditorOptions {
  ctx: ExtensionContext;
  getMode(): VoiceMode;
  getEngine(): VoiceEngine;
  getDurationSec(): string;
  getLiveDraft(): string;
  getRms(): number;
  getTick(): number;
  onSend(ctx: ExtensionContext): void;
  onToggle(ctx: ExtensionContext): void;
  onCancel(ctx: ExtensionContext): void;
}

function formatTopBorderLine(
  width: number,
  leftLabel: string,
  rightLabel: string,
  borderFn: (s: string) => string
): string {
  if (width <= 0) return "";
  const leftW = visibleWidth(leftLabel);
  const rightW = visibleWidth(rightLabel);

  if (leftW + rightW + 2 >= width) {
    const avail = Math.max(0, width - leftW - 2);
    const right = truncateToWidth(rightLabel, avail, "");
    const gap = Math.max(0, width - leftW - visibleWidth(right) - 2);
    return borderFn("─") + leftLabel + borderFn("─".repeat(gap)) + right + borderFn("─");
  }

  const gap = Math.max(0, width - leftW - rightW - 2);
  return borderFn("─") + leftLabel + borderFn("─".repeat(gap)) + rightLabel + borderFn("─");
}

class VoiceEditorWrapper implements EditorComponent {
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  borderColor?: (str: string) => string;

  constructor(
    private readonly base: EditorComponent,
    private readonly options: VoiceEditorOptions,
    private readonly defaultBorderColor: (str: string) => string
  ) {}

  private get baseRecord(): Record<string, unknown> {
    return this.base as unknown as Record<string, unknown>;
  }

  get actionHandlers(): Map<string, () => void> | undefined {
    return this.baseRecord.actionHandlers as Map<string, () => void> | undefined;
  }

  get onCtrlD(): (() => void) | undefined {
    return this.baseRecord.onCtrlD as (() => void) | undefined;
  }
  set onCtrlD(handler: (() => void) | undefined) {
    this.baseRecord.onCtrlD = handler;
  }

  get onEscape(): (() => void) | undefined {
    return this.baseRecord.onEscape as (() => void) | undefined;
  }
  set onEscape(handler: (() => void) | undefined) {
    this.baseRecord.onEscape = handler;
  }

  get onPasteImage(): (() => void) | undefined {
    return this.baseRecord.onPasteImage as (() => void) | undefined;
  }
  set onPasteImage(handler: (() => void) | undefined) {
    this.baseRecord.onPasteImage = handler;
  }

  get onExtensionShortcut(): ((data: string) => void) | undefined {
    return this.baseRecord.onExtensionShortcut as ((data: string) => void) | undefined;
  }
  set onExtensionShortcut(handler: ((data: string) => void) | undefined) {
    this.baseRecord.onExtensionShortcut = handler;
  }

  get focused(): boolean {
    return Boolean((this.base as EditorComponent & { focused?: boolean }).focused);
  }
  set focused(value: boolean) {
    (this.base as EditorComponent & { focused?: boolean }).focused = value;
  }

  invalidate(): void {
    this.base.invalidate();
  }

  getText(): string {
    return this.base.getText();
  }

  setText(text: string): void {
    this.base.setText(text);
  }

  insertTextAtCursor?(text: string): void {
    if (this.base.insertTextAtCursor) {
      this.base.insertTextAtCursor(text);
    }
  }

  addToHistory?(text: string): void {
    if (this.base.addToHistory) {
      this.base.addToHistory(text);
    }
  }

  getExpandedText?(): string {
    return this.base.getExpandedText ? this.base.getExpandedText() : this.base.getText();
  }

  private syncBase(): void {
    if (this.onSubmit) this.base.onSubmit = this.onSubmit;
    else delete this.base.onSubmit;

    if (this.onChange) this.base.onChange = this.onChange;
    else delete this.base.onChange;

    if (this.borderColor) this.base.borderColor = this.borderColor;
  }

  private applyBorderTheme(): void {
    const mode = this.options.getMode();
    const theme = this.options.ctx.ui.theme;

    if (mode === "recording") {
      this.base.borderColor = (str: string) => theme.fg("error", str);
    } else if (mode === "finalizing") {
      this.base.borderColor = (str: string) => theme.fg("warning", str);
    } else {
      this.base.borderColor = this.defaultBorderColor;
    }
  }

  render(width: number): string[] {
    this.syncBase();
    this.applyBorderTheme();

    const lines = this.base.render(width);
    if (lines.length === 0) return lines;

    const theme = this.options.ctx.ui.theme;
    const mode = this.options.getMode();
    const engine = this.options.getEngine();
    const duration = this.options.getDurationSec();
    const rms = this.options.getRms();
    const tick = this.options.getTick();
    const liveDraft = this.options.getLiveDraft();

    let leftBadge = "";
    let rightBadge = "";

    if (mode === "recording") {
      const dot = tick % 2 === 0 ? "●" : "○";
      const vu = getVuWave(rms);
      leftBadge = ` ${theme.fg("error", dot)} ${theme.fg("accent", `[${engine} ${duration}s]`)} ${theme.fg("accent", vu)} `;
      rightBadge = ` ${theme.fg("dim", "enter: send · alt+v: finish · esc: cancel")} `;
    } else if (mode === "finalizing") {
      const frame = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? "⠋";
      leftBadge = ` ${theme.fg("warning", frame)} ${theme.fg("warning", `[${engine}: reconciling context...]`)} `;
      rightBadge = ` ${theme.fg("dim", "esc: cancel")} `;
    } else if (mode === "cancelled") {
      leftBadge = ` ${theme.fg("dim", "[cancelled]")} `;
      rightBadge = ` ${theme.fg("dim", "alt+v")} `;
    } else {
      leftBadge = ` ${theme.fg("dim", `[voice: ${engine}]`)} `;
      rightBadge = ` ${theme.fg("dim", "alt+v / f4")} `;
    }

    const borderFn = (s: string) => (this.base.borderColor ? this.base.borderColor(s) : s);
    lines[0] = formatTopBorderLine(width, leftBadge, rightBadge, borderFn);

    if ((mode === "recording" || mode === "finalizing") && liveDraft) {
      const cursor = tick % 2 === 0 ? "▌" : " ";
      const banner = truncateToWidth(
        ` ${theme.fg("accent", "❯")} ${theme.fg("dim", `"${liveDraft}"`)} ${theme.fg("accent", cursor)}`,
        Math.max(1, width),
        "…"
      );
      lines.unshift(banner);
    }

    return lines;
  }

  handleInput(data: string): void {
    this.syncBase();
    const mode = this.options.getMode();

    if (mode === "recording") {
      if (matchesKey(data, "enter")) {
        this.options.onSend(this.options.ctx);
        return;
      }
      if (matchesKey(data, "escape")) {
        this.options.onCancel(this.options.ctx);
        return;
      }
    }

    if (mode === "finalizing") {
      if (matchesKey(data, "escape")) {
        this.options.onCancel(this.options.ctx);
        return;
      }
    }

    if (matchesKey(data, "alt+v") || matchesKey(data, "f4")) {
      this.options.onToggle(this.options.ctx);
      return;
    }

    this.base.handleInput(data);
  }
}

function createVoiceEditorProxy(
  previousFactory: ((tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) => EditorComponent) | undefined,
  options: VoiceEditorOptions & { attachTui(tui: TUI): void }
) {
  return (tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager): EditorComponent => {
    options.attachTui(tui);
    const base = previousFactory?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
    const defaultBorderColor = base.borderColor ?? theme.borderColor;
    const wrapper = new VoiceEditorWrapper(base, options, defaultBorderColor);

    return new Proxy(wrapper, {
      get(target, prop, receiver) {
        if (Reflect.has(target, prop)) {
          const val = Reflect.get(target, prop, receiver);
          if (typeof val === "function") return val.bind(target);
          return val;
        }
        const baseVal = Reflect.get(base, prop);
        if (typeof baseVal === "function") return baseVal.bind(base);
        return baseVal;
      },
      set(target, prop, value, receiver) {
        if (Reflect.has(target, prop)) {
          return Reflect.set(target, prop, value, receiver);
        }
        return Reflect.set(base, prop, value);
      },
    }) as unknown as EditorComponent;
  };
}

export default function (pi: ExtensionAPI) {
  let mode: VoiceMode = "idle";
  let activeEngine: VoiceEngine = "bridge";
  let isRecording = false;
  let recordProcess: ChildProcess | null = null;
  let recordedChunks: Buffer[] = [];
  let recordStartTime = 0;
  let animTimer: NodeJS.Timeout | null = null;
  let cloudDraftInterval: NodeJS.Timeout | null = null;
  let draftInProgress = false;
  let initialEditorText = "";
  let latestDraftText = "";
  let currentRms = 0;
  let animTick = 0;
  let activeTui: TUI | undefined;

  let activeBridge: AntigravityBridge | null = null;
  let bridgeSessionId: string | null = null;
  let bridgeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let bridgeSeq = 0;
  let bridgeFinalTranscript = "";
  let bridgePendingAudio: Buffer[] = [];

  const requestRender = () => activeTui?.requestRender();

  function startAnimation() {
    if (animTimer) return;
    animTimer = setInterval(() => {
      animTick += 1;
      requestRender();
    }, 120);
  }

  function stopAnimation() {
    if (animTimer) {
      clearInterval(animTimer);
      animTimer = null;
    }
    requestRender();
  }

  async function startBridgeStream(
    bridge: AntigravityBridge,
    editorText: string,
    ctx: ExtensionContext
  ): Promise<boolean> {
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
                  const sep = initialEditorText && !initialEditorText.endsWith(" ") ? " " : "";
                  ctx.ui.setEditorText(initialEditorText + sep + text);
                  requestRender();
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
        "No engine available. Run '/voice-key' to set Gemini key, or start Antigravity for unlimited bridge.",
        "warning"
      );
      return;
    }

    isRecording = true;
    mode = "recording";
    recordedChunks = [];
    recordStartTime = Date.now();
    initialEditorText = ctx.ui.getEditorText() || "";
    latestDraftText = "";
    currentRms = 0;
    draftInProgress = false;

    const projectTokens = extractProjectTokens(ctx.cwd, 35);
    const biasingHints = projectTokens.slice(0, 10).join(", ");

    let usingBridge = false;
    if (activeBridge) {
      usingBridge = await startBridgeStream(activeBridge, initialEditorText, ctx);
    }
    activeEngine = usingBridge ? "bridge" : "cloud";

    startAnimation();

    // Live Draft polling: only run if explicitly enabled in voice.json
    // On Free Tier (5 RPM limit), polling every 1.4s consumes the quota in seconds.
    const vCfg = readVoiceConfig();
    if (!usingBridge && apiKey && vCfg.liveDraft === true) {
      cloudDraftInterval = setInterval(async () => {
        if (!isRecording || draftInProgress) return;

        const pcmSnapshot = Buffer.concat(recordedChunks);
        if (pcmSnapshot.length < 16000 * 2 * 1.5) return;

        // VAD: only poll when audio is active
        if (currentRms < 40) return;

        draftInProgress = true;
        try {
          const wavSnapshot = pcmToWav(pcmSnapshot, 16000);
          const draft = await transcribeFastDraft(wavSnapshot, apiKey, biasingHints);
          if (isRecording && draft && draft !== "[NO_SPEECH]") {
            latestDraftText = collapseCJKSpaces(draft);
            const sep = initialEditorText && !initialEditorText.endsWith(" ") ? " " : "";
            ctx.ui.setEditorText(initialEditorText + sep + latestDraftText);
            requestRender();
          }
        } catch {} finally {
          draftInProgress = false;
        }
      }, 2500);
    }

    try {
      recordProcess = spawn("arecord", ["-q", "-r", "16000", "-c", "1", "-f", "S16_LE", "-t", "raw"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err: any) {
      isRecording = false;
      mode = "idle";
      stopAnimation();
      if (cloudDraftInterval) clearInterval(cloudDraftInterval);
      ctx.ui.notify(`Failed to start arecord: ${err.message}`, "error");
      logVoice(`arecord spawn error: ${err.message}`);
      return;
    }

    let pcmSliceBuffer = Buffer.alloc(0);
    const CHUNK_SIZE = 1280; // 40ms

    recordProcess.stdout?.on("data", (chunk: Buffer) => {
      recordedChunks.push(chunk);

      // Compute live RMS for VU meter
      const sliceBytes = Math.min(chunk.length, 1280);
      currentRms = computeRms(chunk.slice(chunk.length - sliceBytes));

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

  async function stopRecording(ctx: ExtensionContext, autoSubmit = false): Promise<void> {
    if (!isRecording) return;
    isRecording = false;
    mode = "finalizing";
    requestRender();

    if (cloudDraftInterval) {
      clearInterval(cloudDraftInterval);
      cloudDraftInterval = null;
    }

    if (recordProcess) {
      const proc = recordProcess;
      recordProcess = null;
      await new Promise<void>((resolve) => {
        proc.on("close", () => resolve());
        proc.kill("SIGTERM");
        setTimeout(resolve, 200);
      });
    }

    const pcmBuffer = Buffer.concat(recordedChunks);
    const totalBytes = pcmBuffer.length;
    const durationSec = (totalBytes / (16000 * 2)).toFixed(1);

    if (totalBytes < 4800) {
      mode = "idle";
      stopAnimation();
      ctx.ui.setEditorText(initialEditorText);
      ctx.ui.notify(`Recording too short (${durationSec}s).`, "warning");
      return;
    }

    const finalRms = computeRms(pcmBuffer);
    logVoice(`Recording stopped: ${durationSec}s, ${totalBytes} bytes, RMS: ${finalRms.toFixed(1)}`);

    if (finalRms < 35) {
      mode = "idle";
      stopAnimation();
      ctx.ui.setEditorText(initialEditorText);
      ctx.ui.notify(`Microphone level low (RMS: ${finalRms.toFixed(1)}).`, "warning");
      logVoice("Warning: audio RMS below threshold (< 35)");
      return;
    }

    let finalTranscript = "";

    if (activeBridge && bridgeSessionId) {
      try {
        const bridgeText = await endBridgeSession();
        if (bridgeText && bridgeText !== "[NO_SPEECH]") {
          finalTranscript = bridgeText;
        } else if (latestDraftText) {
          finalTranscript = latestDraftText;
        }
      } catch (err: any) {
        logVoice(`Bridge finalize failed: ${err.message}, attempting cloud fallback`);
      }
    }

    if (!finalTranscript) {
      const apiKey = resolveApiKey();
      if (apiKey) {
        try {
          const wavBuffer = pcmToWav(pcmBuffer, 16000);
          const projectTokens = extractProjectTokens(ctx.cwd, 40);
          finalTranscript = await transcribeFinalReconciliation(
            wavBuffer,
            apiKey,
            initialEditorText,
            projectTokens
          );
        } catch (err: any) {
          logVoice(`Cloud fallback error: ${err.message}`);
          if (
            err.message.includes("429") ||
            err.message.includes("RESOURCE_EXHAUSTED") ||
            err.message.includes("quota")
          ) {
            const retryMatch =
              err.message.match(/retry in ([0-9.]+)s/i) || err.message.match(/retryDelay"?:\s*"([0-9]+)s"/i);
            const waitSec = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : 60;
            ctx.ui.notify(
              `Gemini API rate limit reached. Retry in ${waitSec}s, or switch model with /voice-model.`,
              "warning"
            );
          } else {
            ctx.ui.notify(`Transcription error: ${err.message}`, "error");
          }
        }
      }
    }

    mode = "idle";
    stopAnimation();

    if (!finalTranscript || finalTranscript === "[NO_SPEECH]") {
      if (latestDraftText) {
        finalTranscript = latestDraftText;
      } else {
        ctx.ui.setEditorText(initialEditorText);
        ctx.ui.notify(`Recorded ${durationSec}s. No speech detected.`, "info");
        logVoice(`Transcribed (${durationSec}s): [NO_SPEECH]`);
        return;
      }
    }

    const sep = initialEditorText && !initialEditorText.endsWith(" ") ? " " : "";
    const fullText = initialEditorText + sep + finalTranscript;

    if (autoSubmit) {
      ctx.ui.setEditorText("");
      if (ctx.isIdle()) {
        pi.sendUserMessage(fullText);
      } else {
        pi.sendUserMessage(fullText, { deliverAs: "followUp" });
      }
      ctx.ui.notify(`[Sent voice]: "${finalTranscript}"`, "info");
      logVoice(`Auto-submitted (${durationSec}s): "${finalTranscript}"`);
    } else {
      ctx.ui.setEditorText(fullText);
      ctx.ui.notify(`[${durationSec}s ${activeEngine}]: "${finalTranscript}"`, "info");
      logVoice(`Finalized (${durationSec}s): "${finalTranscript}"`);
    }
  }

  function cancelRecording(ctx: ExtensionContext) {
    if (!isRecording && mode === "idle") return;

    isRecording = false;
    mode = "cancelled";
    stopAnimation();

    if (cloudDraftInterval) {
      clearInterval(cloudDraftInterval);
      cloudDraftInterval = null;
    }

    if (recordProcess) {
      recordProcess.kill("SIGTERM");
      recordProcess = null;
    }

    if (bridgeReader) {
      try {
        bridgeReader.cancel();
      } catch {}
      bridgeReader = null;
    }

    ctx.ui.setEditorText(initialEditorText);
    ctx.ui.notify("Voice recording cancelled.", "info");
    logVoice("Voice recording cancelled by user (Escape).");

    setTimeout(() => {
      if (mode === "cancelled") {
        mode = "idle";
        requestRender();
      }
    }, 800);
  }

  function toggleVoice(ctx: ExtensionContext) {
    if (isRecording) {
      stopRecording(ctx, false);
    } else {
      startRecording(ctx);
    }
  }

  const editorOptions: VoiceEditorOptions & { attachTui(tui: TUI): void } = {
    ctx: undefined as unknown as ExtensionContext,
    getMode: () => mode,
    getEngine: () => activeEngine,
    getDurationSec: () => ((Date.now() - recordStartTime) / 1000).toFixed(1),
    getLiveDraft: () => latestDraftText,
    getRms: () => currentRms,
    getTick: () => animTick,
    attachTui: (tui: TUI) => {
      activeTui = tui;
    },
    onSend: (handlerCtx) => {
      void stopRecording(handlerCtx, true);
    },
    onToggle: (handlerCtx) => {
      toggleVoice(handlerCtx);
    },
    onCancel: (handlerCtx) => {
      cancelRecording(handlerCtx);
    },
  };

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

  pi.registerCommand("voice-model", {
    description: "Inspect or configure speech transcription model",
    handler: async (args, ctx) => {
      const targetModel = args.trim();
      const currentConfig = readVoiceConfig();

      if (!targetModel) {
        const activeModel = currentConfig.model || "gemini-2.5-flash";
        ctx.ui.notify(
          `Active model: ${activeModel}\nUsage: /voice-model <model-name>\nOptions: gemini-2.5-flash, gemini-3.5-flash-lite`,
          "info"
        );
        return;
      }

      currentConfig.model = targetModel;
      try {
        fs.mkdirSync(path.dirname(VOICE_CONFIG_FILE), { recursive: true });
        fs.writeFileSync(VOICE_CONFIG_FILE, JSON.stringify(currentConfig, null, 2), { mode: 0o600 });
        ctx.ui.notify(`Configured voice model to: ${targetModel}`, "info");
      } catch (err: any) {
        ctx.ui.notify(`Failed to save model: ${err.message}`, "error");
      }
    },
  });

  pi.registerCommand("voice-status", {
    description: "Inspect voice transcription engine status",
    handler: async (_args, ctx) => {
      const vCfg = readVoiceConfig();
      const activeModel = vCfg.model || "gemini-2.5-flash";
      const bridge = await detectAntigravityBridge();
      const apiKey = resolveApiKey();

      const lines = [
        `Engine: ${bridge ? "Antigravity Bridge (local ConnectRPC)" : "Standalone Gemini (direct cloud)"}`,
        `Model: ${activeModel}`,
        `API key: ${apiKey ? `Configured (...${apiKey.slice(-6)})` : "Not set"}`,
        `Live draft: ${vCfg.liveDraft === true ? "Enabled" : "Adaptive single-pass (quota-safe)"}`,
        `Controls: Enter (send), Alt+V / F4 (edit), Esc (cancel)`,
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
    editorOptions.ctx = ctx;

    const uiRecord = ctx.ui as unknown as Record<string, unknown> | undefined;
    const getEditorFn =
      typeof uiRecord?.getEditorComponent === "function"
        ? (uiRecord.getEditorComponent as () => unknown)
        : undefined;
    const previousEditor = getEditorFn ? getEditorFn() : undefined;
    const setEditorFn =
      typeof uiRecord?.setEditorComponent === "function"
        ? (uiRecord.setEditorComponent as (factory: unknown) => void)
        : undefined;

    if (setEditorFn) {
      const previousFactory =
        typeof previousEditor === "function"
          ? (previousEditor as Parameters<typeof createVoiceEditorProxy>[0])
          : undefined;
      setEditorFn(createVoiceEditorProxy(previousFactory, editorOptions));
    }

    const bridge = await detectAntigravityBridge();
    const hasKey = !!resolveApiKey();

    if (bridge) {
      activeEngine = "bridge";
      ctx.ui.notify("pi-voice active [Bridge connected, Alt+V to toggle]", "info");
    } else if (hasKey) {
      activeEngine = "cloud";
      ctx.ui.notify("pi-voice active [Standalone Gemini mode, Alt+V to toggle]", "info");
    } else {
      ctx.ui.notify("pi-voice ready. Run /voice-key to configure Gemini API key.", "info");
    }
  });

  pi.on("session_shutdown", () => {
    stopAnimation();
    if (cloudDraftInterval) clearInterval(cloudDraftInterval);
    if (recordProcess) recordProcess.kill("SIGTERM");
    if (bridgeReader) {
      try {
        bridgeReader.cancel();
      } catch {}
    }
  });
}
