// plugins/claude-code/src/classifier.ts
// Decides ASKING vs IDLE for a session whose last assistant message had
// stop_reason=end_turn. Heuristic runs first (always free); LLM is called
// only when heuristic returns UNKNOWN and status_analysis is configured.

import { createHash } from "crypto";

export type ClassifierVerdict = "ASKING" | "IDLE" | "UNKNOWN";

export interface ClassifierConfig {
  status_analysis: "none" | "anthropic" | "openai";
  anthropic_api_key?: string;
  openai_api_key?: string;
}

// Hardcoded to the cheapest/fastest model per provider — this is a 1-token
// ASKING-vs-IDLE classification, Haiku-class is plenty. When a provider
// bumps their "latest haiku" snapshot, update these constants.
const ANTHROPIC_MODEL = "claude-haiku-4-5";
const OPENAI_MODEL = "gpt-5-mini";

// ── Heuristic ────────────────────────────────────────────────────────────────

const TRIGGER_PHRASES = [
  /\bwould you like\b/i,
  /\bdo you want\b/i,
  /\bshould i\b/i,
  /\bshall i\b/i,
  /\bwhich (one|option|approach|would)\b/i,
  /\bplease (confirm|advise|clarify|let me know|choose)\b/i,
  /\blet me know\b/i,
  /\b(confirm|clarify) (this|that|the|before|whether)\b/i,
  /\b(can|could) you (confirm|clarify|tell me|share|provide)\b/i,
];

/** Strip trailing markdown/whitespace so `?` detection works on real tail. */
function tailText(text: string): string {
  // Remove trailing whitespace, markdown list-ending fluff, code fences.
  let t = text.trim();
  // Drop a trailing code fence line if present.
  t = t.replace(/\n*```[a-zA-Z]*\s*$/g, "").trim();
  return t;
}

/** Detect if the message ends with a numbered-options block (e.g. "1. Foo\n2. Bar"). */
function endsWithNumberedOptions(text: string): boolean {
  const lines = text.trim().split("\n").slice(-6);
  let numberedLines = 0;
  for (const line of lines) {
    if (/^\s*\d+[.)]\s+\S/.test(line)) numberedLines++;
  }
  return numberedLines >= 2;
}

export function classifyHeuristic(text: string): ClassifierVerdict {
  if (!text || text.trim().length === 0) return "UNKNOWN";

  const tail = tailText(text);

  // Strong signal: ends with a question mark.
  if (/[?？]\s*$/.test(tail)) return "ASKING";

  // Strong signal: numbered options at the end — usually "pick one".
  if (endsWithNumberedOptions(tail)) return "ASKING";

  // Weaker signals: trigger phrases anywhere in last ~500 chars.
  const window = tail.slice(-500);
  for (const re of TRIGGER_PHRASES) {
    if (re.test(window)) return "ASKING";
  }

  return "UNKNOWN";
}

// ── LLM ──────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT =
  "Reply with a single character: A if the message below is asking the user a question or requesting input, I if it's a statement/summary/completion with no open request. Nothing else.";

const MAX_INPUT_CHARS = 2000;

interface ProviderCall {
  (text: string, config: ClassifierConfig): Promise<ClassifierVerdict>;
}

const anthropicProvider: ProviderCall = async (text, config) => {
  const apiKey = config.anthropic_api_key;
  if (!apiKey) return "UNKNOWN";
  const model = ANTHROPIC_MODEL;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: text.slice(-MAX_INPUT_CHARS) }],
    }),
  });

  if (!resp.ok) {
    throw new Error(`Anthropic API ${resp.status}: ${await resp.text()}`);
  }

  const json = (await resp.json()) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const out = json.content?.[0]?.text?.trim().toUpperCase() ?? "";
  if (out.startsWith("A")) return "ASKING";
  if (out.startsWith("I")) return "IDLE";
  return "UNKNOWN";
};

const openaiProvider: ProviderCall = async (text, config) => {
  const apiKey = config.openai_api_key;
  if (!apiKey) return "UNKNOWN";
  const model = OPENAI_MODEL;

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text.slice(-MAX_INPUT_CHARS) },
      ],
    }),
  });

  if (!resp.ok) {
    throw new Error(`OpenAI API ${resp.status}: ${await resp.text()}`);
  }

  const json = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const out = json.choices?.[0]?.message?.content?.trim().toUpperCase() ?? "";
  if (out.startsWith("A")) return "ASKING";
  if (out.startsWith("I")) return "IDLE";
  return "UNKNOWN";
};

// ── Cache + orchestration ────────────────────────────────────────────────────

const verdictCache = new Map<string, ClassifierVerdict>();

function hashKey(text: string, providerId: string): string {
  return createHash("sha256")
    .update(providerId)
    .update("\0")
    .update(text)
    .digest("hex");
}

/**
 * Run heuristic; if UNKNOWN and an LLM provider is configured, call it.
 * Caches LLM verdicts by (provider, text) hash. Returns `null` if the
 * provider is misconfigured / call fails — callers should treat that as IDLE.
 */
export async function classify(
  text: string | undefined,
  config: ClassifierConfig,
  onError?: (err: unknown) => void,
): Promise<{ verdict: ClassifierVerdict; source: "heuristic" | "llm" | "fallback" }> {
  if (!text) return { verdict: "IDLE", source: "fallback" };

  const heuristic = classifyHeuristic(text);
  if (heuristic !== "UNKNOWN") {
    return { verdict: heuristic, source: "heuristic" };
  }

  if (config.status_analysis === "none") {
    return { verdict: "IDLE", source: "fallback" };
  }

  const providerId = config.status_analysis;
  const key = hashKey(text, providerId);
  const cached = verdictCache.get(key);
  if (cached) return { verdict: cached, source: "llm" };

  const provider = providerId === "anthropic" ? anthropicProvider : openaiProvider;
  try {
    const verdict = await provider(text, config);
    const final = verdict === "UNKNOWN" ? "IDLE" : verdict;
    verdictCache.set(key, final);
    return { verdict: final, source: "llm" };
  } catch (err) {
    onError?.(err);
    return { verdict: "IDLE", source: "fallback" };
  }
}

/** For testing / reset. */
export function _clearClassifierCache() {
  verdictCache.clear();
}
