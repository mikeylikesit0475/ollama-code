// ─── Active Structured Scratchpad ─────────────────────────────────────
// Maintains lightweight session state (modified files, recent verification errors)
// that is injected into system context every turn, surviving context truncation.

interface ScratchpadState {
  modifiedFiles: Set<string>;
  activeErrors: Map<string, string>;
  currentPhase?: string;
}

const state: ScratchpadState = {
  modifiedFiles: new Set<string>(),
  activeErrors: new Map<string, string>(),
};

export const scratchpad = {
  recordFileChange(filePath: string) {
    state.modifiedFiles.add(filePath);
  },
  recordError(filePath: string, errorMsg: string) {
    state.activeErrors.set(filePath, errorMsg);
  },
  clearError(filePath: string) {
    state.activeErrors.delete(filePath);
  },
  setPhase(phase: string) {
    state.currentPhase = phase;
  },
  reset() {
    state.modifiedFiles.clear();
    state.activeErrors.clear();
    state.currentPhase = undefined;
  },
  getContextPrompt(): string {
    if (state.modifiedFiles.size === 0 && state.activeErrors.size === 0 && !state.currentPhase) {
      return "";
    }
    const lines: string[] = ["\n--- ACTIVE SESSION SCRATCHPAD ---"];
    if (state.currentPhase) {
      lines.push(`Current Phase: ${state.currentPhase}`);
    }
    if (state.modifiedFiles.size > 0) {
      lines.push(`Modified Files This Session (${state.modifiedFiles.size}):`);
      for (const f of state.modifiedFiles) {
        lines.push(`  - ${f}`);
      }
    }
    if (state.activeErrors.size > 0) {
      lines.push(`\nActive Unresolved Errors:`);
      for (const [f, err] of state.activeErrors.entries()) {
        lines.push(`  - ${f}: ${err}`);
      }
    }
    lines.push("---");
    return lines.join("\n");
  }
};
