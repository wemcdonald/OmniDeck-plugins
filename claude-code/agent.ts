// plugins/claude-code/agent.ts
// Agent-side plugin: watches ~/.claude/projects/*/*/*.jsonl, classifies each
// session's state, and pushes the session list to the hub. Handles the
// "focus" action by running the configured focus strategy chain.

import type { OmniDeck, ActionResult } from "@omnideck/agent-sdk";
import { discoverSessions, summarize, type TranscriptSummary } from "./src/transcript";
import { classify, type ClassifierConfig } from "./src/classifier";
import { focusCwd, type StrategyId } from "./src/focus/index";

const AGENT_CODE_VERSION = 2;

export type SessionState = "WORKING" | "ASKING" | "DONE" | "STALE";

export interface Session {
  sessionId: string;
  projectPath: string;
  cwd: string;
  state: SessionState;
  lastActivityMs: number;
  lastAssistantText?: string;
  classifierSource?: "heuristic" | "llm" | "fallback";
}

interface ClassifyCacheEntry {
  mtimeMs: number;
  lastTextHash: string;
  session: Session;
}

function configNum(
  omnideck: OmniDeck,
  key: string,
  fallback: number,
): number {
  const v = omnideck.config[key];
  return typeof v === "number" ? v : fallback;
}

function configStr<T extends string>(
  omnideck: OmniDeck,
  key: string,
  fallback: T,
): T {
  const v = omnideck.config[key];
  return typeof v === "string" ? (v as T) : fallback;
}

function configArr<T extends string>(
  omnideck: OmniDeck,
  key: string,
  fallback: T[],
): T[] {
  const v = omnideck.config[key];
  return Array.isArray(v) ? (v as T[]) : fallback;
}

function hashText(t: string | undefined): string {
  if (!t) return "-";
  let h = 0;
  for (let i = 0; i < t.length; i++) h = ((h * 31) | 0) + t.charCodeAt(i);
  return String(h);
}

/**
 * Primary classifier: JSONL structure first (WORKING/ASKING/STALE are certain);
 * sessions that have ended produce STALE immediately. Everything else that's
 * running and waiting at a prompt is DONE — and stays DONE until either the
 * exit marker appears or the stale-timeout safety net trips (abrupt kill).
 */
async function classifySession(
  summary: TranscriptSummary,
  config: ClassifierConfig,
  staleTimeoutMs: number,
  onErr: (err: unknown) => void,
): Promise<Session> {
  let state: SessionState;
  let classifierSource: Session["classifierSource"];

  const lastActivityMs = summary.lastTimestampMs ?? summary.mtimeMs;
  const ageMs = Date.now() - lastActivityMs;

  if (summary.lastRecordType === "last-prompt") {
    // Session exited — the transcript's latest record is the marker.
    // We intentionally do NOT trigger STALE from `hasLastPromptMarker` alone,
    // because a resumed session leaves the historical marker in the tail
    // while writing new live records after it.
    state = "STALE";
  } else if (summary.lastAssistantStopReason === "tool_use") {
    state = "WORKING";
  } else if (summary.lastRecordType === "user") {
    state = "WORKING";
  } else if (summary.lastAssistantStopReason === "end_turn") {
    const { verdict, source } = await classify(summary.lastAssistantText, config, onErr);
    state = verdict === "ASKING" ? "ASKING" : "DONE";
    classifierSource = source;
  } else {
    state = "DONE";
  }

  // Safety net: a session whose process was killed (no last-prompt marker)
  // eventually ages out to STALE so dead rows stop looking live.
  if (state !== "WORKING" && ageMs > staleTimeoutMs) {
    state = "STALE";
  }

  return {
    sessionId: summary.sessionId,
    projectPath: summary.projectPath,
    cwd: summary.cwd,
    state,
    lastActivityMs,
    lastAssistantText: summary.lastAssistantText,
    classifierSource,
  };
}

export default function init(omnideck: OmniDeck) {
  omnideck.log.info(`claude-code agent loaded (v${AGENT_CODE_VERSION})`);

  const classifyCache = new Map<string, ClassifyCacheEntry>();
  let lastPushedJson = "";

  async function pollOnce() {
    const pollIntervalMs = configNum(omnideck, "poll_interval_ms", 5000);
    const staleTimeoutMs = configNum(omnideck, "stale_timeout_ms", 86_400_000);

    const classifierCfg: ClassifierConfig = {
      status_analysis: configStr(omnideck, "status_analysis", "none") as ClassifierConfig["status_analysis"],
      anthropic_api_key: configStr(omnideck, "anthropic_api_key", ""),
      openai_api_key: configStr(omnideck, "openai_api_key", ""),
    };

    // Health: misconfigured when a provider is selected without its key.
    if (classifierCfg.status_analysis === "anthropic" && !classifierCfg.anthropic_api_key) {
      omnideck.setHealth?.({
        status: "misconfigured",
        message: "Status analysis is set to Claude but no Anthropic API key is configured.",
      });
    } else if (classifierCfg.status_analysis === "openai" && !classifierCfg.openai_api_key) {
      omnideck.setHealth?.({
        status: "misconfigured",
        message: "Status analysis is set to ChatGPT but no OpenAI API key is configured.",
      });
    } else {
      omnideck.setHealth?.({ status: "ok" });
    }

    const files = discoverSessions();
    const sessions: Session[] = [];
    let llmErrors = 0;

    for (const f of files) {
      // Skip re-classification if mtime unchanged and we already have a cached
      // non-DONE result. DONE/STALE rely on age, so we re-evaluate those.
      const cached = classifyCache.get(f.path);
      if (
        cached &&
        cached.mtimeMs === f.mtimeMs &&
        cached.session.state !== "DONE" &&
        cached.session.state !== "STALE"
      ) {
        sessions.push(cached.session);
        continue;
      }

      try {
        const summary = summarize(f);
        const session = await classifySession(
          summary,
          classifierCfg,
          staleTimeoutMs,
          (err) => {
            llmErrors++;
            omnideck.log.warn("classifier LLM error", { err: String(err) });
          },
        );
        classifyCache.set(f.path, {
          mtimeMs: f.mtimeMs,
          lastTextHash: hashText(summary.lastAssistantText),
          session,
        });
        sessions.push(session);
      } catch (err) {
        omnideck.log.warn(`failed to classify ${f.path}`, { err: String(err) });
      }
    }

    // Prune cache entries whose files no longer exist.
    const livePaths = new Set(files.map((f) => f.path));
    for (const p of classifyCache.keys()) {
      if (!livePaths.has(p)) classifyCache.delete(p);
    }

    if (llmErrors > 0) {
      omnideck.setHealth?.({
        status: "error",
        message: `Classifier LLM had ${llmErrors} error(s) this poll — falling back to heuristics.`,
      });
    }

    // Diff before push — avoid state spam.
    const payload = JSON.stringify(sessions);
    if (payload !== lastPushedJson) {
      omnideck.setState("sessions", sessions);
      lastPushedJson = payload;
      omnideck.log.debug(`pushed ${sessions.length} sessions`);
    }

    // Mark plugin "active" whenever any session exists — this tells the hub to
    // set `active_agent = <this hostname>`, which is what the StateProvider and
    // PageProvider use to resolve a target. (Without this, target-less button
    // presses can't find the right agent.)
    const anyLive = sessions.some((s) => s.state !== "STALE");
    omnideck.setActive?.(anyLive);

    // Reschedule.
    return pollIntervalMs;
  }

  // Simple self-scheduling loop so we pick up interval changes on the fly.
  let handle = omnideck.setInterval(() => {
    pollOnce().catch((err) => {
      omnideck.log.error("poll error", { err: String(err) });
    });
  }, configNum(omnideck, "poll_interval_ms", 5000));

  // Kick an immediate poll.
  pollOnce().catch((err) => omnideck.log.error("initial poll error", { err: String(err) }));

  omnideck.onReloadConfig(() => {
    omnideck.log.info("config reloaded, resetting poll interval");
    lastPushedJson = "";
    omnideck.clearInterval(handle);
    handle = omnideck.setInterval(() => {
      pollOnce().catch((err) => omnideck.log.error("poll error", { err: String(err) }));
    }, configNum(omnideck, "poll_interval_ms", 5000));
    pollOnce().catch((err) => omnideck.log.error("reload poll error", { err: String(err) }));
  });

  // ── Action handler: focus ─────────────────────────────────────────────────
  omnideck.onAction("focus", async (params): Promise<ActionResult> => {
    const sessionId = params.session_id as string | undefined;
    const explicitCwd = params.cwd as string | undefined;

    let cwd = explicitCwd;
    let transcriptPath: string | undefined;
    // Always look up the transcript path — it's how we disambiguate which
    // claude process we want when several share the same cwd (multiple tmux
    // windows rooted at the same directory).
    if (sessionId) {
      for (const entry of classifyCache.values()) {
        if (entry.session.sessionId === sessionId) {
          cwd = cwd ?? entry.session.cwd;
          // classifyCache keys are the transcript file paths.
          for (const [path, cached] of classifyCache.entries()) {
            if (cached.session.sessionId === sessionId) {
              transcriptPath = path;
              break;
            }
          }
          break;
        }
      }
      if (!cwd || !transcriptPath) {
        for (const f of discoverSessions()) {
          if (f.sessionId === sessionId) {
            transcriptPath = transcriptPath ?? f.path;
            if (!cwd) {
              try {
                cwd = summarize(f).cwd;
              } catch {
                // ignore
              }
            }
            break;
          }
        }
      }
    }

    if (!cwd) {
      return { success: false, error: "Could not resolve cwd for session" };
    }

    const order = configArr<StrategyId>(omnideck, "focus_strategies", [
      "tmux",
      "iterm",
      "app",
    ]);
    const result = await focusCwd(omnideck, cwd, order, { transcriptPath });
    if (result.ok) {
      omnideck.log.info(`focused session ${sessionId} via ${result.used}`);
      return { success: true, result: { used: result.used } };
    }
    omnideck.log.warn(`focus failed, tried: ${result.tried.join(",")}`);
    return {
      success: false,
      error: `No focus strategy succeeded (tried: ${result.tried.join(", ") || "none"})`,
    };
  });

  omnideck.onDestroy(() => {
    omnideck.clearInterval(handle);
  });
}
