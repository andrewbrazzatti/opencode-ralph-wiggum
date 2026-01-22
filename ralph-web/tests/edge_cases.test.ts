import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { RalphManager } from "../src/manager";
import { join } from "path";
import { rmSync, mkdirSync } from "fs";

describe("Edge Cases", () => {
    const DATA_DIR = join(process.cwd(), "temp_test_edge_cases");
    let manager: RalphManager;

    beforeEach(() => {
        const logsDir = join(DATA_DIR, "logs");
        const runsDir = join(DATA_DIR, "runs");
        mkdirSync(logsDir, { recursive: true });
        mkdirSync(runsDir, { recursive: true });
        manager = new RalphManager(logsDir, runsDir, undefined as any, DATA_DIR);
    });

    afterEach(() => {
        rmSync(DATA_DIR, { recursive: true, force: true });
    });

    test("should handle unexpected non-zero exit", async () => {
        let exitHandler: any;
        const mockSpawner = mock((cmd, opts) => {
            if (cmd[0] === "which") return { stdout: new ReadableStream({ start(c) { c.enqueue("ralph\n"); c.close(); } }) };
            const p = {
                stdout: new ReadableStream({ start(c) { c.close(); } }),
                stderr: new ReadableStream({ start(c) { c.close(); } }),
                kill: mock()
            };
            exitHandler = opts.onExit;
            return p;
        });

        manager = new RalphManager(join(DATA_DIR, "logs"), join(DATA_DIR, "runs"), mockSpawner as any, DATA_DIR);

        const runId = await manager.start({ prompt: "fail test" });
        const run = manager.getRun(runId);
        
        // Simulate crash
        exitHandler({}, 1, null, new Error("Crashed"));
        
        expect(run?.metadata.status).toBe("failed");
        expect(run?.metadata.exitCode).toBe(1);
        
        // Check DB
        const dbRun = manager.getDatabase().getRun(runId);
        expect(dbRun?.status).toBe("failed");
        expect(dbRun?.exit_code).toBe(1);
    });

    test("should handle simultaneous start and stop", async () => {
        const killMock = mock();
        const mockSpawner = mock((cmd) => {
            if (cmd[0] === "which") return { stdout: new ReadableStream({ start(c) { c.enqueue("ralph\n"); c.close(); } }) };
            return {
                stdout: new ReadableStream({ start(c) { } }), // never ends
                stderr: new ReadableStream({ start(c) { } }),
                kill: killMock
            };
        });

        manager = new RalphManager(join(DATA_DIR, "logs"), join(DATA_DIR, "runs"), mockSpawner as any, DATA_DIR);

        const runId = await manager.start({ prompt: "simul test" });
        await manager.stop(runId);
        
        expect(killMock).toHaveBeenCalledWith("SIGTERM");
        expect(manager.getRun(runId)?.metadata.status).toBe("stopping");
    });

    test("should block start if workdir is already active even if just started", async () => {
        const mockSpawner = mock((cmd) => {
            if (cmd[0] === "which") return { stdout: new ReadableStream({ start(c) { c.enqueue("ralph\n"); c.close(); } }) };
            return {
                stdout: new ReadableStream({ start(c) { } }),
                stderr: new ReadableStream({ start(c) { } }),
                kill: mock()
            };
        });

        manager = new RalphManager(join(DATA_DIR, "logs"), join(DATA_DIR, "runs"), mockSpawner as any, DATA_DIR);
        const workdir = join(DATA_DIR, "same_workdir");

        await manager.start({ prompt: "run 1", workdir });
        
        await expect(manager.start({ prompt: "run 2", workdir }))
            .rejects.toThrow(/already active/);
    });
});
