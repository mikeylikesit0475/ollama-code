# Contributing

Thanks for your interest in contributing to Ollama Code! This project is a
from-scratch harness for building autonomous coding agents. Contributions that
make it more reliable, more extensible, or better documented are especially
welcome.

## Getting started

1. Fork the repo and clone it.
2. `npm install`
3. Run the tests: `npm test`
4. Make your change, add tests, and run the suite again.

## What we're looking for

- **Bug fixes** — especially around tool-calling reliability, context
  management, and error handling.
- **New tools** — anything that makes the agent more capable (search, git,
  web, MCP, LSP).
- **Extensibility** — config-driven features that don't require editing the
  core loop.
- **Documentation** — the README, `docs/`, and code comments.
- **Tests** — the chaos suite (`tests/chaos.test.ts`) is a great place to add
  failure-injection cases.

## Guidelines

- **Keep it config-driven.** Prefer adding a config option over hardcoding
  behavior in `cli.ts`.
- **Never break the error boundary.** Every tool must return a structured
  `{ status: "error" }` on failure, never throw.
- **Respect the Ollama concurrency constraint.** Utility-agent calls must run
  sequentially (see `docs/engineering.md` §3).
- **Add tests.** New logic should come with tests in `tests/`.
- **Match the style.** The codebase uses TypeScript, `node:test`, and clear
  section comments.

## Pull request process

1. Create a branch: `git checkout -b feat/my-feature`
2. Make your changes and add tests.
3. Run `npm test` — all tests must pass.
4. Push and open a PR. Describe what you changed and why.

## Code of conduct

Be respectful and constructive. This is a learning project — help others level
up rather than tearing them down.
