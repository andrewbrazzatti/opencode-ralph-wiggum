import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn } from "bun";
import { mkdirSync, rmSync, writeFileSync, openSync } from "fs";
import { join } from "path";

const TEST_PORT = 45679;
const TEST_DIR = join(process.cwd(), "temp_api_test");

describe("Per-Run API Endpoints", () => {
    let serverProc: any;
    const baseUrl = `http://localhost:${TEST_PORT}`;

    beforeAll(async () => {
        mkdirSync(TEST_DIR, { recursive: true });
        
        // Create a dummy ralph CLI for the server to find
        const dummyRalph = join(TEST_DIR, "ralph.sh");
        writeFileSync(dummyRalph, "#!/bin/sh\necho \"Iteration 1\"\nsleep 10\n", { mode: 0o755 });

        const serverPath = join(process.cwd(), "src/server.ts");
        const logFile = join(TEST_DIR, "server.log");
        serverProc = spawn([process.execPath, "run", serverPath, "--port", String(TEST_PORT)], {
            cwd: TEST_DIR,
            stdout: openSync(logFile, "w"),
            stderr: openSync(logFile, "w"),
            env: {
                ...process.env,
                PORT: String(TEST_PORT),
                RALPH_CLI_PATH: dummyRalph
            }
        });

        for (let i = 0; i < 20; i++) {
            try {
                const res = await fetch(`${baseUrl}/api/status`);
                if (res.ok) break;
            } catch (e) {}
            await new Promise(r => setTimeout(r, 200));
        }
    });

    afterAll(() => {
        if (serverProc) {
            serverProc.kill();
        }
        rmSync(TEST_DIR, { recursive: true, force: true });
    });

    test("POST /api/runs/:id/context should work", async () => {
        // Start a run
        const startRes = await fetch(`${baseUrl}/api/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "test context", workdir: join(TEST_DIR, "context") })
        });
        expect(startRes.status).toBe(202);
        const { runId } = await startRes.json();

        // Add context
        const contextRes = await fetch(`${baseUrl}/api/runs/${runId}/context`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ context: "some new info" })
        });
        expect(contextRes.status).toBe(200);
        const contextData = await contextRes.json();
        expect(contextData.success).toBe(true);
    });

    test("POST /api/runs/:id/skip should work", async () => {
        // Start a run
        const startRes = await fetch(`${baseUrl}/api/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "test skip", workdir: join(TEST_DIR, "skip") })
        });
        expect(startRes.status).toBe(202);
        const { runId } = await startRes.json();

        // Skip
        const skipRes = await fetch(`${baseUrl}/api/runs/${runId}/skip`, {
            method: "POST"
        });
        expect(skipRes.status).toBe(200);
        const skipData = await skipRes.json();
        expect(skipData.success).toBe(true);
    });

    test("GET /api/runs/:id/stream should provide SSE", async () => {
        // Start a run
        const startRes = await fetch(`${baseUrl}/api/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "test sse", workdir: join(TEST_DIR, "sse") })
        });
        expect(startRes.status).toBe(202);
        const { runId } = await startRes.json();

        // Wait a bit for the manager to have it in the active list
        await new Promise(r => setTimeout(r, 100));

        const res = await fetch(`${baseUrl}/api/runs/${runId}/stream`);
        if (res.status === 404) {
             const body = await res.json();
             console.error("Stream 404 error:", body);
        }
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("text/event-stream");

        const reader = res.body?.getReader();
        if (!reader) throw new Error("No reader");

        const { value } = await reader.read();
        const text = new TextDecoder().decode(value);
        expect(text).toContain("event: state");
        
        reader.releaseLock();
    });

    test("Legacy endpoints should target most recent active run", async () => {
        // Create workdirs
        mkdirSync(join(TEST_DIR, "w1"), { recursive: true });
        mkdirSync(join(TEST_DIR, "w2"), { recursive: true });

        // Start two runs
        const res1 = await fetch(`${baseUrl}/api/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "run 1", workdir: join(TEST_DIR, "w1") })
        });
        const { runId: id1 } = await res1.json();

        const res2 = await fetch(`${baseUrl}/api/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "run 2", workdir: join(TEST_DIR, "w2") })
        });
        const { runId: id2 } = await res2.json();

        // /api/status should show most recent (id2)
        const statusRes = await fetch(`${baseUrl}/api/status`);
        const statusData = await statusRes.json();
        expect(statusData.currentRun.runId).toBe(id2);

        // /api/stop should stop id2
        const stopRes = await fetch(`${baseUrl}/api/stop`, { method: "POST" });
        expect(stopRes.status).toBe(200);

        // Now id2 should be stopping/stopped, status might show id1 if id1 is still active
        const statusRes2 = await fetch(`${baseUrl}/api/status`);
        const statusData2 = await statusRes2.json();
        // Since id2 is stopping, it's still "active" in terms of manager.active (status === "active")
        // but it might be "stopping". 
        // Let's check mostRecentActiveRun logic in manager.ts
    });
});
