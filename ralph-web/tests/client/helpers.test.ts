import { describe, expect, test } from "bun:test";
import {
    getRunId,
    getStartedAt,
    normalizeRun,
    normalizeLogEntry,
    hasCurrentRun,
    shouldShowMonitor,
    escapeHtml
} from "../../src/client/helpers";

describe("Client Helpers", () => {
    
    describe("getRunId", () => {
        test("should return runId when present (camelCase format)", () => {
            const run = { runId: "abc123", status: "active" };
            expect(getRunId(run)).toBe("abc123");
        });

        test("should fallback to id when runId is missing (DB format)", () => {
            const run = { id: "xyz789", status: "active" };
            expect(getRunId(run)).toBe("xyz789");
        });

        test("should prefer runId over id when both present", () => {
            const run = { runId: "preferred", id: "fallback", status: "active" };
            expect(getRunId(run)).toBe("preferred");
        });

        test("should return null for null input", () => {
            expect(getRunId(null)).toBe(null);
        });

        test("should return null for undefined input", () => {
            expect(getRunId(undefined)).toBe(null);
        });

        test("should return null when no id properties exist", () => {
            const run = { status: "active" };
            expect(getRunId(run)).toBe(null);
        });
    });

    describe("getStartedAt", () => {
        test("should return startedAt when present (camelCase)", () => {
            const run = { startedAt: "2024-01-01T00:00:00Z" };
            expect(getStartedAt(run)).toBe("2024-01-01T00:00:00Z");
        });

        test("should fallback to started_at (snake_case)", () => {
            const run = { started_at: "2024-01-01T00:00:00Z" };
            expect(getStartedAt(run)).toBe("2024-01-01T00:00:00Z");
        });

        test("should return null for null input", () => {
            expect(getStartedAt(null)).toBe(null);
        });
    });

    describe("normalizeRun", () => {
        test("should normalize DB format (snake_case) to camelCase", () => {
            const dbRun = {
                id: "run123",
                status: "active",
                prompt: "Test task",
                started_at: "2024-01-01T10:00:00Z",
                ended_at: null,
                exit_code: null,
                model_queue: ["model-a", "model-b"],
                max_iterations: 5,
                target_id: "local"
            };

            const normalized = normalizeRun(dbRun);

            expect(normalized).not.toBeNull();
            expect(normalized!.runId).toBe("run123");
            expect(normalized!.startedAt).toBe("2024-01-01T10:00:00Z");
            expect(normalized!.endedAt).toBe(null);
            expect(normalized!.exitCode).toBe(null);
            expect(normalized!.modelQueue).toEqual(["model-a", "model-b"]);
            expect(normalized!.maxIterations).toBe(5);
            expect(normalized!.targetId).toBe("local");
        });

        test("should pass through camelCase format unchanged", () => {
            const camelRun = {
                runId: "run456",
                status: "completed",
                prompt: "Another task",
                startedAt: "2024-01-01T12:00:00Z",
                endedAt: "2024-01-01T13:00:00Z",
                exitCode: 0,
                modelQueue: ["model-x"],
                maxIterations: 10
            };

            const normalized = normalizeRun(camelRun);

            expect(normalized!.runId).toBe("run456");
            expect(normalized!.startedAt).toBe("2024-01-01T12:00:00Z");
            expect(normalized!.endedAt).toBe("2024-01-01T13:00:00Z");
            expect(normalized!.exitCode).toBe(0);
        });

        test("should return null for null input", () => {
            expect(normalizeRun(null)).toBe(null);
        });

        test("should return null for undefined input", () => {
            expect(normalizeRun(undefined)).toBe(null);
        });

        test("should handle missing optional properties", () => {
            const minimalRun = { id: "min", status: "active" };
            const normalized = normalizeRun(minimalRun);

            expect(normalized!.runId).toBe("min");
            expect(normalized!.prompt).toBe("");
            expect(normalized!.modelQueue).toEqual([]);
            expect(normalized!.args).toEqual([]);
        });
    });

    describe("normalizeLogEntry", () => {
        test("should normalize DB format log entry", () => {
            const dbLog = {
                id: 1,
                timestamp: "2024-01-01T00:00:00Z",
                level: "info",
                source: "stdout",
                message: "Hello world",
                tool_name: "shell"
            };

            const normalized = normalizeLogEntry(dbLog);

            expect(normalized.ts).toBe("2024-01-01T00:00:00Z");
            expect(normalized.tool).toBe("shell");
            expect(normalized.level).toBe("info");
        });

        test("should pass through frontend format log entry", () => {
            const frontendLog = {
                id: 2,
                ts: "2024-01-01T00:00:00Z",
                level: "error",
                source: "stderr",
                message: "Error occurred",
                tool: "file_edit"
            };

            const normalized = normalizeLogEntry(frontendLog);

            expect(normalized.ts).toBe("2024-01-01T00:00:00Z");
            expect(normalized.tool).toBe("file_edit");
        });
    });

    describe("hasCurrentRun", () => {
        test("should return true when runId is present", () => {
            const data: any = {
                status: "active",
                currentRun: { runId: "abc123", status: "active" }
            };
            expect(hasCurrentRun(data)).toBe(true);
        });

        test("should return true when id is present (DB format)", () => {
            const data: any = {
                status: "active",
                currentRun: { id: "xyz789", status: "active" }
            };
            expect(hasCurrentRun(data)).toBe(true);
        });

        test("should return false when currentRun is null", () => {
            const data: any = { status: "idle", currentRun: null };
            expect(hasCurrentRun(data)).toBe(false);
        });

        test("should return false when currentRun has no id properties", () => {
            const data: any = {
                status: "active",
                currentRun: { status: "active" }  // missing runId and id
            };
            expect(hasCurrentRun(data)).toBe(false);
        });
    });

    describe("shouldShowMonitor", () => {
        const makeData = (overrides: any = {}): any => ({
            status: "idle",
            currentRun: null,
            iterations: 0,
            logs: [],
            loopState: null,
            ...overrides
        });

        test("should return false when forceStartView is true", () => {
            const data = makeData({ 
                status: "active", 
                currentRun: { runId: "abc", status: "active" } 
            });
            expect(shouldShowMonitor(data, true, null)).toBe(false);
        });

        test("should return true when status is active", () => {
            const data = makeData({ 
                status: "active", 
                currentRun: { runId: "abc", status: "active" } 
            });
            expect(shouldShowMonitor(data, false, null)).toBe(true);
        });

        test("should return true when currentRunId is set and run has data", () => {
            const data = makeData({ 
                currentRun: { id: "abc", status: "stopped" }  // DB format
            });
            expect(shouldShowMonitor(data, false, "abc")).toBe(true);
        });

        test("should return true when run has logs", () => {
            const data = makeData({ 
                currentRun: { runId: "abc", status: "completed" },
                logs: [{ ts: "now", level: "info", source: "stdout", message: "test" }]
            });
            expect(shouldShowMonitor(data, false, null)).toBe(true);
        });

        test("should return false when no active run, no selected run, no logs", () => {
            const data = makeData();
            expect(shouldShowMonitor(data, false, null)).toBe(false);
        });

        test("should return false when currentRun is null even with currentRunId set", () => {
            const data = makeData({ currentRun: null });
            expect(shouldShowMonitor(data, false, "some-id")).toBe(false);
        });
    });

    describe("escapeHtml", () => {
        test("should escape angle brackets", () => {
            expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
        });

        test("should escape ampersands", () => {
            expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
        });

        test("should escape quotes", () => {
            expect(escapeHtml('"test"')).toBe("&quot;test&quot;");
            expect(escapeHtml("'test'")).toBe("&#039;test&#039;");
        });

        test("should return empty string for null", () => {
            expect(escapeHtml(null as any)).toBe("");
        });

        test("should return empty string for undefined", () => {
            expect(escapeHtml(undefined as any)).toBe("");
        });

        test("should return empty string for empty string", () => {
            expect(escapeHtml("")).toBe("");
        });

        test("should handle complex HTML", () => {
            const input = '<script>alert("xss")</script>';
            const expected = '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;';
            expect(escapeHtml(input)).toBe(expected);
        });
    });
});
