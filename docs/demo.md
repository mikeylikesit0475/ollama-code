# Demo Walkthrough

This guide shows the harness in action. It assumes you've completed the
[Setup](../README.md#setup) and have a model running.

## 1. Start the agent

```bash
npm start
```

You'll see the welcome banner and a `❯` prompt. The agent resumes your most
recent session automatically.

## 2. Ask a question (no tools)

```bash
❯ what does this project do?
```

The agent reads the repo and answers. For a quick one-shot Q&A without entering
the REPL:

```bash
npm start -- --ask "what does this project do?"
```

## 3. Make a change

```bash
❯ add a function that greets a user by name in src/utils.ts
```

The agent plans, writes the file, and verifies it. You'll see tool calls
rendered inline with confirmation prompts.

## 4. Run a task autonomously

```bash
npm start -- --exec "add a README section for the new feature" --full-auto
```

`--full-auto` skips confirmation prompts for a fully autonomous run.

## 5. Check the environment

```bash
❯ /doctor
```

Shows the health of every integration: Ollama, git, bwrap, gh, MCP, LSP, config.

## 6. Scan for vulnerabilities (defensive)

```bash
❯ /vuln
```

Scans the workspace for SQL injection, command injection, hardcoded secrets,
path traversal, and dependency vulnerabilities — in your own code, for you to fix.

## 7. Manage memory

```bash
❯ /init      # bootstrap MEMORY.md from the repo structure
❯ /dream     # consolidate the session into MEMORY.md
❯ /memory    # view MEMORY.md
```

The stale-memory guard nudges you to `/dream` when MEMORY.md is out of date.

## 8. Extend it

Create a `.ollama-code.json` to add permissions, sub-agents, MCP servers,
plugins, and custom commands — all without touching the core:

```json
{
  "permissions": { "allow": ["git_status", "git_diff"] },
  "commands": [{ "name": "lint", "prompt": "Run the linter and fix errors. {input}" }]
}
```

## 9. Debug a failure

```bash
npm start -- --repro ~/.ollama-code/repro/repro-123.json
```

Replays a captured request to reproduce a bug deterministically.

## 10. Share a session

```bash
❯ /share          # export to a markdown file
❯ /share gist     # post to a GitHub gist
```
