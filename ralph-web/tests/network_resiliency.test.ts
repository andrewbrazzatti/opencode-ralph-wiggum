import { describe, expect, test, mock, beforeAll, afterAll } from "bun:test";
import { RalphManager } from "../src/manager";
import { join } from "path";
import { rmSync, mkdirSync } from "fs";

describe("Network Resiliency", () => {
    const DATA_DIR = join(process.cwd(), "temp_test_network");
    let manager: RalphManager;

    beforeAll(() => {
        mkdirSync(DATA_DIR, { recursive: true });
        manager = new RalphManager(join(DATA_DIR, "logs"), join(DATA_DIR, "runs"), undefined as any, DATA_DIR);
        manager.addTarget({
            name: "Remote",
            baseUrl: "http://remote.local",
            token: "token"
        });
    });

    afterAll(() => {
        rmSync(DATA_DIR, { recursive: true, force: true });
    });

    test("proxyRequest should throw on timeout and update health", async () => {
        const originalFetch = global.fetch;
        (global as any).fetch = mock(async (url: string, init: any) => {
            // Check if signal is already aborted
            if (init.signal?.aborted) {
                throw new DOMException("Aborted", "AbortError");
            }
            return new Promise((resolve, reject) => {
                init.signal?.addEventListener("abort", () => {
                    reject(new DOMException("Aborted", "AbortError"));
                });
                // Simulate slow response that will be aborted
            });
        });

        // Test with pre-aborted signal
        const target = manager.listTargets()[0];
        try {
            const controller = new AbortController();
            controller.abort();
            await manager.proxyRequest(target.id, "GET", "/api/status", undefined, controller.signal);
            // Should not reach here
            expect(true).toBe(false);
        } catch (e: any) {
            expect(e.name).toBe("AbortError");
        }
        
        expect(target.health?.status).toBe("unhealthy");
        expect(target.health?.error).toContain("timed out or was aborted");

        global.fetch = originalFetch;
    });

    test("SSE reconnection logic (simulated)", async () => {
        // This is mostly frontend logic, but we can verify the backend keeps heartbeating
        // In server.ts, heartbeats are sent every 15s.
        // We can test this by calling handleApiRequest and reading the stream.
    });
});
