import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { QuotaFetcher } from "../src/quota-fetcher";
import * as fs from "fs";
import * as os from "os";
import { join } from "path";

// Create a mock for homedir that we can control
const mockHomedir = mock(() => "/tmp/mock-home-default");

mock.module("os", () => ({
    homedir: mockHomedir
}));

describe("QuotaFetcher", () => {
    let fetcher: QuotaFetcher;
    let tempHome: string;
    let authPath: string;

    beforeEach(() => {
        // Setup fresh temp home
        tempHome = fs.mkdtempSync(join(os.tmpdir(), "quota-test-"));
        mockHomedir.mockReturnValue(tempHome);
        
        // Ensure directory structure exists
        const opencodeDir = join(tempHome, ".local/share/opencode");
        fs.mkdirSync(opencodeDir, { recursive: true });
        authPath = join(opencodeDir, "auth.json");

        fetcher = new QuotaFetcher();
    });

    afterEach(() => {
        try {
            fs.rmSync(tempHome, { recursive: true, force: true });
        } catch {}
    });
    
    test("should handle missing auth file", async () => {
        // No auth file created
        const results = await fetcher.fetchAll();
        expect(results).toEqual({});
    });

    test("should fetch google quota", async () => {
        const authData = {
            google: {
                refresh: "refresh|project",
                access: "access",
                expires: Date.now() + 10000
            }
        };
        fs.writeFileSync(authPath, JSON.stringify(authData));
        
        // Mock global fetch
        const originalFetch = global.fetch;
        global.fetch = mock(async (url) => {
             if (url.toString().includes("googleapis")) {
                 return new Response(JSON.stringify({
                     models: {
                         "gemini-pro": {
                             quotaInfo: {
                                 remainingFraction: 0.5,
                                 resetTime: "soon"
                             }
                         }
                     }
                 }));
             }
             return new Response("{}", { status: 404 });
        });

        try {
            const results = await fetcher.fetchAll();
            expect(results.google).toBeDefined();
            expect(results.google.models).toHaveLength(1);
            expect(results.google.models[0].name).toBe("gemini-pro");
            expect(results.google.models[0].percentage).toBe(50);
        } finally {
            global.fetch = originalFetch;
        }
    });
});

