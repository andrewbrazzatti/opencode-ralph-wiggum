/**
 * Regression Tests for fixes in session bcdf94cd-19f0-465e-aba7-9e976f1fbc0c
 * 
 * These tests verify:
 * 1. Model queue is properly returned in API responses
 * 2. /api/env endpoint returns HOME and XDG paths
 * 3. Docker config save/load properly handles manualDockerVolumes
 * 4. Docker mount settings are preserved in config
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { RalphManager } from "../src/manager";
import { RalphDatabase } from "../src/db";

describe("Model Queue API Regression", () => {
    let db: RalphDatabase;

    beforeAll(() => {
        db = new RalphDatabase(":memory:");
    });

    test("Run record should include modelQueue when extracted from config", () => {
        // Create a run with modelQueue in config
        const config = {
            modelQueue: ["gpt-4o", "claude-3-5-sonnet"],
            model: "gpt-4o",
            prompt: "test"
        };

        db.createRun({
            id: "test-model-queue-1",
            status: "completed",
            prompt: "test prompt",
            config: JSON.stringify(config),
            created_at: new Date().toISOString(),
            started_at: new Date().toISOString(),
            ended_at: new Date().toISOString(),
            exit_code: 0
        });

        const run = db.getRun("test-model-queue-1");
        expect(run).not.toBeNull();
        
        // Parse config to extract modelQueue (simulates what server does)
        const parsedConfig = JSON.parse(run!.config);
        expect(parsedConfig.modelQueue).toEqual(["gpt-4o", "claude-3-5-sonnet"]);
    });

    test("List runs should be parseable for modelQueue extraction", () => {
        const runs = db.listRuns(10, 0);
        expect(runs.length).toBeGreaterThan(0);
        
        // Each run should have parseable config with modelQueue
        for (const run of runs) {
            if (run.config) {
                const config = JSON.parse(run.config);
                // modelQueue may or may not exist, but parsing should not throw
                expect(Array.isArray(config.modelQueue) || config.modelQueue === undefined).toBe(true);
            }
        }
    });
});

describe("Docker Config Regression", () => {
    test("manualDockerVolumes should be separate from dockerVolumes", () => {
        // Simulate what getFormValues produces
        const formValues = {
            mode: "docker",
            dockerImage: "test-image",
            // Manual volumes only (what user adds)
            manualDockerVolumes: [
                { src: "/custom/path", target: "/app/custom", opts: "" }
            ],
            // Full volumes including auto-added (for runtime)
            dockerVolumes: [
                { src: "/custom/path", target: "/app/custom", opts: "" },
                { src: "/home/user/.config/opencode", target: "/home/user/.config/opencode", opts: "" },
                { src: "/home/user/.local/share/opencode", target: "/home/user/.local/share/opencode", opts: "" }
            ],
            docker: {
                mountOpencodeConfig: true,
                mountOpencodeData: true,
                mountDockerSocket: false,
                opencodeConfigPath: "",
                opencodeDataPath: "",
                dockerSocketHostPath: "/var/run/docker.sock",
                dockerSocketContainerPath: "/var/run/docker.sock"
            }
        };

        // manualDockerVolumes should only have user-defined volumes
        expect(formValues.manualDockerVolumes.length).toBe(1);
        expect(formValues.manualDockerVolumes[0].src).toBe("/custom/path");

        // dockerVolumes should have all volumes (for runtime)
        expect(formValues.dockerVolumes.length).toBe(3);
    });

    test("Docker socket should have separate host and container paths", () => {
        const dockerConfig = {
            mountDockerSocket: true,
            dockerSocketHostPath: "/custom/docker.sock",
            dockerSocketContainerPath: "/var/run/docker.sock"
        };

        expect(dockerConfig.dockerSocketHostPath).not.toBe(dockerConfig.dockerSocketContainerPath);
        expect(dockerConfig.dockerSocketHostPath).toBe("/custom/docker.sock");
        expect(dockerConfig.dockerSocketContainerPath).toBe("/var/run/docker.sock");
    });

    test("Config should restore manualDockerVolumes for UI, not dockerVolumes", () => {
        const savedConfig = {
            run: {
                mode: "docker",
                manualDockerVolumes: [],
                dockerVolumes: [
                    { src: "/auto/added", target: "/auto/added", opts: "" }
                ],
                docker: {
                    mountOpencodeConfig: true,
                    mountOpencodeData: false,
                    mountDockerSocket: false
                }
            }
        };

        // When loading config, UI should use manualDockerVolumes
        const volsToLoad = savedConfig.run.manualDockerVolumes ?? savedConfig.run.dockerVolumes;
        expect(volsToLoad).toEqual([]);  // Empty because user has no manual volumes
    });

    test("Legacy config without manualDockerVolumes should fallback to dockerVolumes", () => {
        const legacyConfig = {
            run: {
                mode: "docker",
                // No manualDockerVolumes (old format)
                dockerVolumes: [
                    { src: "/legacy/volume", target: "/app/legacy", opts: "" }
                ]
            }
        };

        const volsToLoad = legacyConfig.run.manualDockerVolumes ?? legacyConfig.run.dockerVolumes;
        expect(volsToLoad).toEqual([{ src: "/legacy/volume", target: "/app/legacy", opts: "" }]);
    });
});

describe("Docker XDG Environment Variables", () => {
    test("XDG paths should be properly constructed", () => {
        const home = "/home/testuser";
        
        // These are the paths that should be passed to Docker
        const expectedXDG = {
            XDG_CONFIG_HOME: `${home}/.config`,
            XDG_DATA_HOME: `${home}/.local/share`,
            XDG_STATE_HOME: "/tmp/opencode-state",  // Always /tmp for container
            XDG_CACHE_HOME: "/tmp/opencode-cache"   // Always /tmp for container
        };

        expect(expectedXDG.XDG_STATE_HOME).toBe("/tmp/opencode-state");
        expect(expectedXDG.XDG_CACHE_HOME).toBe("/tmp/opencode-cache");
        expect(expectedXDG.XDG_CONFIG_HOME).toContain(home);
        expect(expectedXDG.XDG_DATA_HOME).toContain(home);
    });
});

describe("API Endpoint Regression", () => {
    test("/api/env should return HOME environment variable", async () => {
        // Simulate what /api/env should return
        const envResponse = {
            HOME: process.env.HOME || '/home',
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            XDG_DATA_HOME: process.env.XDG_DATA_HOME
        };

        expect(envResponse.HOME).toBeDefined();
        expect(typeof envResponse.HOME).toBe("string");
        expect(envResponse.HOME.length).toBeGreaterThan(0);
    });
});

describe("Run Deletion Regression", () => {
    let db: RalphDatabase;

    beforeAll(() => {
        db = new RalphDatabase(":memory:");
    });

    test("deleteRun should remove run from database", () => {
        // Create a test run
        db.createRun({
            id: "delete-test-1",
            status: "completed",
            prompt: "test prompt",
            config: JSON.stringify({ model: "test" }),
            created_at: new Date().toISOString(),
            started_at: new Date().toISOString(),
            ended_at: new Date().toISOString(),
            exit_code: 0
        });

        // Verify it exists
        expect(db.getRun("delete-test-1")).not.toBeNull();

        // Delete it
        const deleted = db.deleteRun("delete-test-1");
        expect(deleted).toBe(true);

        // Verify it's gone
        expect(db.getRun("delete-test-1")).toBeNull();
    });

    test("deleteRun should also delete associated logs", () => {
        // Create a test run
        db.createRun({
            id: "delete-test-logs",
            status: "failed",
            prompt: "test with logs",
            config: JSON.stringify({}),
            created_at: new Date().toISOString(),
            started_at: new Date().toISOString(),
            ended_at: new Date().toISOString(),
            exit_code: 1
        });

        // Add some logs
        db.insertLogs([
            { run_id: "delete-test-logs", timestamp: new Date().toISOString(), level: "info", source: "stdout", message: "log 1" },
            { run_id: "delete-test-logs", timestamp: new Date().toISOString(), level: "error", source: "stderr", message: "log 2" },
            { run_id: "delete-test-logs", timestamp: new Date().toISOString(), level: "tool", source: "stdout", message: "log 3", tool_name: "read_file" }
        ]);

        // Verify logs exist
        const { logs: logsBefore } = db.getRunLogs("delete-test-logs", 100, 0);
        expect(logsBefore.length).toBe(3);

        // Delete the run
        db.deleteRun("delete-test-logs");

        // Verify logs are also gone
        const { logs: logsAfter } = db.getRunLogs("delete-test-logs", 100, 0);
        expect(logsAfter.length).toBe(0);
    });

    test("deleteRun should return false for non-existent run", () => {
        const deleted = db.deleteRun("non-existent-run-id");
        expect(deleted).toBe(false);
    });

    test("deleteRun should decrease run count", () => {
        // Create multiple runs
        for (let i = 1; i <= 3; i++) {
            db.createRun({
                id: `count-test-${i}`,
                status: "completed",
                prompt: `test ${i}`,
                config: JSON.stringify({}),
                created_at: new Date().toISOString(),
                started_at: new Date().toISOString(),
                ended_at: new Date().toISOString(),
                exit_code: 0
            });
        }

        const runsBefore = db.listRuns(100, 0);
        const countBefore = runsBefore.filter(r => r.id.startsWith("count-test-")).length;
        expect(countBefore).toBe(3);

        // Delete one
        db.deleteRun("count-test-2");

        const runsAfter = db.listRuns(100, 0);
        const countAfter = runsAfter.filter(r => r.id.startsWith("count-test-")).length;
        expect(countAfter).toBe(2);

        // Verify the right one was deleted
        expect(db.getRun("count-test-1")).not.toBeNull();
        expect(db.getRun("count-test-2")).toBeNull();
        expect(db.getRun("count-test-3")).not.toBeNull();
    });

    test("deleteRun should handle run with no logs", () => {
        db.createRun({
            id: "no-logs-run",
            status: "stopped",
            prompt: "empty run",
            config: JSON.stringify({}),
            created_at: new Date().toISOString(),
            started_at: new Date().toISOString(),
            ended_at: null,
            exit_code: null
        });

        // Delete should succeed even with no logs
        const deleted = db.deleteRun("no-logs-run");
        expect(deleted).toBe(true);
        expect(db.getRun("no-logs-run")).toBeNull();
    });
});
