# Ralph Web Interface Walkthrough

The Ralph Web Interface (`ralph-web`) provides a modern, user-friendly way to manage your Ralph Wiggum iterative development loops.

## Getting Started

### 1. Installation

Ensure you have the latest version of the `opencode-ralph-wiggum` package installed.

```bash
# From source
bun install
```

### 2. Launching the Interface

Start the web server:

```bash
# Standard launch (localhost:3000)
bun ralph-web.ts

# Specify a custom port
bun ralph-web.ts --port 8080

# Expose to the network (accessible from other devices)
bun ralph-web.ts --expose
```

Open your browser and navigate to `http://127.0.0.1:3000`.

## Features

### Start a New Loop

On the main dashboard ("Ready" state), you can configure a new task:

- **Prompt**: Enter the task description for Ralph.
- **Model List**: Specify which models to use (comma-separated). Ralph will cycle through these if one fails or gets stuck.
- **Execution Environment**:
    - **Host Machine**: Runs directly on your computer.
    - **Docker Container**: Runs inside a specified Docker image (requires `docker`).
    - **DevContainer**: Connects to an existing DevContainer service.
- **Advanced Options**:
    - **Completion Promise**: The phrase Ralph looks for to know it's done (default: `COMPLETE`).
    - **Iterations**: Set min/max iterations.
    - **Flags**: Toggle auto-commit, verbose output, etc.

### Monitoring an Active Loop

Once started, the interface switches to the "Active" view:

- **Real-time Logs**: Watch Ralph's progress, tool usage, and output in the terminal window.
- **Status Indicators**: See the current iteration count and loop status.
- **Model Queue**: View the list of models.
    - **Reorder**: Use Up/Down arrows to change priority on the fly.
    - **Add Next**: Quickly inject a model (e.g., `gpt-4o`) to be used in the *very next* iteration (overrides the queue).
    - **Remove**: Remove models from the queue.

### Interacting with the Loop

- **Add Hint / Context**: Click the "Add Hint" button to inject advice or correction into the running loop. Ralph will see this in the next iteration.
- **Stop Execution**: safely stops the loop after the current operation or immediately if forced.

### History & Persistence

- **Run History**: All runs are persisted to `.opencode/ralph-web/runs/`.
- **Logs**: Full logs are saved to `.opencode/ralph-web/logs/`.
- **Configuration**: Your last used settings are saved to `.opencode/ralph-run.config.json` and automatically reloaded next time.

## Remote Access

To control Ralph from your phone or another computer:

1. Run with `--expose`:
1. Run with `--expose`:
   ```
   *Note: Client-side token auth is not yet fully implemented in the UI, so use within a trusted network.*

3. Access via your computer's LAN IP (e.g., `http://192.168.1.5:3000`).

## Troubleshooting

- **Logs not showing?** Ensure the backend process has permission to read/write `.opencode/ralph-web/`.
- **Ralph not starting?** Check if `ralph.ts` is in the same directory or properly installed in your PATH.
