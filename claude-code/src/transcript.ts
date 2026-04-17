// plugins/claude-code/src/transcript.ts
// Pure-TS replacement for the portable bits of ~/bin/cc-sessions.
// Discovers Claude Code JSONL transcripts, tails the last few records, and
// extracts the signals needed to classify session state.

import { readdirSync, statSync, readSync, openSync, closeSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const PROJECTS_ROOT = join(homedir(), ".claude", "projects");
const TAIL_BYTES = 32 * 1024; // 32KB: enough for ~dozen records, cheap to re-read.

export interface SessionFile {
  /** Absolute path to the JSONL transcript. */
  path: string;
  /** Last modification time (ms since epoch). */
  mtimeMs: number;
  /** Session UUID (filename without `.jsonl`). */
  sessionId: string;
  /** Decoded cwd from the encoded project directory name. */
  projectPath: string;
}

export interface JsonlRecord {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  message?: {
    role?: "assistant" | "user" | "system";
    content?: string | Array<{ type: string; text?: string }>;
    stop_reason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";
  };
  // Other fields ignored.
  [k: string]: unknown;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "stop_sequence";

export interface TranscriptSummary {
  sessionId: string;
  projectPath: string;
  cwd: string;
  path: string;
  mtimeMs: number;
  lastRecordType: string | undefined;
  lastAssistantStopReason: StopReason | undefined;
  lastAssistantText: string | undefined;
  lastTimestampMs: number | undefined;
  hasLastPromptMarker: boolean;
}

/**
 * Decode Claude Code's directory-name encoding.
 *
 * `~/.claude/projects/-Users-will-code-OmniDeck/*.jsonl` → `/Users/will/code/OmniDeck`
 *
 * The encoding replaces `/` with `-`. This is lossy (real `-` in paths
 * becomes ambiguous), so we approximate: leading `-` → `/`, and any
 * subsequent `-` → `/`. If the directory name has none of these markers,
 * we return it as-is.
 */
export function decodeProjectPath(encoded: string): string {
  if (!encoded.startsWith("-")) return encoded;
  return "/" + encoded.slice(1).split("-").join("/");
}

/** Enumerate every JSONL transcript under ~/.claude/projects. */
export function discoverSessions(): SessionFile[] {
  const out: SessionFile[] = [];
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(PROJECTS_ROOT);
  } catch {
    return out;
  }

  for (const projDir of projectDirs) {
    const projPath = join(PROJECTS_ROOT, projDir);
    let entries: string[];
    try {
      entries = readdirSync(projPath);
    } catch {
      continue;
    }

    const decoded = decodeProjectPath(projDir);

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const full = join(projPath, entry);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      out.push({
        path: full,
        mtimeMs: st.mtimeMs,
        sessionId: entry.replace(/\.jsonl$/, ""),
        projectPath: decoded,
      });
    }
  }

  return out;
}

/**
 * Read the last ~TAIL_BYTES of a file and parse from the end. Returns up to
 * `maxRecords` valid JSON objects (most-recent first).
 */
export function readLastRecords(path: string, maxRecords = 12): JsonlRecord[] {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return [];
  }

  try {
    const st = statSync(path);
    const size = st.size;
    const readLen = Math.min(TAIL_BYTES, size);
    const offset = size - readLen;

    const buf = Buffer.alloc(readLen);
    readSync(fd, buf, 0, readLen, offset);
    const text = buf.toString("utf-8");

    // Split on newlines; drop any partial leading fragment if we read from
    // mid-file (the first line is likely incomplete).
    const lines = text.split("\n");
    if (offset > 0 && lines.length > 0) {
      lines.shift();
    }

    const records: JsonlRecord[] = [];
    for (let i = lines.length - 1; i >= 0 && records.length < maxRecords; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as JsonlRecord);
      } catch {
        // Skip malformed line.
      }
    }
    return records;
  } finally {
    closeSync(fd);
  }
}

/** Extract plain text from an assistant message's `content` field. */
function extractAssistantText(msg: JsonlRecord["message"]): string | undefined {
  if (!msg || msg.role !== "assistant") return undefined;
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const block of c) {
      if (block && block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return undefined;
}

/**
 * Parse the tail of a transcript into a summary suitable for classification.
 */
export function summarize(file: SessionFile): TranscriptSummary {
  const records = readLastRecords(file.path, 12);

  // Records are newest-first. Scan to find:
  //  - the last record type
  //  - whether a last-prompt marker exists anywhere in the tail
  //  - the last assistant message + its stop_reason
  //  - the last timestamp
  let lastRecordType: string | undefined;
  let hasLastPromptMarker = false;
  let lastAssistantStopReason: StopReason | undefined;
  let lastAssistantText: string | undefined;
  let lastTimestampMs: number | undefined;
  let cwd = file.projectPath;

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (i === 0) lastRecordType = r.type;
    if (r.type === "last-prompt") hasLastPromptMarker = true;
    if (!lastTimestampMs && r.timestamp) {
      const t = Date.parse(r.timestamp);
      if (!Number.isNaN(t)) lastTimestampMs = t;
    }
    if (!lastAssistantText && r.message?.role === "assistant") {
      lastAssistantText = extractAssistantText(r.message);
      lastAssistantStopReason = r.message.stop_reason;
    }
    if (r.cwd && typeof r.cwd === "string") cwd = r.cwd;
  }

  return {
    sessionId: file.sessionId,
    projectPath: file.projectPath,
    cwd,
    path: file.path,
    mtimeMs: file.mtimeMs,
    lastRecordType,
    lastAssistantStopReason,
    lastAssistantText,
    lastTimestampMs: lastTimestampMs ?? file.mtimeMs,
    hasLastPromptMarker,
  };
}
