import { describe, expect, test, beforeEach } from "bun:test";
import { RalphDatabase } from "../src/db";

describe("RalphDatabase", () => {
    let db: RalphDatabase;

    beforeEach(() => {
        db = new RalphDatabase(":memory:");
    });

    test("should create and retrieve a run", () => {
        const runId = "test_run_1";
        const now = new Date().toISOString();
        
        db.createRun({
            id: runId,
            status: "active",
            prompt: "test prompt",
            config: "{}",
            created_at: now,
            started_at: now,
            ended_at: null,
            exit_code: null
        });

        const run = db.getRun(runId);
        expect(run).toBeDefined();
        expect(run?.id).toBe(runId);
        expect(run?.status).toBe("active");
    });

    test("should update run status", () => {
        const runId = "test_run_2";
        const now = new Date().toISOString();
        
        db.createRun({
            id: runId,
            status: "active",
            prompt: "test prompt",
            config: "{}",
            created_at: now,
            started_at: now,
            ended_at: null,
            exit_code: null
        });

        const endedAt = new Date().toISOString();
        db.updateRunStatus(runId, "completed", endedAt, 0);

        const run = db.getRun(runId);
        expect(run?.status).toBe("completed");
        expect(run?.exit_code).toBe(0);
        expect(run?.ended_at).toBe(endedAt);
    });

    test("should insert and retrieve logs", () => {
        const runId = "test_run_3";
        const now = new Date().toISOString();
        
        db.createRun({
            id: runId,
            status: "active",
            prompt: "test prompt",
            config: "{}",
            created_at: now,
            started_at: now,
            ended_at: null,
            exit_code: null
        });

        db.insertLog({
            run_id: runId,
            timestamp: now,
            level: "info",
            source: "stdout",
            message: "test log",
            tool_name: "test_tool"
        });

        const { logs, total } = db.getRunLogs(runId);
        expect(total).toBe(1);
        expect(logs.length).toBe(1);
        expect(logs[0].message).toBe("test log");
        expect(logs[0].tool_name).toBe("test_tool");
    });

    test("should list runs with pagination", () => {
        const now = new Date().toISOString();
        for (let i = 0; i < 5; i++) {
            db.createRun({
                id: `run_${i}`,
                status: "completed",
                prompt: `prompt ${i}`,
                config: "{}",
                created_at: new Date(Date.now() + i * 1000).toISOString(),
                started_at: now,
                ended_at: now,
                exit_code: 0
            });
        }

        const runs = db.listRuns(3, 0);
        expect(runs.length).toBe(3);
        // Ordered by created_at DESC, so run_4 should be first if timestamps strictly increasing
        // But date precision might be tricky in loop. Assuming they are distinct enough or relying on implementation.
        // Actually run_4 was created last, so it has largest timestamp.
        expect(runs[0].id).toBe("run_4");
        
        const nextRuns = db.listRuns(3, 3);
        expect(nextRuns.length).toBe(2);
        expect(nextRuns[0].id).toBe("run_1");
    });
});
