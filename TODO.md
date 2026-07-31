# Task Checklist

- [x] Step 1: Code honesty — trim commands list to real commands, remove forwarding fallback
- [x] Step 2: Security — fix isPathInWorkspace prefix bug, add execute_bash workspace confinement
- [x] Step 3: Adapter resilience — extract SSE parser to lib/sse.ts, JSON repair, in-stream errors, inactivity timeout, clean abort, tool-ID queues, kill lastApiResponse global, tighten dedup
- [ ] Step 4: Tool hardening
  - [x] grep binary crash
  - [x] read_file size cap
  - [x] web_fetch sanitization
  - [ ] surface stderr on success
- [ ] Step 5: UX + README
  - [ ] elapsed spinner
  - [ ] interrupt hint
  - [ ] context %
  - [ ] persist /model
  - [x] write README.md
