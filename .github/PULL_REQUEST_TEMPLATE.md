## What does this PR do?

A clear description of the change.

## Related issues

Fixes #...

## Checklist

- [ ] Tests added/updated and passing (`npm test`)
- [ ] Config-driven where applicable (no hardcoded behavior in `cli.ts`)
- [ ] Error boundary preserved (tools return `{ status: "error" }`, never throw)
- [ ] Ollama concurrency constraint respected (sequential utility calls)
- [ ] README/docs updated if behavior changed

## Screenshots / logs (if applicable)
