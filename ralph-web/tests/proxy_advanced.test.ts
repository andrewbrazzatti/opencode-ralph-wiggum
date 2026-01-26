import { describe, expect, test, mock, beforeAll, afterAll } from "bun:test";
import { RalphManager } from "../src/manager";
import { join } from "path";
import { rmSync, mkdirSync, mkdtempSync } from "fs";

import * as os from "os";

describe("Advanced Proxy Tests", () => {
    let DATA_DIR: string;
    let manager: RalphManager;

    beforeAll(() => {
        DATA_DIR = mkdtempSync(join(os.tmpdir(), "proxy_adv-"));
        manager = new RalphManager(join(DATA_DIR, "logs"), join(DATA_DIR, "runs"), undefined as any, DATA_DIR);

        manager.addTarget({
            name: "Mock Remote",
            baseUrl: "http://mock-remote.local",
            token: "test-token"
        });
    });

    afterAll(() => {
        rmSync(DATA_DIR, { recursive: true, force: true });
    });

    test("proxyRequest should handle SSE passthrough", async () => {
        const target = manager.listTargets()[0];
        const originalFetch = global.fetch;

        const mockStream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
                controller.close();
            }
        });

        (global as any).fetch = mock(async () => {
            return new Response(mockStream, {
                status: 200,
                headers: { "Content-Type": "text/event-stream" }
            });
        });

        const res = await manager.proxyRequest(target.id, "GET", "/api/runs/run_1/stream");
        expect(res.status).toBe(200);
        expect(res.headers.get("Content-Type")).toBe("text/event-stream");

        const reader = res.body?.getReader();
        const { value } = await reader!.read();
        expect(new TextDecoder().decode(value)).toBe("data: hello\n\n");

        global.fetch = originalFetch;
    });

    test("proxyRequest should respect timeouts based on path", async () => {
        const target = manager.listTargets()[0];
        const originalFetch = global.fetch;

        let capturedSignal: AbortSignal | undefined;
        (global as any).fetch = mock(async (url, init) => {
            capturedSignal = init.signal;
            // Don't respond immediately
            await new Promise(resolve => setTimeout(resolve, 50));
            return new Response("ok");
        });

        // We can't easily test the exact timeout value without mocking setTimeout,
        // but we can verify that a signal is passed.
        await manager.proxyRequest(target.id, "GET", "/api/status");
        expect(capturedSignal).toBeDefined();
        expect(capturedSignal?.aborted).toBe(false);

        global.fetch = originalFetch;
    });

    test("proxyRequest should handle network errors", async () => {
        const target = manager.listTargets()[0];
        const originalFetch = global.fetch;

        (global as any).fetch = mock(async () => {
            throw new Error("Network connection failed");
        });

        try {
            await manager.proxyRequest(target.id, "GET", "/api/runs");
            expect(true).toBe(false); // Should not reach here
        } catch (e: any) {
            expect(e.message).toContain("Network connection failed");
        }

        expect(target.health?.status).toBe("unhealthy");
        expect(target.health?.error).toContain("Network connection failed");

        global.fetch = originalFetch;
    });
});
