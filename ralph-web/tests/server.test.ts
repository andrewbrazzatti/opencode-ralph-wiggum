import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import { join } from "path";
import { RalphManager } from "../src/manager";

// Mock Bun spawn
const mockSpawn = mock(() => ({
    stdout: new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode("Iteration: 1\n| tool_name\nSuccess\n"));
            controller.close();
        }
    }),
    stderr: new ReadableStream(),
    kill: mock(),
    unref: mock()
} as any));

// Mock FS
mock.module("fs", () => ({
    existsSync: mock(() => true),
    appendFileSync: mock(),
    writeFileSync: mock(),
    mkdirSync: mock()
}));

describe("RalphManager", () => {
    let manager: RalphManager;
    const logsDir = "/mock/logs";
    const runsDir = "/mock/runs";

    beforeEach(() => {
        manager = new RalphManager(logsDir, runsDir, mockSpawn as any, ":memory:");
        mockSpawn.mockClear();
    });

    // ... (rest of tests)

    test("should parse logs correctly", async () => {
         // Create a manager and manually trigger log parsing or rely on spawn output
         await manager.start({ prompt: "test" });
         
         // Wait for stream processing 
         await new Promise(resolve => setTimeout(resolve, 100));
         
         expect(mockSpawn).toHaveBeenCalled();
        // The manager may call spawn multiple times (e.g., 'which ralph' first, then the actual command)
        const allCalls = (mockSpawn as any).mock.calls;
        // Find the call that runs ralph (not 'which ralph')
        const ralphCall = allCalls.find((call: any[]) => {
            const args = call[0];
            return args[0] !== "which" && args.some((arg: string) => arg.includes("ralph"));
        });
        expect(ralphCall).toBeDefined();
        if (ralphCall) {
            expect(ralphCall[0]).toContain("--db-path");
            expect(ralphCall[0]).toContain("--run-id");
        }
         
         const tools = manager.logs.filter((l: any) => l.level === "tool");
         expect(tools.length).toBeGreaterThan(0);
         expect(tools[0].tool).toBe("tool_name");
         
         const iterations = manager.iterations;
         expect(iterations).toBe(1);
    });
});
