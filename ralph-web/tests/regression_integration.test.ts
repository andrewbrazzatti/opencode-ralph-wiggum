/**
 * Integration tests for regression fixes
 * Tests actual server endpoint behavior
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn, which } from "bun";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

const TEST_PORT = 45680;
const TEST_DIR = join(process.cwd(), "temp_regression_integration_test");
// Resolve bun path before any test changes cwd
const BUN_PATH = which("bun") || process.execPath;

describe("Regression Integration Tests", () => {
    let serverProc: any;
    const baseUrl = `http://localhost:${TEST_PORT}`;

    beforeAll(async () => {
        // Setup temp dir
        mkdirSync(TEST_DIR, { recursive: true });
        mkdirSync(join(TEST_DIR, ".opencode"), { recursive: true });

        // Spawn server from current working dir (same as other integration tests)
        const serverPath = join(process.cwd(), "src/server.ts");
        serverProc = spawn([BUN_PATH, "run", serverPath, "--port", String(TEST_PORT)], {
            cwd: process.cwd(),
            env: {
                ...process.env,
                PORT: String(TEST_PORT)
            }
        });

        // Wait for server to start
        for (let i = 0; i < 30; i++) {
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
        // Cleanup temp dir
        try {
            rmSync(TEST_DIR, { recursive: true, force: true });
        } catch (e) {}
    });

    test("GET /api/env should return HOME and XDG paths", async () => {
        const res = await fetch(`${baseUrl}/api/env`);
        expect(res.status).toBe(200);
        
        const data = await res.json();
        expect(data.HOME).toBeDefined();
        expect(typeof data.HOME).toBe("string");
        expect(data.HOME.length).toBeGreaterThan(0);
        
        // XDG paths may be undefined if not set in environment
        // Just verify response is valid JSON object
        expect(typeof data).toBe("object");
    });

    test("GET /api/runs should return runs with modelQueue field", async () => {
        const res = await fetch(`${baseUrl}/api/runs`);
        expect(res.status).toBe(200);
        
        const data = await res.json();
        expect(data.runs).toBeDefined();
        expect(Array.isArray(data.runs)).toBe(true);
        
        // Each run should have modelQueue (even if empty)
        for (const run of data.runs) {
            expect("modelQueue" in run).toBe(true);
            expect(Array.isArray(run.modelQueue)).toBe(true);
        }
    });

    test("POST /api/config should save and GET should retrieve config with docker settings", async () => {
        const testConfig = {
            version: 1,
            run: {
                prompt: "test prompt",
                mode: "docker",
                dockerImage: "test-image",
                manualDockerVolumes: [],
                dockerVolumes: [
                    { src: "/test/path", target: "/app/test", opts: "" }
                ],
                docker: {
                    mountOpencodeConfig: false,
                    mountOpencodeData: false,
                    mountDockerSocket: true,
                    opencodeConfigPath: "",
                    opencodeDataPath: "",
                    dockerSocketHostPath: "/custom/sock",
                    dockerSocketContainerPath: "/var/run/docker.sock"
                }
            }
        };

        // Save config
        const postRes = await fetch(`${baseUrl}/api/config`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(testConfig)
        });
        expect(postRes.status).toBe(200);
        const postData = await postRes.json();
        expect(postData.success).toBe(true);

        // Retrieve config
        const getRes = await fetch(`${baseUrl}/api/config`);
        expect(getRes.status).toBe(200);
        
        const getData = await getRes.json();
        expect(getData.run).toBeDefined();
        expect(getData.run.docker).toBeDefined();
        
        // Verify docker settings persisted correctly
        expect(getData.run.docker.mountOpencodeConfig).toBe(false);
        expect(getData.run.docker.mountOpencodeData).toBe(false);
        expect(getData.run.docker.mountDockerSocket).toBe(true);
        expect(getData.run.docker.dockerSocketHostPath).toBe("/custom/sock");
        expect(getData.run.docker.dockerSocketContainerPath).toBe("/var/run/docker.sock");
        
        // Verify manualDockerVolumes is separate
        expect(getData.run.manualDockerVolumes).toEqual([]);
    });

    test("Config with empty manualDockerVolumes should not populate volume list on load", async () => {
        const testConfig = {
            version: 1,
            run: {
                prompt: "test",
                mode: "docker",
                manualDockerVolumes: [],
                dockerVolumes: [
                    { src: "/auto/added", target: "/auto/added", opts: "" }
                ],
                docker: {
                    mountOpencodeConfig: true,
                    mountOpencodeData: true,
                    mountDockerSocket: false
                }
            }
        };

        await fetch(`${baseUrl}/api/config`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(testConfig)
        });

        const getRes = await fetch(`${baseUrl}/api/config`);
        const getData = await getRes.json();

        // manualDockerVolumes should be empty (what UI shows)
        // even though dockerVolumes has auto-added items
        expect(getData.run.manualDockerVolumes).toEqual([]);
        expect(getData.run.dockerVolumes.length).toBeGreaterThan(0);
    });
});
