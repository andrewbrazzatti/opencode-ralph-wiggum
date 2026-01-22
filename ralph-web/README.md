# Ralph Web Interface

A web-based interface and REST API for controlling [Ralph](../ralph.ts) loops.

## Features

- **Multi-run Support**: Manage multiple concurrent Ralph loops independently.
- **Remote Orchestration**: Local control plane to proxy requests to remote Ralph instances.
- **REST API**: Remote control of Ralph instances (Start, Stop, List Runs, Get Logs).
- **SQLite Backend**: Robust storage for run metadata and logs.
- **Real-time Logs**: Stream execution logs via SSE or REST.
- **Web UI**: Dashboard to view status and history across all targets.

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) runtime

### Installation

```bash
cd ralph-web
bun install
```

### Running the Server

```bash
bun run src/server.ts
```

By default, the server listens on `http://localhost:3000`.

**Options:**
- `--port, -p`: Set port (default: 3000)
- `--host, -h`: Set host (default: 127.0.0.1)
- `--token`: Set a bearer token for authentication
- `--cors-origin`: Set CORS allowed origin

**Environment Variables:**
- `RALPH_CLI_PATH`: Path to the `ralph` CLI binary or script.
- `RALPH_WEB_TOKEN`: Auth token for the web server.
- `RALPH_WEB_MASTER_KEY`: Master key for encrypting remote target tokens on disk.
- `RALPH_WEB_STATE_RETENTION_DAYS`: How many days to keep run state directories (default: 7).
- `RALPH_WEB_SSE_HEARTBEAT_INTERVAL`: SSE heartbeat interval in ms (default: 15000).

## Multi-run Concurrency
Ralph Web supports multiple concurrent runs. However, it enforces a **concurrency block on the same workdir**: you cannot start two runs in the same directory simultaneously to prevent state corruption.

## Remote Targets
You can add remote Ralph Web instances as "targets" to manage them from a single local UI.
- Local server acts as a proxy, forwarding requests to remote instances.
- Remote tokens can be stored encrypted on disk if `RALPH_WEB_MASTER_KEY` is set.

## REST API Reference

### Targets (Local Only)

#### List Targets
`GET /api/targets`

#### Add Target
`POST /api/targets`
- Body: `{ "name": "Remote VM", "baseUrl": "http://...", "token": "..." }`

#### Delete Target
`DELETE /api/targets/:id`

### Runs

#### List Runs
`GET /api/runs`
- **Query Params**: `limit` (default 50), `offset` (default 0)
- **Response**: List of run summaries from the database.

#### Start Run
`POST /api/runs`
- **Body**: Standard Ralph options (`prompt`, `model`, `workdir`, etc.)
- **Response**: `202 Accepted` with `{ "runId": "run_..." }`

#### Get Run Details
`GET /api/runs/:id`
- **Response**: Run metadata + `logs_count`.

#### Stop Run
`POST /api/runs/:id/stop`

#### Skip Iteration
`POST /api/runs/:id/skip`

#### Add Context
`POST /api/runs/:id/context`
- Body: `{ "context": "new instructions" }`

### Logs

#### Get Run Logs
`GET /api/runs/:id/logs`
- **Query Params**:
  - `limit`: Max logs to return (default 1000)
  - `offset`: Offset for pagination
  - `level`: Filter by level (info, error, tool, etc.)
  - `afterId`: Get logs created after this internal ID (useful for polling)
- **Response**: `{ "logs": [...], "total": 123 }`

#### Stream Logs (SSE)
`GET /api/runs/:id/stream`
- **Event: state**: Initial event with run metadata.
- **Event: log**: Real-time log entries.

### Proxying to Targets
All run endpoints can be prefixed with `/api/targets/:targetId` to proxy them to a remote target.
Example: `GET /api/targets/target_123/runs`

## Database

Ralph Web uses a SQLite database stored in `.opencode/ralph-web/ralph.sqlite`.
The schema is automatically migrated on startup. It is recommended to back up the database before major upgrades.
- **Runs Table**: Stores configuration, status, and metadata for each execution loop.
- **Logs Table**: Stores all system and tool output logs.
