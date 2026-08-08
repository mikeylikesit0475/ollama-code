# Ollama Code

A local, terminal-based coding agent modeled after Claude Code's UX, built on
[`@google/adk`](https://www.npmjs.com/package/@google/adk). Runs against local
Ollama models by default, with a switch to Gemini/cloud models when you want more
horsepower.

## Setup

```bash
npm install
```

Create a `.env` file in the project root (see variables below), then start Ollama
locally and pull a model, e.g.:

```bash
ollama pull gemma4-coder-tuned:latest
```

### Environment variables

| Variable | Purpose | Default |
| --- | --- | --- |
| `GEMINI_API_KEY` | Set to the literal string `ollama` to force local mode at startup; set to a real Gemini API key to use cloud mode. | — |
| `OLLAMA_MODEL` | Default local model name. | `gemma4-coder-tuned:latest` |
| `OLLAMA_BASE_URL` | Base URL of your local Ollama server. | `http://localhost:11434` |
| `GIT_AUTO_COMMIT` | Set to `true` to auto-generate and create a commit after every turn. | `false` |
| `AUTO_FIX_CS_NAMESPACES` | Set to `true` to let `execute_bash` auto-insert missing C#/Unity `using` statements on build errors, without a confirmation prompt. Off by default since it silently edits files. | `false` |
| `OLLAMA_CODE_DEBUG` | Set to any truthy value to dump full request/response payloads to `~/.ollama-code/debug.log` for diagnosing adapter issues. | off |

## Running

```bash
npm start                       # local Ollama mode (or cloud, if GEMINI_API_KEY=ollama is unset)
npm start -- code               # force local Ollama mode
npm start -- cloud               # force cloud (Gemini) mode
npm start -- <model-name>        # start with a specific model (local or gemini-*/claude-*)
npm start -- --model <name>      # same, explicit flag form
npm start -- --atomic-commits    # auto-commit after every turn
npm start -- --ask "question"    # one-shot Q&A (no tools, no session), then exit
npm start -- --exec "task"       # one-shot autonomous agent run, then exit
npm start -- --continue          # resume the most recent session
npm start -- --session <id>      # resume a specific session by id
npm start -- --verbose           # surface ADK logs + debug dump (same as --debug)
npm start -- --tui               # open the interactive session browser before the REPL
npm start -- --full-auto         # skip all confirmation prompts (autonomous mode)
npm start -- --repro <file>      # replay a captured request to reproduce a bug
```

Model resolution at startup: a bare positional arg starting with `gemini-` or
`claude-` switches to cloud mode; anything else is treated as a local Ollama model
name.

## Slash commands

| Command | Description |
| --- | --- |
| `/help` | Show the help menu. |
| `/paste` | Paste multi-line text directly from the clipboard (avoids split prompts). |
| `/clear` | Clear the terminal screen. |
| `/reset` | Reset conversation history and start a fresh session. |
| `/status` | Show current Git status and active model. |
| `/model [name]` | List downloaded Ollama models, or switch to `name` (local or `gemini-*`/`claude-*` for cloud). |
| `/review` | Run an adversarial code review over the current uncommitted diff. |
| `/review-diff` | Show the full diff and accept (keep) or discard it via `git restore`. |
| `/explain <target>` | Explain a file or code section. |
| `/fix <target>` | Investigate and fix a bug or error. |
| `/tests <target>` | Write tests for a target following project conventions. |
| `/index` | Build the semantic-search embedding index. |
| `/gh <args>` | Run a GitHub CLI command (e.g. `/gh pr list`). |
| `/permissions` | Reload and show permission rules. |
| `/agents` | List available sub-agents. |
| `/mcp` | List configured MCP servers. |
| `/share [gist]` | Export the current session to a file (or a GitHub gist). |
| `/lsp <file>` | Run LSP diagnostics on a file. |
| `/plugins` | List loaded plugins. |
| `/compact` | Manually compact the conversation context. |
| `/init` | Bootstrap `MEMORY.md` from the repo structure. |
| `/memory [edit]` | View `MEMORY.md`, or open it in your editor. |
| `/context` | Show a detailed context-window breakdown. |
| `/rewind [n]` | Discard the last `n` turns and start fresh. |
| `/add-dir <path>` | Add a directory to the allowed workspace paths. |
| `/doctor` | Run an environment health check. |
| `/config [edit]` | View the config file, or open it in your editor. |
| `/version` | Show the version. |
| `/update` | Self-update via `git pull`. |
| `/cost` | Show token usage and estimated cost for this session. |
| `/login <key>` | Set cloud (Gemini) credentials. |
| `/logout` | Clear cloud credentials. |
| `/statusline` | Show the status line. |
| `/apply <patch>` | Apply a `.patch`/`.diff` file via `git apply`. |
| `/fork` | Fork a new session off the current one. |
| `/audit [n]` | Show the last `n` tool calls from the audit log. |
| `/vuln [static\|deps\|review\|all]` | Scan the workspace for security vulnerabilities (defensive only). |
| `/repro <file>` | Replay a captured request to reproduce a bug. |
| `/mcp add <name> <cmd> [args]` | Add an MCP server to config. |
| `/mcp remove <name>` | Remove an MCP server from config. |
| `/dream` | Consolidate the current session's history into `MEMORY.md`. |
| `/exit`, `/quit` | Exit the runtime. |

While typing `/`, matching commands autocomplete below the prompt — use `Tab` or
the `↑`/`↓` arrows to select, `Enter` to confirm, `Esc` to clear the line.

## Agent tools

The model can invoke these tools directly; most file/command-executing tools ask
for inline `[y/N]` confirmation before running:

- `execute_bash` — run a shell command (with a workspace-confinement check and a
  compiler-error auto-fix pre-pass for missing C# `using` statements).
- `read_file` / `read_files` — read one or more files, optionally by line range.
- `write_file` — create or fully overwrite a file (blocked on a second write to the
  same path within a turn — use `edit_file` instead).
- `edit_file` — apply one or more exact (or fuzzy-whitespace) text replacements,
  with `dryRun` support for diff previews.
- `list_dir` / `glob_files` / `grep_search` — browse and search the workspace.
- `semantic_search` — meaning-based (embedding) search over the codebase; use when
  `grep_search` can't match because the wording differs. Index is built on first use
  via Ollama's `/api/embed` (model: `OLLAMA_EMBED_MODEL`, default `nomic-embed-text`).
- `run_background_command` / `get_background_output` / `kill_background_job` — manage
  long-running processes like dev servers.
- `web_fetch` — fetch the raw text/HTML of a URL.
- `todo_write` — maintain a checklist in `TODO.md`.
- `git_status` / `git_diff` / `git_log` / `git_add` / `git_commit` / `git_restore` —
  read and mutate Git state without leaving the CLI.
- `gh_pr` / `gh_issue` / `gh_comment` — GitHub workflows via the `gh` CLI (requires
  `gh` installed and authenticated).
- `delegate_to_agent` — dispatch a subtask to a named sub-agent (`reviewer`,
  `planner`, `tester`, `researcher`, or a custom one from config).
- MCP tools — any tools exposed by configured MCP servers, prefixed with the
  server name (e.g. `github_create_issue`).
- `vuln_scan` — scan the workspace for common security vulnerabilities (SQL
  injection, command injection, hardcoded secrets, path traversal, dependency
  vulnerabilities). **Defensive only** — finds issues in your own code so they
  can be fixed; it never exploits anything.

## Configuration (`.ollama-code.json`)

A per-project config file (gitignored) enables opencode-style features. It is
read from `<workspace>/.ollama-code.json`, falling back to
`~/.ollama-code/config.json` (which also holds the persisted model/sandbox
choice written by the CLI).

```json
{
  "model": "gemma4-coder-tuned:latest",
  "permissions": {
    "allow": ["git_status", "git_diff", "git_log", "read_file", "read_files"],
    "deny":  ["execute_bash:rm -rf", "git_restore"],
    "ask":   ["write_file", "edit_file"]
  },
  "subagents": [
    {
      "name": "mydocs",
      "description": "Writes documentation for a target",
      "instruction": "You are a technical writer. Given a target, write clear documentation.",
      "tools": ["read_file", "grep_search", "write_file"]
    }
  ],
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }
  },
  "plugins": [
    {
      "name": "log-tools",
      "hooks": {
        "beforeTool": "console.log('[tool]', name, JSON.stringify(args))",
        "afterTurn": "console.log('[turn done]')"
      }
    }
  ],
  "commands": [
    { "name": "lint", "description": "Run the linter", "prompt": "Run the project linter and fix any errors. {input}" }
  ],
  "lsp": {
    "typescript": { "command": "typescript-language-server", "args": ["--stdio"] }
  }
}
```

- **`model`** — default model (overrides the env default; CLI args still win).
- **`permissions`** — granular allow/deny/ask rules per tool and path. A rule is a
  bare tool name (`"git_status"`) or `"tool:pattern"` where `*` is a wildcard
  (`"read_file:src/*"`). Deny wins over allow; unmatched tools fall back to their
  normal `[y/N]` prompt. Reload with `/permissions`.
- **`subagents`** — custom named sub-agents with their own prompt and tool subset,
  usable via `delegate_to_agent`. List with `/agents`.
- **`mcpServers`** — external MCP servers (stdio transport). Their tools are loaded
  at startup and merged into the agent's toolset. List with `/mcp`.
- **`plugins`** — lifecycle hooks (`beforeTool`, `afterTool`, `beforeTurn`,
  `afterTurn`) evaluated as JS with a context object. List with `/plugins`.
- **`commands`** — user-defined slash commands. `{input}` is replaced with the
  command's arguments. They appear in autocomplete and run via a utility agent.
- **`lsp`** — language servers for real-time diagnostics (`/lsp <file>`) and
  go-to-definition.

All file and command tools are confined to the current working directory (and its
subdirectories); operations that would touch paths outside it are denied.

## Persistence

- Conversation sessions persist across restarts to SQLite at
  `~/.ollama-code/sessions.db`; the CLI resumes your most recent session on launch.
- `MEMORY.md` in the project root is injected into every turn's context and can be
  refreshed manually via `/dream`, or automatically in the background after each
  turn when running in cloud mode.

## Testing

```bash
npm test
```

Runs the `node --test` suite in `tests/`, covering the SSE parser/tool-call
accumulator (`lib/sse.ts`) and the glob/fuzzy-match helpers (`lib/matchers.ts`).

## Robustness

- **Global error boundary** — every tool execution is wrapped in a try/catch that
  returns a structured `{ status: "error" }` to the model instead of crashing the
  turn.
- **Retry with backoff** — flaky external calls (Ollama, MCP, gh, web_fetch) retry
  transient failures (network, 5xx, timeouts) with exponential backoff + jitter.
- **Chaos tests** — `tests/chaos.test.ts` feeds the harness malformed inputs
  (garbage SSE, pathological JSON, throwing tools) and asserts it recovers.
- **`--repro` / `/repro`** — captures the exact request/response that caused a bug
  and replays it deterministically for debugging.
- **Stale-memory guard** — if `MEMORY.md` is older than the last commit (or work
  happened since it was written), the agent is nudged to run `/dream` so it never
  works from stale context.
- **Cross-platform CI** — `.github/workflows/ci.yml` runs the suite on
  Linux/macOS/Windows × Node 20/22.

## Project layout

```
cli.ts                     REPL entry point: env/model config, main loop, session handling
lib/ollama-llm.ts          OllamaLlm adapter (ADK BaseLlm -> Ollama's streaming endpoint)
lib/ui.ts                  Color palette, spinner/streaming state, prompt UI, printers
lib/workspace.ts           Path confinement, directory/glob walking, git-repo helpers
lib/indexer.ts             Semantic-search embedding index (Ollama /api/embed)
lib/permissions.ts         Granular allow/deny/ask permission rules
lib/subagents.ts           Named, configurable sub-agents (delegate_to_agent)
lib/mcp.ts                 MCP client (stdio transport) for external servers
lib/plugins.ts             Lifecycle hook registry (before/after tool & turn)
lib/config.ts              Unified .ollama-code.json config loader
lib/share.ts               Session export to file / GitHub gist
lib/lsp.ts                 Lightweight LSP client (diagnostics, go-to-definition)
lib/tui.ts                 Minimal session-browser TUI (--tui)
lib/health.ts              Environment health check (/doctor)
lib/cost.ts                Token usage + cost tracking (/cost)
lib/audit.ts               Structured tool-call audit log (/audit)
lib/vuln.ts                Defensive vulnerability scanner (/vuln)
lib/retry.ts               Retry-with-backoff for flaky external calls
lib/repro.ts               Request capture + replay (--repro / /repro)
lib/loop-guard.ts          Shared per-turn tool-call cap + repeat-write/edit bookkeeping
lib/sse.ts                 SSE parsing + tool-call accumulation + JSON repair
lib/matchers.ts            Glob-to-regex + fuzzy whitespace matching
lib/tools/                 Tool definitions, grouped by concern (fs, exec, git, search, web, background jobs)
tests/                     node:test suites for lib/
MEMORY.md                  Persistent project memory, re-injected into every turn
TODO.md                    Checklist maintained by the todo_write tool
```
