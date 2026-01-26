import { describe, expect, test, mock, beforeEach } from "bun:test";
import { checkNotifications, resetNotificationState } from "../../src/client/app";
import { escapeHtml } from "../../src/client/helpers";

describe("Client App Tests", () => {

    describe("escapeHtml", () => {
        test("should escape special characters", () => {
            expect(escapeHtml("<div>")).toBe("&lt;div&gt;");
            expect(escapeHtml("'quote'")).toBe("&#039;quote&#039;");
            expect(escapeHtml('“smart”')).toBe("“smart”"); // Assuming only basic entities
            // Based on implementation: replace(/"/g, "&quot;")
            expect(escapeHtml('"test"')).toBe("&quot;test&quot;");
        });

        test("should return empty string for null/undefined", () => {
            expect(escapeHtml(null as any)).toBe("");
            expect(escapeHtml(undefined as any)).toBe("");
        });
    });

    describe("checkNotifications", () => {
        let notifyMock: any;

        beforeEach(() => {
            notifyMock = mock();
            resetNotificationState();
        });

        test("should notify on completion", () => {
            const data: any = {
                currentRun: {
                    runId: "run1",
                    status: "active"
                }
            };

            // First call keeps state (new run detected)
            checkNotifications(data, notifyMock);
            expect(notifyMock).toHaveBeenCalledTimes(0);

            // Update to completed
            data.currentRun.status = "completed";
            checkNotifications(data, notifyMock);

            expect(notifyMock).toHaveBeenCalledTimes(1);
            expect(notifyMock).toHaveBeenCalledWith("Ralph Loop Completed", expect.stringContaining("successfully"));
        });

        test("should notify on failure", () => {
            const data: any = {
                currentRun: {
                    runId: "run2",
                    status: "active"
                }
            };

            // Initial
            checkNotifications(data, notifyMock);

            // Fail
            data.currentRun.status = "failed";
            checkNotifications(data, notifyMock);

            expect(notifyMock).toHaveBeenCalledTimes(1);
            expect(notifyMock).toHaveBeenCalledWith("Ralph Loop Failed", expect.stringContaining("error"));
        });

        test("should not notify if status hasn't changed", () => {
            const data: any = {
                currentRun: {
                    runId: "run3",
                    status: "active"
                }
            };
            checkNotifications(data, notifyMock);
            checkNotifications(data, notifyMock);
            expect(notifyMock).toHaveBeenCalledTimes(0);
        });
    });
});
