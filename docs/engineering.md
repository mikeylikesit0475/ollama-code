# Engineering Deep-Dive

This document explains the hard problems this harness solves and how. It's
written for engineers evaluating the project — and as a record of the design
decisions behind each subsystem.

## 1. Tool-calling reliability

Small local models routinely emit malformed tool calls: trailing commas,
unclosed braces, truncated JSON. A harness that crashes on these is useless.

**Approach:**
- `lib/sse.ts` — a streaming SSE parser that accumulates tool-call chunks by
  index (so parallel calls to the *same* tool stay distinct) and repairs
  malformed JSON arguments (`safeParseToolArguments`).
- `lib/loop-guard.ts` — a per-turn tool-call cap, a repeat-command guard, and a
  "thrash guard" that detects a model stuck running diagnostics without ever
  changing a file.
- `lib/tools/index.ts` — a global error boundary wrapping every tool, so a
  throwing tool returns a structured `{ status: "error" }` to the model instead
  of killing the turn.

## 2. Context management

Agents lose track of what they've done as conversations grow. The naive fix
(truncate old events) is lossy.

**Approach:**
- `lib/compaction.ts` — a running-summary compactor that summarizes the
  conversation *after* each turn (sequentially, to avoid deadlocking Ollama's
  single-request model) and injects the summary into the next turn's prompt. The
  summary survives truncation, so important facts persist.
- `lib/scratchpad.ts` — lightweight session state (modified files, active
  errors) injected every turn.
- **Stale-memory guard** — flags when `MEMORY.md` is older than the last commit,
  so the agent is nudged to refresh before working from outdated context.

## 3. The Ollama concurrency constraint

Ollama runs with `OLLAMA_NUM_PARALLEL=1`, so a second concurrent request
deadlocks against the main call. This is a classic footgun: the stock ADK
`LlmSummarizer` fires a second request *inside* the runner, hanging the CLI.

**Approach:** every utility-agent call (planning, summarization, delegation,
auto-commit) runs *sequentially* — before the main turn, after it, or during
tool execution when the main LLM call has already completed. The constraint is
documented in `lib/utility.ts` and enforced by design.

## 4. Extensibility

A harness is only useful if it can grow. Every major capability is config-driven
via a single `.ollama-code.json`:

- **Permissions** (`lib/permissions.ts`) — allow/deny/ask rules per tool and
  path, with deny-wins-over-allow precedence.
- **Sub-agents** (`lib/subagents.ts`) — named agents with their own prompts and
  tool subsets, dispatched via `delegate_to_agent`.
- **MCP** (`lib/mcp.ts`) — a client that connects to external MCP servers and
  merges their tools into the agent's toolset.
- **Plugins** (`lib/plugins.ts`) — lifecycle hooks (`beforeTool`, `afterTurn`,
  etc.) evaluated as JS.
- **Custom commands** — user-defined slash commands with `{input}` templating.
- **LSP** (`lib/lsp.ts`) — a lightweight JSON-RPC client for diagnostics and
  go-to-definition.

## 5. Safety

- **Workspace confinement** — all file/command tools are confined to the working
  directory; out-of-workspace operations are denied or escalated.
- **Sandboxing** (`lib/sandbox.ts`) — optional bwrap confinement for
  `execute_bash` (network blocked, filesystem confined).
- **SSRF guards** (`lib/tools/web-tools.ts`) — `web_fetch` rejects private,
  loopback, and link-local targets, and re-validates on every redirect hop.
- **Defensive vuln scanning** (`lib/vuln.ts`) — finds SQL injection, command
  injection, hardcoded secrets, path traversal, and dependency vulnerabilities
  in the user's own code.

## 6. Robustness

- **Retry with backoff** (`lib/retry.ts`) — flaky external calls (Ollama, MCP,
  gh, web) retry transient failures with exponential backoff + jitter.
- **Chaos tests** (`tests/chaos.test.ts`) — feed the harness malformed inputs
  and assert it recovers.
- **Repro mode** (`lib/repro.ts`) — captures the exact request/response that
  caused a bug and replays it deterministically.
- **Cross-platform CI** — Linux/macOS/Windows × Node 20/22.
