// ─── Loop Guard ──────────────────────────────────────────────────────────────
// Turn-scoped bookkeeping shared by execute_bash, write_file, edit_file, and
// run_background_command: caps total tool calls per turn, and records recent
// write/edit targets so a model stuck rewriting the same file gets stopped
// rather than looping silently.

export interface ToolCallHistoryEntry {
  toolName: string;
  targetPath?: string;
  oldText?: string;
  command?: string;
  cwd?: string;
}

export const MAX_TOOL_CALLS_PER_TURN = 40;

// A run of this many consecutive execute_bash calls with no intervening
// write/edit is treated as thrashing. The exact-repeat guard only catches
// identical commands; a stuck model can dodge it by slightly varying the
// command each time (ls, ls -la, pwd, ls again). This catches the *pattern*.
export const MAX_CONSECUTIVE_BASH = 5;

export const loopGuard = {
  history: [] as ToolCallHistoryEntry[],
  halted: false,
  toolCallsThisTurn: 0,
};

export function resetLoopGuard() {
  loopGuard.history.length = 0;
  loopGuard.halted = false;
  loopGuard.toolCallsThisTurn = 0;
}

// Increments the per-turn call counter and halts the guard if the cap was
// just exceeded. Returns true when the caller should abort and return an
// error instead of proceeding.
export function exceedsToolCallCap(): boolean {
  loopGuard.toolCallsThisTurn++;
  if (loopGuard.toolCallsThisTurn > MAX_TOOL_CALLS_PER_TURN) {
    loopGuard.halted = true;
    return true;
  }
  return false;
}

// True when the last MAX_CONSECUTIVE_BASH entries in history are all
// execute_bash calls with no intervening write/edit. A model that keeps
// running shell commands without ever changing a file is thrashing — it is
// probing the system instead of acting on it. The exact-repeat guard catches
// identical commands; this catches the broader pattern of bash-only churn.
export function isBashThrashing(): boolean {
  if (loopGuard.history.length < MAX_CONSECUTIVE_BASH) return false;
  const tail = loopGuard.history.slice(-MAX_CONSECUTIVE_BASH);
  return tail.every((entry) => entry.toolName === "execute_bash");
}
