import { Database } from "bun:sqlite";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

export interface RunRecord {
    id: string;
    status: string;
    prompt: string;
    config: string; // JSON
    state?: string; // JSON
    created_at: string;
    started_at: string | null;
    ended_at: string | null;
    exit_code: number | null;
    workdir?: string;
    state_dir?: string;
    target_id?: string;
    target_type?: string;
}

export interface LogRecord {
    id?: number;
    run_id: string;
    timestamp: string;
    level: string;
    source: string;
    message: string;
    tool_name?: string;
}

export class RalphDatabase {
    private db: Database;

    constructor(dataDir: string) {
        let dbPath = ":memory:";

        if (dataDir !== ":memory:") {
            if (!existsSync(dataDir)) {
                mkdirSync(dataDir, { recursive: true });
            }
            dbPath = join(dataDir, "ralph.sqlite");
        }


        this.db = new Database(dbPath, { create: true });

        this.initSchema();
    }

    close() {
        this.db.close();
    }

    private initSchema() {
        // Enable WAL mode for better concurrency
        this.db.exec("PRAGMA journal_mode = WAL;");
        // Enable foreign key enforcement
        this.db.exec("PRAGMA foreign_keys = ON;");
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                status TEXT NOT NULL,
                prompt TEXT NOT NULL,
                config JSON,
                state JSON,
                created_at TEXT NOT NULL,
                started_at TEXT,
                ended_at TEXT,
                exit_code INTEGER
            );


            CREATE TABLE IF NOT EXISTS logs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                run_id TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                level TEXT NOT NULL,
                source TEXT NOT NULL,
                message TEXT NOT NULL,
                tool_name TEXT,
                FOREIGN KEY(run_id) REFERENCES runs(id)
            );
            
            CREATE INDEX IF NOT EXISTS idx_logs_run_id ON logs(run_id);
            CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);
            CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
        `);

        // Migrations: add missing columns to 'runs' table if they don't exist
        const columns = this.db.prepare("PRAGMA table_info(runs)").all() as any[];
        const columnNames = columns.map(c => c.name);

        if (!columnNames.includes("workdir")) {
            this.db.exec("ALTER TABLE runs ADD COLUMN workdir TEXT;");
        }
        if (!columnNames.includes("state_dir")) {
            this.db.exec("ALTER TABLE runs ADD COLUMN state_dir TEXT;");
        }
        if (!columnNames.includes("target_id")) {
            this.db.exec("ALTER TABLE runs ADD COLUMN target_id TEXT;");
        }
        if (!columnNames.includes("target_type")) {
            this.db.exec("ALTER TABLE runs ADD COLUMN target_type TEXT;");
        }

        // Add indexes for performance/concurrency checks
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_workdir ON runs(workdir);");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);");

    }

    // --- Runs ---

    createRun(run: RunRecord) {
        const stmt = this.db.prepare(`
            INSERT INTO runs (id, status, prompt, config, created_at, started_at, ended_at, exit_code, workdir, state_dir, target_id, target_type)
            VALUES ($id, $status, $prompt, $config, $created_at, $started_at, $ended_at, $exit_code, $workdir, $state_dir, $target_id, $target_type)
        `);

        stmt.run({
            $id: run.id,
            $status: run.status,
            $prompt: run.prompt,
            $config: run.config,
            $created_at: run.created_at,
            $started_at: run.started_at,
            $ended_at: run.ended_at,
            $exit_code: run.exit_code,
            $workdir: run.workdir || null,
            $state_dir: run.state_dir || null,
            $target_id: run.target_id || null,
            $target_type: run.target_type || null
        });
    }

    updateRunState(id: string, state: string) {
        const stmt = this.db.prepare(`
            UPDATE runs 
            SET state = $state
            WHERE id = $id
        `);

        stmt.run({
            $id: id,
            $state: state
        });
    }

    updateRunStatus(id: string, status: string, endedAt: string | null = null, exitCode: number | null = null) {
        const stmt = this.db.prepare(`
            UPDATE runs 
            SET status = $status, ended_at = $ended_at, exit_code = $exit_code
            WHERE id = $id
        `);

        stmt.run({
            $id: id,
            $status: status,
            $ended_at: endedAt,
            $exit_code: exitCode
        });
    }

    getRun(id: string): RunRecord | null {
        const stmt = this.db.prepare("SELECT * FROM runs WHERE id = ?");
        return stmt.get(id) as RunRecord | null;
    }

    listRuns(limit: number = 50, offset: number = 0): RunRecord[] {
        const stmt = this.db.prepare(`
            SELECT * FROM runs 
            ORDER BY created_at DESC 
            LIMIT $limit OFFSET $offset
        `);
        return stmt.all({ $limit: limit, $offset: offset }) as RunRecord[];
    }

    deleteRun(id: string): boolean {
        const deleteTransaction = this.db.transaction(() => {
            // Delete logs first (foreign key constraint)
            this.db.prepare("DELETE FROM logs WHERE run_id = ?").run(id);
            // Delete the run
            const result = this.db.prepare("DELETE FROM runs WHERE id = ?").run(id);
            return result.changes > 0;
        });

        return deleteTransaction();
    }

    // --- Logs ---

    insertLog(log: LogRecord) {
        const stmt = this.db.prepare(`
            INSERT INTO logs (run_id, timestamp, level, source, message, tool_name)
            VALUES ($run_id, $timestamp, $level, $source, $message, $tool_name)
        `);

        stmt.run({
            $run_id: log.run_id,
            $timestamp: log.timestamp,
            $level: log.level,
            $source: log.source,
            $message: log.message,
            $tool_name: log.tool_name || null
        });
    }

    insertLogs(logs: LogRecord[]) {
        const insert = this.db.prepare(`
            INSERT INTO logs (run_id, timestamp, level, source, message, tool_name)
            VALUES ($run_id, $timestamp, $level, $source, $message, $tool_name)
        `);

        const transaction = this.db.transaction((logs: LogRecord[]) => {
            for (const log of logs) {
                insert.run({
                    $run_id: log.run_id,
                    $timestamp: log.timestamp,
                    $level: log.level,
                    $source: log.source,
                    $message: log.message,
                    $tool_name: log.tool_name || null
                });
            }
        });

        transaction(logs);
    }

    getRunLogs(runId: string, limit: number = 1000, offset: number = 0, level?: string, afterId?: number): { logs: LogRecord[], total: number } {
        let query = "SELECT * FROM logs WHERE run_id = $run_id";
        let countQuery = "SELECT COUNT(*) as count FROM logs WHERE run_id = $run_id";

        const params: any = { $run_id: runId };

        if (level) {
            query += " AND level = $level";
            countQuery += " AND level = $level";
            params.$level = level;
        }

        if (afterId !== undefined) {
            query += " AND id > $afterId";
            countQuery += " AND id > $afterId";
            params.$afterId = afterId;
        }

        query += " ORDER BY id ASC LIMIT $limit OFFSET $offset";
        params.$limit = limit;
        params.$offset = offset;

        const logs = this.db.prepare(query).all(params) as LogRecord[];
        const count = this.db.prepare(countQuery).get({
            $run_id: runId,
            ...(level ? { $level: level } : {}),
            ...(afterId !== undefined ? { $afterId: afterId } : {})
        }) as { count: number };

        return { logs, total: count.count };
    }
}
