# Project Memory — Ollama Code CLI

## What this is

A local, terminal-based coding agent (`cli.ts`) built on `@google/adk`, modeled after
Claude Code's UX. Runs against local Ollama models by default, with an escape hatch to
Gemini/cloud models via `/model <name>` or the `cloud` CLI arg. Entry point: `npm start`
(`tsx cli.ts`).

## Architecture

- `cli.ts` — REPL entry point: env/model config (local Ollama vs. cloud), the main
  input loop, session persistence, and the auto-commit/adversarial-review/auto-dream
  helpers. No longer holds tool definitions or UI internals directly.
- `lib/ollama-llm.ts` — the `OllamaLlm` adapter bridging ADK's `BaseLlm` to Ollama's
  `/v1/chat/completions` SSE endpoint. Exposes `lastResponse` per-instance (not a
  module global) for the token-usage footer, and `getContextWindow()` for the
  context-% footer.
- `lib/ui.ts` — color palette, spinner/streaming-output coordination, the readline
  autocomplete prompt, and console printers. Slash-command/model-suggestion data is
  injected once via `configurePromptSuggestions()` rather than imported, so this
  module has no dependency on cli.ts's state.
- `lib/workspace.ts` — path confinement (`isPathInWorkspace`), directory/glob
  walking, and git-repo bootstrapping (`ensureGitRepository`, `getGitContext`).
- `lib/loop-guard.ts` — shared per-turn tool-call cap and repeat-write/edit
  bookkeeping used by execute_bash/write_file/edit_file/run_background_command.
- `lib/tools/` — the 19 tool definitions grouped by concern: `fs-tools.ts`,
  `exec-tools.ts`, `git-tools.ts`, `search-tools.ts`, `web-tools.ts`,
  `background-jobs.ts`, re-exported as `allTools` via `index.ts`.
- `lib/sse.ts` — SSE line parser + tool-call chunk accumulator + JSON-repair for
  malformed tool arguments from small models. Covered by `tests/sse.test.ts`.
- `lib/matchers.ts` — glob-to-regex conversion and fuzzy whitespace matching for
  `edit_file`. Covered by `tests/matchers.test.ts`.
- Sessions persist to SQLite at `~/.ollama-code/sessions.db` via `DatabaseSessionService`.

## Known constraints

- Ollama runs with `OLLAMA_NUM_PARALLEL=1`, so a second concurrent request (e.g. an
  LLM-based summarizer) deadlocks against the main call. Context compaction uses
  `TruncatingContextCompactor` only in local mode — no `LlmSummarizer`.
- `num_ctx` must match the model's loaded context length or Ollama reloads weights
  (~60s stall per request).
- Per-model sampling params live in `ollamaModelParams` — greedy decoding (`top_k:1`)
  previously caused repetition loops in 12B models; current defaults use `top_k:40`,
  `top_p:0.9`, `repeat_penalty:1.15`.

## Status

TODO.md steps 1-3 are done (command list honesty, path confinement, adapter
resilience). Step 4's read_file/grep size caps and web_fetch SSRF/HTML
sanitization are done; "surface stderr on success" for execute_bash is done
(exec-tools.ts now surfaces stderr even on exit-0 via the spawn-based
runCommand). Step 5's README is done; elapsed spinner, interrupt hint, and
persisting `/model` across restarts are still open; the context-% footer is
done (printTokenUsage renders a fill bar from getContextWindow). `cli.ts` has
been split into `lib/ollama-llm.ts`, `lib/ui.ts`, `lib/workspace.ts`,
`lib/loop-guard.ts`, and `lib/tools/` (see Architecture above).

## Notes for `/dream`

This file is read back into every turn via `getMemoryContext()`. Keep it factual
and third-person — no questions to the user, no "Shall I proceed?" style dialogue.
