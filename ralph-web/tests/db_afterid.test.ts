import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { RalphDatabase } from "../src/db";
import { join } from "path";
import { rmSync, mkdirSync } from "fs";

describe("Database afterId", () => {
    const DATA_DIR = join(process.cwd(), "temp_test_db_afterid");
    let db: RalphDatabase;

    beforeAll(() => {
        mkdirSync(DATA_DIR, { recursive: true });
        db = new RalphDatabase(DATA_DIR);
    });

    afterAll(() => {
        rmSync(DATA_DIR, { recursive: true, force: true });
    });

    test("getRunLogs supports afterId", () => {
        const runId = "test_run";
        db.createRun({
            id: runId,
            status: "active",
            prompt: "test",
            config: "{}",
            created_at: new Date().toISOString(),
            started_at: null,
            ended_at: null,
            exit_code: null
        });

        db.insertLogs([
            { run_id: runId, timestamp: "2023-01-01T00:00:01Z", level: "info", source: "test", message: "log 1" },
            { run_id: runId, timestamp: "2023-01-01T00:00:02Z", level: "info", source: "test", message: "log 2" },
            { run_id: runId, timestamp: "2023-01-01T00:00:03Z", level: "info", source: "test", message: "log 3" }
        ]);

        const allLogs = db.getRunLogs(runId);
        expect(allLogs.logs.length).toBe(3);
        
        const firstId = allLogs.logs[0].id!;
        const remainingLogs = db.getRunLogs(runId, 1000, 0, undefined, firstId);
        expect(remainingLogs.logs.length).toBe(2);
        expect(remainingLogs.logs[0].message).toBe("log 2");
        expect(remainingLogs.total).toBe(2);
    });
});
