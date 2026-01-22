# AGENTS.md

## Project overview
Ralph Wiggum for OpenCode provides iterative AI development loops via a CLI (`ralph`) and an optional web UI (`ralph-web`). The CLI runs a prompt repeatedly until a completion promise appears, persisting state between iterations. The web UI wraps the same loop and exposes status/logs.

## Key entry points
- `ralph.ts`: Core loop implementation, CLI argument parsing, Docker/devcontainer support, state + history tracking.
- `ralph-web.ts`: Bun web server for the UI; spawns `ralph.ts`, streams logs, serves `/src/web` assets.
- `bin/ralph.js`, `bin/ralph-web.js`: Node wrappers for the published CLIs.
- `src/web/`: Static web app (`index.html`, `app.js`, `style.css`).

## State and data files
Stored under `.opencode/` in the repo/workdir.
- `ralph-loop.state.json`: Active loop state.
- `ralph-history.json`: Iteration history/metrics.
- `ralph-context.md`: Pending user context for the next iteration.
Web UI adds `.opencode/ralph-web/` with per-run logs and run metadata.

## Run and build
- CLI (dev): `bun ralph.ts "<prompt>" [options]`
- Web UI (dev): `bun ralph-web.ts` (serves on `HOST`/`PORT`, defaults 127.0.0.1:3000)
- Build CLI binary: `bun build ralph.ts --outfile bin/ralph --compile`
- npm install for global `ralph`: `npm install -g @th0rgal/ralph-wiggum`

## Tests
- `bun test ./tests`

## Web API notes
`ralph-web.ts` serves:
- `GET /api/status`: current run + last 50 logs.
- `GET /api/logs/stream?runId=...`: SSE log stream for active runs.
- `GET /api/logs?runId=...`: log file readback.
- `POST /api/start`, `/api/stop`, `/api/skip`, `/api/context`, `/api/queue`.

UI log rendering lives in `src/web/app.js`. If logs look incomplete, verify both `/api/status` payloads and SSE stream behavior.
