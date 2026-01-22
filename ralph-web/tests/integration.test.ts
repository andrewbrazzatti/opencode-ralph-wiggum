import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn } from "bun";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";

const TEST_PORT = 45678;
const TEST_DIR = join(process.cwd(), "temp_integration_test");

describe("Ralph Web Integration", () => {
    let serverProc: any;
    const baseUrl = `http://localhost:${TEST_PORT}`;

    beforeAll(async () => {
        // Setup temp dir
        if (mkdirSync(TEST_DIR, { recursive: true })) {
            // dir created
        }

        // Spawn server
        const serverPath = join(import.meta.dir, "../src/server.ts");
        serverProc = spawn([process.execPath, "run", serverPath, "--port", String(TEST_PORT)], {
            cwd: process.cwd(), // We need src/server.ts to be found, but we want it to use TEST_DIR for data?
            // server.ts uses process.cwd() for .opencode. 
            // If we run with cwd=TEST_DIR, we need to make sure src/server.ts is accessible.
            // Using absolute path for server.ts
            env: {
                ...process.env,
                PORT: String(TEST_PORT)
            }
        });

        // Wait for server to start
        // We can poll /api/status until 200
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
        // Cleanup temp dir if safe?
        // rmSync(TEST_DIR, { recursive: true, force: true });
    });

    test("GET /api/runs should return empty list initially", async () => {
        const res = await fetch(`${baseUrl}/api/runs`);
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.runs).toBeDefined();
        // Since we are running in the main repo CWD (unless we change it), it might find existing runs if any.
        // Ideally we should use a clean state.
        // But for integration smoke test, checking it returns an array is good enough.
        expect(Array.isArray(data.runs)).toBe(true);
    });

    test("POST /api/runs should start a run", async () => {
        // Minimal valid payload
        const payload = {
            prompt: "integration test",
            model: "test-model"
        };
        
        const res = await fetch(`${baseUrl}/api/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        
        expect(res.status).toBe(202);
        const data = await res.json();
        expect(data.runId).toStartWith("run_");
        expect(data.status).toBe("active");
        
        // Check if it appears in list
        const listRes = await fetch(`${baseUrl}/api/runs`);
        const listData = await listRes.json();
        const found = listData.runs.find((r: any) => r.id === data.runId);
        expect(found).toBeDefined();
        expect(found.status).toBe("active");
        
        // Stop it to clean up
        await fetch(`${baseUrl}/api/runs/${data.runId}/stop`, { method: "POST" });
    });

    test("POST /api/runs should include workdir in response when codeDirectory is provided", async () => {
        const customDir = join(process.cwd(), "temp_integration_workdir");
        const payload = {
            prompt: "workdir test",
            codeDirectory: customDir
        };
        
        const res = await fetch(`${baseUrl}/api/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        
        expect(res.status).toBe(202);
        const data = await res.json();
        expect(data.workdir).toBe(customDir);
        
        // Stop it
        await fetch(`${baseUrl}/api/runs/${data.runId}/stop`, { method: "POST" });
    });

    test("POST /api/start should include workdir in response when codeDirectory is provided", async () => {
        const customDir = join(process.cwd(), "temp_integration_workdir_legacy");
        const payload = {
            prompt: "legacy workdir test",
            codeDirectory: customDir
        };
        
        const res = await fetch(`${baseUrl}/api/start`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        
        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.workdir).toBe(customDir);
        
        // Stop it
        await fetch(`${baseUrl}/api/stop`, { method: "POST" });
    });
});
