import { spawn, type Subprocess } from "bun";
import { join } from "path";
import { appendFileSync, writeFileSync } from "fs";
import { RalphDatabase } from "./db";

export interface LogEntry {
    ts: string;
    level: "info" | "warn" | "error" | "tool" | "success";
    source: "stdout" | "stderr" | "system";
    message: string;
    tool?: string;
}

export type RunStatus = "pending" | "active" | "stopping" | "stopped" | "completed" | "failed";

export interface RunMetadata {
    runId: string;
    startedAt: string;
    endedAt: string | null;
    status: RunStatus;
    exitCode: number | null;
    prompt: string;
    modelQueue: string[];
    args: string[];
    mode: string;
    workdir?: string;
}

export class RunController {
    public metadata: RunMetadata;
    public logs: LogEntry[] = [];
    public iterations: number = 0;
    
    private proc: Subprocess | null = null;
    private logFile: string;
    private logListeners: Set<(entry: LogEntry) => void> = new Set();
    
    constructor(
        metadata: RunMetadata,
        private logsDir: string,
        private db: RalphDatabase,
        private spawner: typeof spawn = spawn
    ) {
        this.metadata = metadata;
        this.logFile = join(this.logsDir, `${metadata.runId}.jsonl`);
    }

    public async start(cmd: string[]) {
        this.systemLog("info", `Executing: ${cmd.join(" ")}`);
        
        this.proc = this.spawner(cmd, {
            cwd: this.metadata.workdir || process.cwd(),
            stdout: "pipe",
            stderr: "pipe",
            onExit: (_proc, exitCode, signalCode, _error) => {
                const endedAt = new Date().toISOString();
                this.systemLog("info", `Ralph process exited with code ${exitCode}${signalCode ? ` (signal: ${signalCode})` : ""}`);
                
                this.metadata.endedAt = endedAt;
                this.metadata.exitCode = exitCode ?? null;
                
                if (signalCode !== null) {
                    this.metadata.status = "stopped";
                } else if (exitCode === 0) {
                    this.metadata.status = "completed";
                } else {
                    this.metadata.status = "failed";
                }
                
                this.saveRunMetadata();
                
                try {
                    this.db.updateRunStatus(this.metadata.runId, this.metadata.status, endedAt, exitCode ?? null);
                } catch (e) {
                    console.error("Failed to update run status in DB:", e);
                }
                
                this.proc = null;
            }
        });

        this.streamLogs(this.proc.stdout as any, "stdout");
        this.streamLogs(this.proc.stderr as any, "stderr");
    }

    public async stop() {
        if (this.proc) {
            this.metadata.status = "stopping";
            this.systemLog("warn", "Sending SIGTERM to Ralph process...");
            this.proc.kill("SIGTERM");
            
            setTimeout(() => {
                if (this.proc) {
                    this.systemLog("error", "Ralph process still active, sending SIGKILL...");
                    this.proc.kill("SIGKILL");
                }
            }, 5000);
        }
    }

    public addLogListener(listener: (entry: LogEntry) => void) {
        this.logListeners.add(listener);
    }

    public removeLogListener(listener: (entry: LogEntry) => void) {
        this.logListeners.delete(listener);
    }

    public saveRunMetadata() {
        const path = join(this.logsDir, `../runs/${this.metadata.runId}.json`); // Adjust as needed
        writeFileSync(path, JSON.stringify(this.metadata, null, 2));
    }

    private async streamLogs(stream: ReadableStream, source: "stdout" | "stderr") {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    if (buffer.trim()) {
                        this.parseAndLog(buffer, source);
                    }
                    break;
                }
                
                const text = decoder.decode(value, { stream: true });
                buffer += text;
                const lines = buffer.split(/\r?\n/);
                buffer = lines.pop() ?? "";
                
                for (const line of lines) {
                    if (!line.trim()) continue;
                    this.parseAndLog(line, source);
                }
            }
        } catch (e) {
            // Error reading stream
        }
    }

    private parseAndLog(line: string, source: "stdout" | "stderr" | "system") {
        const clean = line.replace(/\u001b\[\d+m/g, "");
        
        const iterMatch = clean.match(/Iteration:?\s*(\d+)/i);
        if (iterMatch) {
            this.iterations = parseInt(iterMatch[1]);
        }

        let level: LogEntry["level"] = "info";
        if (clean.includes("Error:") || clean.includes("❌")) level = "error";
        else if (clean.includes("Warning:") || clean.includes("⚠️")) level = "warn";
        else if (clean.includes("Success") || clean.includes("✅") || clean.includes("COMPLETE")) level = "success";

        let tool = undefined;
        if (clean.trim().startsWith("|")) {
            const match = clean.match(/\|\s+([a-z_]+)/);
            if (match) {
                tool = match[1];
                level = "tool";
            }
        }

        const timestamp = new Date().toISOString();
        const entry: LogEntry = {
            ts: timestamp,
            level,
            source,
            message: line,
            tool
        };

        this.logs.push(entry);
        try {
            appendFileSync(this.logFile, JSON.stringify(entry) + "\n");
        } catch (e) {
            // ignore
        }
        
        try {
            this.db.insertLog({
                run_id: this.metadata.runId,
                timestamp,
                level,
                source,
                message: line,
                tool_name: tool
            });
        } catch (e) {
            // Fail silently on log insert
        }
        
        for (const listener of this.logListeners) {
            listener(entry);
        }
        
        if (this.logs.length > 1000) {
            this.logs = this.logs.slice(-800);
        }
    }

    public systemLog(level: LogEntry["level"], message: string) {
        this.parseAndLog(message, "system");
    }
}
