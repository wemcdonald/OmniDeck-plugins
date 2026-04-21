// plugins/claude-code/src/focus/index.ts
// Orchestrator for focus strategies. Tries each available strategy in the
// configured order, returns on first success.

import type { OmniDeck } from "@omnideck/agent-sdk";
import { tmuxStrategy } from "./tmux";
import { itermStrategy } from "./iterm";
import { appStrategy } from "./app";

export type StrategyId = "tmux" | "iterm" | "app";

export interface FocusHints {
  /**
   * Absolute path to the session's JSONL transcript. Used to disambiguate
   * the specific claude process when several are running under the same cwd.
   */
  transcriptPath?: string;
}

export interface FocusStrategy {
  id: StrategyId;
  /** Cheap check — should avoid subprocesses where possible. */
  isAvailable(omnideck: OmniDeck): Promise<boolean>;
  /** Attempt to focus the terminal at `cwd`. Returns true on success. */
  focus(omnideck: OmniDeck, cwd: string, hints: FocusHints): Promise<boolean>;
}

const STRATEGIES: Record<StrategyId, FocusStrategy> = {
  tmux: tmuxStrategy,
  iterm: itermStrategy,
  app: appStrategy,
};

export async function focusCwd(
  omnideck: OmniDeck,
  cwd: string,
  order: StrategyId[],
  hints: FocusHints = {},
): Promise<{ ok: boolean; used?: StrategyId; tried: StrategyId[] }> {
  const tried: StrategyId[] = [];
  for (const id of order) {
    const strat = STRATEGIES[id];
    if (!strat) continue;
    let available = false;
    try {
      available = await strat.isAvailable(omnideck);
    } catch (err) {
      omnideck.log.debug(`focus strategy ${id} availability check threw`, {
        err: String(err),
      });
    }
    if (!available) continue;

    tried.push(id);
    try {
      const ok = await strat.focus(omnideck, cwd, hints);
      if (ok) return { ok: true, used: id, tried };
    } catch (err) {
      omnideck.log.warn(`focus strategy ${id} threw`, { err: String(err) });
    }
  }
  return { ok: false, tried };
}
