import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { RalphManager } from "../src/manager";
import { join } from "path";
import { rmSync, mkdirSync, writeFileSync } from "fs";
import { ReadableStream } from "stream/web";

describe("RalphManager", () => {
    const testDir = join(process.cwd(), "temp_test_manager");
    const logsDir = join(testDir, "logs");
    const runsDir = join(testDir, "runs");
    const dbPath = testDir;

    beforeEach(() => {
        mkdirSync(logsDir, { recursive: true });
        mkdirSync(runsDir, { recursive: true });
    });

    afterEach(() => {
        rmSync(testDir, { recursive: true, force: true });
    });

    test("should start multiple runs in parallel", async () => {
        const createMockProc = () => ({
            stdout: new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode("Iteration 1\n"));
                    controller.close();
                }
            }),
            stderr: new ReadableStream({
                start(controller) {
                    controller.close();
                }
            }),
            kill: mock(),
            onExit: null as any
        });

        const mockSpawner = mock((cmd, opts) => {
            if (cmd[0] === "which") {
                return {
                    stdout: new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode("/usr/bin/ralph\n"));
                            controller.close();
                        }
                    })
                };
            }
            
            const p = createMockProc();
            if (opts && opts.onExit) {
                // Simulate exit after a short delay
                setTimeout(() => opts.onExit(p, 0, null, null), 10);
            }
            return p;
        });

        const manager = new RalphManager(logsDir, runsDir, mockSpawner as any, dbPath);

        const runId1 = await manager.start({ prompt: "task 1", workdir: join(testDir, "work1") });
        const runId2 = await manager.start({ prompt: "task 2", workdir: join(testDir, "work2") });

        expect(runId1).toBeDefined();
        expect(runId2).toBeDefined();
        expect(runId1).not.toBe(runId2);
        expect(manager.listActiveRuns()).toHaveLength(2);

        // Wait for processes to "exit"
        await new Promise(resolve => setTimeout(resolve, 50));

        // Note: they remain in the map but status should update if we refresh or check metadata
        const run1 = manager.getRun(runId1);
        const run2 = manager.getRun(runId2);
        expect(run1?.metadata.status).toBe("completed");
        expect(run2?.metadata.status).toBe("completed");
    });

    test("should block concurrent runs in same workdir", async () => {
        const mockSpawner = mock((cmd) => {
             if (cmd[0] === "which") {
                return {
                    stdout: new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode("/usr/bin/ralph\n"));
                            controller.close();
                        }
                    })
                };
            }
            return {
                stdout: new ReadableStream({ start(c) { c.close(); } }),
                stderr: new ReadableStream({ start(c) { c.close(); } }),
                kill: mock()
            };
        });

        const manager = new RalphManager(logsDir, runsDir, mockSpawner as any, dbPath);
        const workdir = join(testDir, "common_workdir");

        await manager.start({ prompt: "task 1", workdir });
        
        await expect(manager.start({ prompt: "task 2", workdir }))
            .rejects.toThrow(/already active in/);
    });

    test("should isolate logs between runs", async () => {
        const mockSpawner = mock((cmd) => {
             if (cmd[0] === "which") {
                return {
                    stdout: new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode("/usr/bin/ralph\n"));
                            controller.close();
                        }
                    })
                };
            }
            return {
                stdout: new ReadableStream({
                    start(controller) {
                        const taskNum = cmd.find((arg: string) => arg.includes("task"))?.split(" ")[1];
                        controller.enqueue(new TextEncoder().encode(`Log from task ${taskNum}\n`));
                        controller.close();
                    }
                }),
                stderr: new ReadableStream({ start(c) { c.close(); } }),
                kill: mock()
            };
        });

        const manager = new RalphManager(logsDir, runsDir, mockSpawner as any, dbPath);

        const runId1 = await manager.start({ prompt: "task 1", workdir: join(testDir, "work1") });
        const runId2 = await manager.start({ prompt: "task 2", workdir: join(testDir, "work2") });

        // Wait for log streaming
        await new Promise(resolve => setTimeout(resolve, 100));

        const run1 = manager.getRun(runId1);
        const run2 = manager.getRun(runId2);

        expect(run1?.logs.some(l => l.message.includes("Log from task 1"))).toBe(true);
        expect(run1?.logs.some(l => l.message.includes("Log from task 2"))).toBe(false);

        expect(run2?.logs.some(l => l.message.includes("Log from task 2"))).toBe(true);
        expect(run2?.logs.some(l => l.message.includes("Log from task 1"))).toBe(false);
    });

    test("should stop a specific run", async () => {
        const killMock = mock();
        const mockSpawner = mock((cmd) => {
             if (cmd[0] === "which") {
                return {
                    stdout: new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode("/usr/bin/ralph\n"));
                            controller.close();
                        }
                    })
                };
            }
            return {
                stdout: new ReadableStream({ start(c) { } }), // never ends
                stderr: new ReadableStream({ start(c) { } }),
                kill: killMock
            };
        });

        const manager = new RalphManager(logsDir, runsDir, mockSpawner as any, dbPath);

        const runId1 = await manager.start({ prompt: "task 1", workdir: join(testDir, "work1") });
        const runId2 = await manager.start({ prompt: "task 2", workdir: join(testDir, "work2") });

        await manager.stop(runId1);

        expect(killMock).toHaveBeenCalled();
        expect(manager.getRun(runId1)?.metadata.status).toBe("stopping");
        expect(manager.getRun(runId2)?.metadata.status).toBe("active");
    });

    test("should map codeDirectory to workdir", async () => {
        const mockSpawner = mock((cmd) => {
             if (cmd[0] === "which") {
                return {
                    stdout: new ReadableStream({
                        start(controller) {
                            controller.enqueue(new TextEncoder().encode("/usr/bin/ralph\n"));
                            controller.close();
                        }
                    })
                };
            }
            return {
                stdout: new ReadableStream({ start(c) { c.close(); } }),
                stderr: new ReadableStream({ start(c) { c.close(); } }),
                kill: mock()
            };
        });

        const manager = new RalphManager(logsDir, runsDir, mockSpawner as any, dbPath);
        const customDir = join(testDir, "custom_code_dir");

        const runId = await manager.start({ prompt: "task 1", codeDirectory: customDir });
        const run = manager.getRun(runId);

        expect(run?.metadata.workdir).toBe(customDir);
    });
});
