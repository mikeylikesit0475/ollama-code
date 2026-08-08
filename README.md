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
- `run_background_command` / `get_background_output` / `kill_background_job` — manage
  long-running processes like dev servers.
- `web_fetch` — fetch the raw text/HTML of a URL.
- `todo_write` — maintain a checklist in `TODO.md`.
- `git_status` / `git_diff` / `git_log` / `git_add` / `git_commit` / `git_restore` —
  read and mutate Git state without leaving the CLI.

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

## Project layout

```
cli.ts                     REPL entry point: env/model config, main loop, session handling
lib/ollama-llm.ts          OllamaLlm adapter (ADK BaseLlm -> Ollama's streaming endpoint)
lib/ui.ts                  Color palette, spinner/streaming state, prompt UI, printers
lib/workspace.ts           Path confinement, directory/glob walking, git-repo helpers
lib/loop-guard.ts          Shared per-turn tool-call cap + repeat-write/edit bookkeeping
lib/sse.ts                 SSE parsing + tool-call accumulation + JSON repair
lib/matchers.ts            Glob-to-regex + fuzzy whitespace matching
lib/tools/                 Tool definitions, grouped by concern (fs, exec, git, search, web, background jobs)
tests/                     node:test suites for lib/
MEMORY.md                  Persistent project memory, re-injected into every turn
TODO.md                    Checklist maintained by the todo_write tool
```
