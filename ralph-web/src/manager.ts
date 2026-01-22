import { spawn } from "bun";
import { join } from "path";
import { existsSync, appendFileSync, writeFileSync, rmSync, readdirSync, statSync, readFileSync, mkdirSync } from "fs";
import { RalphDatabase, type RunRecord, type LogRecord } from "./db";
import { RunController, type LogEntry, type RunStatus, type RunMetadata } from "./run-controller";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

export { type LogEntry, type RunStatus, type RunMetadata };

export interface Target {
    id: string;
    name: string;
    baseUrl: string;
    token: string;
    default?: boolean;
    health?: {
        status: "healthy" | "unhealthy" | "unknown";
        lastCheck: string;
        error?: string;
    };
}

export class RalphManager {
    public runs: Map<string, RunController> = new Map();
    public targets: Target[] = [];
    private remotesPath: string;

    public get active(): boolean {
        return this.mostRecentActiveRun !== null;
    }

    public get currentRun(): RunMetadata | null {
        return this.mostRecentActiveRun?.metadata || null;
    }

    public logs: LogEntry[] = [];
    public iterations: number = 0;
    
    private retentionDays: number = parseInt(process.env.RALPH_WEB_STATE_RETENTION_DAYS || "7");
    
    // Made public/protected for testing if needed, or keep private
    private proc: any = null; 
    private logFile: string | null = null;
    private logListeners: Set<(entry: LogEntry) => void> = new Set();
    private db: RalphDatabase;
    
    // Injectable paths and spawner for testing
    constructor(
        private logsDir: string = join(process.cwd(), ".opencode/ralph-web/logs"),
        private runsDir: string = join(process.cwd(), ".opencode/ralph-web/runs"),
        private spawner: typeof spawn = spawn,
        dbPath: string = join(process.cwd(), ".opencode/ralph-web")
    ) {
        this.db = new RalphDatabase(dbPath);
        this.remotesPath = dbPath === ":memory:" ? "" : join(dbPath, "remotes.json");
        this.loadTargets();
        this.pruneOldRuns();
    }

    private loadTargets() {
        if (this.remotesPath && existsSync(this.remotesPath)) {
            try {
                const parsed = JSON.parse(readFileSync(this.remotesPath, "utf-8"));
                // Ensure parsed data is an array
                this.targets = Array.isArray(parsed) ? parsed : [];
                // Decrypt tokens if master key is present
                if (process.env.RALPH_WEB_MASTER_KEY) {
                    for (const target of this.targets) {
                        if (target.token) {
                            target.token = this.decrypt(target.token);
                        }
                    }
                }
            } catch (e) {
                console.error("Failed to load targets:", e);
                this.targets = [];
            }
        } else {
            this.targets = [];
        }
    }

    private saveTargets() {
        if (!this.remotesPath) return;
        try {
            const dir = join(this.remotesPath, "..");
            if (!existsSync(dir)) {
                mkdirSync(dir, { recursive: true });
            }

            const targetsToSave = JSON.parse(JSON.stringify(this.targets));
            // Encrypt tokens if master key is present
            if (process.env.RALPH_WEB_MASTER_KEY) {
                for (const target of targetsToSave) {
                    if (target.token) {
                        target.token = this.encrypt(target.token);
                    }
                }
            }
            writeFileSync(this.remotesPath, JSON.stringify(targetsToSave, null, 2));
        } catch (e) {
            console.error("Failed to save targets:", e);
        }
    }

    private encrypt(text: string): string {
        const masterKey = process.env.RALPH_WEB_MASTER_KEY;
        if (!masterKey || !text || text.startsWith("enc:")) return text;

        try {
            const iv = randomBytes(16);
            const key = scryptSync(masterKey, 'salt', 32);
            const cipher = createCipheriv('aes-256-cbc', key, iv);
            let encrypted = cipher.update(text, 'utf8', 'hex');
            encrypted += cipher.final('hex');
            return `enc:${iv.toString('hex')}:${encrypted}`;
        } catch (e) {
            console.error("Encryption failed:", e);
            return text;
        }
    }

    private decrypt(text: string): string {
        if (!text.startsWith("enc:")) return text;
        const masterKey = process.env.RALPH_WEB_MASTER_KEY;
        if (!masterKey) return text;

        try {
            const parts = text.split(":");
            if (parts.length !== 3) return text;

            const iv = Buffer.from(parts[1], 'hex');
            const encryptedText = parts[2];
            const key = scryptSync(masterKey, 'salt', 32);
            const decipher = createDecipheriv('aes-256-cbc', key, iv);
            let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
            decrypted += decipher.final('utf8');
            return decrypted;
        } catch (e) {
            console.error("Decryption failed:", e);
            return text;
        }
    }

    public listTargets(): Target[] {
        return this.targets;
    }

    public addTarget(target: Omit<Target, "id">): Target {
        const newTarget: Target = {
            ...target,
            id: `target_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            health: {
                status: "unknown",
                lastCheck: new Date().toISOString()
            }
        };
        this.targets.push(newTarget);
        this.saveTargets();
        return newTarget;
    }

    public removeTarget(id: string) {
        this.targets = this.targets.filter(t => t.id !== id);
        this.saveTargets();
    }

    public async testTarget(id: string): Promise<{ success: boolean; error?: string }> {
        const target = this.targets.find(t => t.id === id);
        if (!target) throw new Error("Target not found");

        try {
            const res = await this.proxyRequest(id, "GET", "/api/status");

            if (res.ok) {
                target.health = {
                    status: "healthy",
                    lastCheck: new Date().toISOString()
                };
                this.saveTargets();
                return { success: true };
            } else {
                const error = `HTTP ${res.status}: ${res.statusText}`;
                target.health = {
                    status: "unhealthy",
                    lastCheck: new Date().toISOString(),
                    error
                };
                this.saveTargets();
                return { success: false, error };
            }
        } catch (e: any) {
            const error = String(e);
            target.health = {
                status: "unhealthy",
                lastCheck: new Date().toISOString(),
                error
            };
            this.saveTargets();
            return { success: false, error };
        }
    }

    public async proxyRequest(targetId: string, method: string, path: string, body?: any, signal?: AbortSignal): Promise<Response> {
        const target = this.targets.find(t => t.id === targetId);
        if (!target) throw new Error("Target not found");

        const headers: any = { "Content-Type": "application/json" };
        if (target.token) {
            headers["Authorization"] = `Bearer ${target.token}`;
        }

        const url = `${target.baseUrl}${path}`;
        
        // Default timeouts: 5s for status/list, 30s for start/stop/context/skip
        // We use 30s as a general default unless specified
        const timeout = path.includes("/stream") ? 0 : (path.includes("/status") || path === "/api/runs" ? 5000 : 30000);
        
        let timeoutId: any;
        const controller = new AbortController();
        if (timeout > 0) {
            timeoutId = setTimeout(() => controller.abort(), timeout);
        }

        // Combine signals if both provided
        const combinedSignal = signal ? this.anySignal([signal, controller.signal]) : controller.signal;

        try {
            const response = await fetch(url, {
                method,
                headers,
                body: body ? JSON.stringify(body) : undefined,
                signal: combinedSignal
            });

            if (timeoutId) clearTimeout(timeoutId);

            if (response.status === 401) {
                target.health = {
                    status: "unhealthy",
                    lastCheck: new Date().toISOString(),
                    error: "Unauthorized (401)"
                };
                this.saveTargets();
            } else if (response.ok) {
                 target.health = {
                    status: "healthy",
                    lastCheck: new Date().toISOString()
                };
                this.saveTargets();
            }

            return response;
        } catch (e: any) {
            if (timeoutId) clearTimeout(timeoutId);
            
            let errorMessage = String(e);
            if (e.name === "AbortError") {
                errorMessage = "Request timed out or was aborted";
            }

            target.health = {
                status: "unhealthy",
                lastCheck: new Date().toISOString(),
                error: errorMessage
            };
            this.saveTargets();
            throw e;
        }
    }

    private anySignal(signals: AbortSignal[]): AbortSignal {
        const controller = new AbortController();
        for (const signal of signals) {
            if (signal.aborted) {
                controller.abort(signal.reason);
                return signal;
            }
            signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
        }
        return controller.signal;
    }

    private pruneOldRuns() {
        try {
            const stateBaseDir = join(this.runsDir, "../state");
            if (!existsSync(stateBaseDir)) return;

            let statsBase;
            try {
                statsBase = statSync(stateBaseDir);
            } catch (e) {
                return;
            }
            if (!statsBase || typeof statsBase.isDirectory !== "function" || !statsBase.isDirectory()) return;

            const now = Date.now();
            const maxAgeMs = this.retentionDays * 24 * 60 * 60 * 1000;

            const dirs = readdirSync(stateBaseDir);
            for (const dir of dirs) {
                const fullPath = join(stateBaseDir, dir);
                try {
                    const stats = statSync(fullPath);
                    if (stats.isDirectory() && now - stats.mtimeMs > maxAgeMs) {
                        console.log(`Pruning old state dir: ${fullPath}`);
                        rmSync(fullPath, { recursive: true, force: true });
                    }
                } catch (e) {
                    // Ignore individual dir errors
                }
            }
        } catch (e) {
            console.error("Failed to prune old runs:", e);
        }
    }

    public get mostRecentActiveRun(): RunController | null {
        const activeRuns = this.listActiveRuns().filter(r => r.metadata.status === "active");
        if (activeRuns.length === 0) return null;
        return activeRuns.sort((a, b) => b.metadata.startedAt.localeCompare(a.metadata.startedAt))[0];
    }

    getDatabase(): RalphDatabase {
        return this.db;
    }

    listActiveRuns(): RunController[] {
        return Array.from(this.runs.values());
    }

    getRun(runId: string): RunController | undefined {
        return this.runs.get(runId);
    }

    async getCliCommand(): Promise<string[]> {
        const configuredPath = process.env.RALPH_CLI_PATH;
        if (configuredPath && existsSync(configuredPath)) {
            if (configuredPath.endsWith(".ts")) {
                return ["bun", configuredPath];
            } else {
                return [configuredPath];
            }
        }

        // Check for ralph in PATH
        const whichProc = this.spawner(["which", "ralph"], { stdout: "pipe" });
        const whichOutput = await new Response(whichProc.stdout).text();
        if (whichOutput.trim()) {
            return ["ralph"];
        }

        // Fallback: check if we are in the dev repo for ralph-wiggum (legacy support)
        const localRalph = join(process.cwd(), "ralph.ts");
        if (existsSync(localRalph)) {
            return ["bun", localRalph];
        }

        throw new Error("Could not find 'ralph' CLI. Please set RALPH_CLI_PATH or ensure 'ralph' is in your PATH.");
    }

    async getModels(): Promise<string[]> {
        try {
            const proc = this.spawner(["opencode", "models"], {
                stdout: "pipe",
                stderr: "pipe"
            });
            
            const text = await new Response(proc.stdout as any).text();
            return text.split("\n").map(m => m.trim()).filter(m => m);
        } catch (e) {
            console.error("Failed to fetch models:", e);
            return [];
        }
    }

    async start(params: any): Promise<string> {
        const workdir = params.codeDirectory || params.workdir || process.cwd();
        
        // Concurrency guardrails (hard block same workdir)
        for (const controller of this.runs.values()) {
            if (controller.metadata.status === "active" && controller.metadata.workdir === workdir) {
                throw new Error(`A loop is already active in ${workdir}`);
            }
        }

        const runId = `run_${Date.now()}`;
        const args = this.buildArgs(params, runId);
        const modelQueue = Array.isArray(params.modelQueue) && params.modelQueue.length > 0
            ? params.modelQueue
            : (params.model ? [params.model] : []);
        
        const startedAt = new Date().toISOString();
        const metadata: RunMetadata = {
            runId,
            startedAt,
            endedAt: null,
            status: "active",
            exitCode: null,
            prompt: params.prompt || "",
            modelQueue,
            args,
            mode: params.mode || "host",
            workdir
        };

        // DB Record
        try {
            const stateDir = join(this.runsDir, "../state", runId);
            this.db.createRun({
                id: runId,
                status: "active",
                prompt: params.prompt || "",
                config: JSON.stringify(params),
                created_at: startedAt,
                started_at: startedAt,
                ended_at: null,
                exit_code: null,
                workdir,
                state_dir: stateDir,
                target_id: "local",
                target_type: "local"
            });
        } catch (e) {
            console.error("Failed to create run in DB:", e);
        }

        const controller = new RunController(metadata, this.logsDir, this.db, this.spawner);
        this.runs.set(runId, controller);
        
        // Listen to logs for legacy support and global listeners
        controller.addLogListener((entry) => {
            this.logs.push(entry);
            if (this.logs.length > 1000) {
                this.logs = this.logs.slice(-800);
            }
            if (entry.message.match(/Iteration:?\s*(\d+)/i)) {
                this.iterations = controller.iterations;
            }
            for (const listener of this.logListeners) {
                listener(entry);
            }
        });

        let binCommand: string[];
        try {
            binCommand = await this.getCliCommand();
        } catch (e: any) {
            controller.systemLog("error", e.message);
            metadata.status = "failed";
            this.db.updateRunStatus(runId, "failed", new Date().toISOString(), 1);
            throw e;
        }

        const cmd = [...binCommand, ...args];
        controller.start(cmd).then(() => {
            // We keep the run in the map for now, maybe remove later if too many?
            // The plan doesn't specify removal from map.
        }).catch(e => {
            console.error(`Failed to start run ${runId}:`, e);
            controller.systemLog("error", `Failed to start process: ${e.message}`);
            metadata.status = "failed";
            metadata.endedAt = new Date().toISOString();
            try {
                this.db.updateRunStatus(runId, "failed", metadata.endedAt, 1);
            } catch (dbErr) {
                console.error("Failed to update status for failed start:", dbErr);
            }
        });

        return runId;
    }

    async stop(runId?: string) {
        const id = runId || this.currentRun?.runId;
        if (id) {
            const controller = this.runs.get(id);
            if (controller) {
                await controller.stop();
            }
        }
    }

    async skip(runId?: string) {
        const id = runId || this.currentRun?.runId;
        if (!id) return;

        const stateDir = join(this.runsDir, "../state", id);
        const signalPath = join(stateDir, "ralph-skip.signal");
        
        try {
            if (!existsSync(stateDir)) {
                mkdirSync(stateDir, { recursive: true });
            }
            writeFileSync(signalPath, "");
            
            const controller = this.runs.get(id);
            if (controller) {
                controller.systemLog("info", "Skip signal sent");
            }
        } catch (e) {
            console.error(`Failed to send skip signal for run ${id}:`, e);
            throw e;
        }
    }

    async addContext(text: string, runId?: string) {
        const id = runId || this.currentRun?.runId;
        if (!id) return;
        
        const controller = this.runs.get(id);

        const cmd = ["--add-context", text];
        const stateDir = join(this.runsDir, "../state", id);
        cmd.push("--state-dir", stateDir);
        
        let binCommand: string[];
        try {
            binCommand = await this.getCliCommand();
        } catch (e) {
            binCommand = ["ralph"]; // Fallback for addContext, though it might still fail
        }

        const fullCmd = [...binCommand, ...cmd];
        this.spawner(fullCmd);

        if (controller) {
            controller.systemLog("info", `Context added: "${text}"`);
        } else {
            this.systemLog("info", `Context added (no active run): "${text}"`);
        }
    }

    addLogListener(listener: (entry: LogEntry) => void) {
        this.logListeners.add(listener);
    }

    removeLogListener(listener: (entry: LogEntry) => void) {
        this.logListeners.delete(listener);
    }

    public saveRunMetadata() {
        if (this.currentRun) {
            const path = join(this.runsDir, `${this.currentRun.runId}.json`);
            writeFileSync(path, JSON.stringify(this.currentRun, null, 2));
        }
    }

    private buildArgs(params: any, runId?: string): string[] {
        const args: string[] = [];
        
        if (params.prompt) args.push(params.prompt);
        const modelQueue = Array.isArray(params.modelQueue) ? params.modelQueue.filter(Boolean) : [];
        const modelArg = modelQueue.length > 0 ? modelQueue.join(",") : params.model;
        if (modelArg) args.push("--model", modelArg);
        if (params.minIterations) args.push("--min-iterations", String(params.minIterations));
        if (params.maxIterations) args.push("--max-iterations", String(params.maxIterations));
        if (params.completionPromise) args.push("--completion-promise", params.completionPromise);
        
        if (params.mode === "docker") {
            if (params.dockerImage) args.push("--docker-image", params.dockerImage);
            
            let dArgs = params.dockerArgs || "";
            
            // Handle Code Directory: mount to /workspace/code and set as working dir
            if (params.codeDirectory) {
                dArgs += ` -v ${params.codeDirectory}:/workspace/code`;
                dArgs += ` -w /workspace/code`;
            }

            if (params.dockerVolumes && Array.isArray(params.dockerVolumes)) {
                params.dockerVolumes.forEach((vol: any) => {
                    if (vol.src && vol.target) {
                        let mount = `-v ${vol.src}:${vol.target}`;
                        if (vol.opts) mount += `:${vol.opts}`;
                        dArgs += ` ${mount}`;
                    }
                });
            }
            
            if (dArgs.trim()) args.push("--docker-args", dArgs.trim());
        }

        if (params.noCommit) args.push("--no-commit");
        if (params.verboseTools) args.push("--verbose-tools");
        if (params.noPlugins) args.push("--no-plugins");
        if (params.allowAll) args.push("--allow-all");
        if (params.noStream) args.push("--no-stream");

        // Pass DB args
        const dbPath = join(this.runsDir, "../ralph.sqlite"); // Assuming runsDir is .opencode/ralph-web/runs
        args.push("--db-path", dbPath);
        
        if (runId) {
             args.push("--run-id", runId);
             // Assign per-run stateDir
             const stateDir = join(this.runsDir, "../state", runId);
             args.push("--state-dir", stateDir);
        } else if (this.currentRun?.runId) {
             args.push("--run-id", this.currentRun.runId);
             const stateDir = join(this.runsDir, "../state", this.currentRun.runId);
             args.push("--state-dir", stateDir);
        }

        return args;
    }

    private systemLog(level: LogEntry["level"], message: string) {
        const timestamp = new Date().toISOString();
        const entry: LogEntry = {
            ts: timestamp,
            level,
            source: "system",
            message
        };
        this.logs.push(entry);
        
        for (const listener of this.logListeners) {
            listener(entry);
        }
    }
}
