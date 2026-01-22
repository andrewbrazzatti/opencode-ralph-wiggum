
import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";

// Mock fs functions before importing the class under test
mock.module("fs", () => {
  return {
    existsSync: mock(() => true),
    readFileSync: mock(() => "{}"),
    writeFileSync: mock(() => {}),
    mkdirSync: mock(() => {}),
    statSync: mock(() => ({ mtime: new Date() })),
  };
});

import { QuotaFetcher } from "../src/quota-fetcher";

describe("QuotaFetcher", () => {
  let fetcher: QuotaFetcher;
  const mockFetch = mock();
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = mockFetch;
    fetcher = new QuotaFetcher();
    mockFetch.mockReset();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("should handle missing auth file gracefully", async () => {
    // Mock fs.existsSync to return false
    (fs.existsSync as any).mockImplementation(() => false);

    const results = await fetcher.fetchAll();
    expect(results).toEqual({});
  });

  test("should fetch Google quotas correctly", async () => {
    const authData = {
      google: {
        type: "authorized_user",
        refresh: "refresh_token|project_id",
        access: "access_token",
        expires: Date.now() + 100000 // Valid
      }
    };

    (fs.existsSync as any).mockImplementation(() => true);
    (fs.readFileSync as any).mockImplementation(() => JSON.stringify(authData));

    // Mock Google API response
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        models: {
          "gemini-1.5-pro": {
            quotaInfo: {
              remainingFraction: 0.8,
              resetTime: "2024-01-01T00:00:00Z"
            }
          },
          "other-model": {
             // No quota info
          }
        }
      })
    });

    const results = await fetcher.fetchAll();
    
    expect(results.google).toBeDefined();
    expect(results.google.models).toHaveLength(1);
    expect(results.google.models[0].name).toBe("gemini-1.5-pro");
    expect(results.google.models[0].percentage).toBe(80);
    expect(results.google.isForbidden).toBe(false);
  });

  test("should fetch OpenAI quotas correctly", async () => {
     const authData = {
      openai: {
        type: "authorized_user",
        refresh: "refresh_token",
        access: "access_token",
        expires: Date.now() + 100000 // Valid
      }
    };

    (fs.existsSync as any).mockImplementation(() => true);
    (fs.readFileSync as any).mockImplementation(() => JSON.stringify(authData));

    // Mock OpenAI API response
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        rate_limit: {
            limit_reached: false,
            primary_window: {
                used_percent: 30.5,
                reset_at: 1700000000
            }
        },
        plan_type: "pro"
      })
    });

    const results = await fetcher.fetchAll();

    expect(results.openai).toBeDefined();
    expect(results.openai.models).toHaveLength(1);
    expect(results.openai.models[0].name).toBe("openai-session");
    expect(results.openai.models[0].percentage).toBeCloseTo(69.5);
    expect(results.openai.isForbidden).toBe(false);
    expect(results.openai.planType).toBe("pro");
  });

  test("should handle expired tokens by refreshing", async () => {
      const authData = {
      google: {
        type: "authorized_user",
        refresh: "refresh_token|project_id",
        access: "old_access_token",
        expires: Date.now() - 10000 // Expired
      }
    };

    (fs.existsSync as any).mockImplementation(() => true);
    (fs.readFileSync as any).mockImplementation(() => JSON.stringify(authData));

    // Mock Fetch
    // First call: Refresh Token
    // Second call: Quota API
    mockFetch.mockImplementation(async (url: string) => {
        if (url.includes("oauth2.googleapis.com/token")) {
            return {
                ok: true,
                json: async () => ({
                    access_token: "new_access_token",
                    expires_in: 3600
                })
            };
        }
        if (url.includes("cloudcode-pa.googleapis.com")) {
             return {
                ok: true,
                json: async () => ({ models: {} })
            };
        }
        return { ok: false, status: 404 };
    });

    await fetcher.fetchAll();

    // Verify writeFileSync was called to save new token
    expect(fs.writeFileSync).toHaveBeenCalled();
    const writeCall = (fs.writeFileSync as any).mock.calls[0];
    const writtenData = JSON.parse(writeCall[1]);
    expect(writtenData.google.access).toBe("new_access_token");
    expect(writtenData.google.expires).toBeGreaterThan(Date.now());
  });

  test("should handle forbidden (403) from Google gracefully", async () => {
    const authData = {
      google: {
        type: "authorized_user",
        refresh: "refresh_token|project_id",
        access: "access_token",
        expires: Date.now() + 100000
      }
    };

    (fs.existsSync as any).mockImplementation(() => true);
    (fs.readFileSync as any).mockImplementation(() => JSON.stringify(authData));

    mockFetch.mockResolvedValue({
      ok: false,
      status: 403,
      json: async () => ({})
    });

    const results = await fetcher.fetchAll();
    
    expect(results.google).toBeDefined();
    expect(results.google.isForbidden).toBe(true);
    expect(results.google.models).toEqual([]);
  });
});
