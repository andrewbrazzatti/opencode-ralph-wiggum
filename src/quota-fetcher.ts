
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";

// --- Interfaces ---

export interface ModelQuota {
  name: string;
  percentage: number;
  resetTime: string;
  used?: number;
  limit?: number;
  remaining?: number;
}

export interface ProviderQuotaData {
  models: ModelQuota[];
  lastUpdated: string;
  isForbidden: boolean;
  planType?: string;
}

interface OpenCodeAuthFile {
  google?: {
    type: string;
    refresh: string; // "refresh_token|projectId"
    access: string;
    expires: number;
  };
  openai?: {
    type: string;
    refresh: string;
    access: string;
    expires: number;
    accountId?: string;
  };
  codex?: {
    type: string;
    refresh: string;
    access: string;
    expires: number;
    accountId?: string;
  };
}

// --- Google Fetcher ---

class GoogleQuotaFetcher {
  private readonly quotaAPIURL = "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";
  private readonly tokenURL = "https://oauth2.googleapis.com/token";
  private readonly clientId = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com";
  private readonly clientSecret = "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";
  private readonly userAgent = "antigravity/1.11.3 Darwin/arm64";

  async fetch(config: NonNullable<OpenCodeAuthFile['google']>, saveConfig: (updates: Partial<typeof config>) => void): Promise<ProviderQuotaData | null> {
    try {
      const parts = config.refresh.split("|");
      if (parts.length !== 2) return null;
      const refreshToken = parts[0];
      const projectId = parts[1];

      let accessToken = config.access;
      // Refresh if expired (with buffer)
      if (Date.now() > config.expires - 60000) {
        // console.log("Refreshing Google token...");
        const newTokens = await this.refreshToken(refreshToken);
        accessToken = newTokens.access_token;
        saveConfig({ 
            access: accessToken,
            expires: Date.now() + (newTokens.expires_in * 1000)
        });
      }

      const body = { project: projectId };
      const response = await fetch(this.quotaAPIURL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "User-Agent": this.userAgent,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
         if (response.status === 403) return { models: [], lastUpdated: new Date().toISOString(), isForbidden: true };
         throw new Error(`Google quota fetch failed: ${response.status}`);
      }

      const data = await response.json() as any;
      const models: ModelQuota[] = [];

      if (data.models) {
        for (const [name, info] of Object.entries<any>(data.models)) {
          if (name.includes("gemini") || name.includes("claude")) {
            if (info.quotaInfo) {
              models.push({
                name,
                percentage: (info.quotaInfo.remainingFraction ?? 0) * 100,
                resetTime: info.quotaInfo.resetTime ?? "",
              });
            }
          }
        }
      }

      return {
        models,
        lastUpdated: new Date().toISOString(),
        isForbidden: false,
      };

    } catch (e) {
      console.error("Google fetch failed:", e);
      return null;
    }
  }

  private async refreshToken(refreshToken: string) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });

    const response = await fetch(this.tokenURL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    if (!response.ok) throw new Error("Google token refresh failed");
    return await response.json() as any;
  }
}

// --- OpenAI / Codex Fetcher ---
// Common logic for ChatGPT backend API

class ChatGPTQuotaFetcher {
  private readonly usageURL = "https://chatgpt.com/backend-api/wham/usage";
  private readonly tokenURL = "https://auth.openai.com/oauth/token"; 
  // Client ID for Codex CLI / generic OpenAI (checking quotio code for separate IDs if needed)
  // Codex CLI client ID seen in quotio: app_EMoamEEZ73f0CkXaXp7hrann
  // Generic ones might vary. For now using the one from auth.json decoded if possible, OR hardcoding known ones.
  // The user provided auth.json shows "client_id": "app_EMoamEEZ73f0CkXaXp7hrann" in the decoded access token for Codex.
  private readonly codexClientId = "app_EMoamEEZ73f0CkXaXp7hrann"; 

  private readonly userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"; // Imitate browser/desktop app

  constructor(private name: string) {}

  async fetch(config: NonNullable<OpenCodeAuthFile['openai']>, saveConfig: (updates: Partial<typeof config>) => void): Promise<ProviderQuotaData | null> {
    try {
       let accessToken = config.access;
       
       // Refresh if expired
       if (Date.now() > config.expires - 60000) {
         // console.log(`Refreshing ${this.name} token...`);
         const newTokens = await this.refreshToken(config.refresh);
         accessToken = newTokens.access_token;
         // expires_in is usually returned
         const expiresIn = newTokens.expires_in || 3600; 
         saveConfig({
             access: accessToken,
             expires: Date.now() + (expiresIn * 1000)
         });
       }

       const response = await fetch(this.usageURL, {
         method: "GET",
         headers: {
           "Authorization": `Bearer ${accessToken}`,
           "User-Agent": this.userAgent,
           "Accept": "application/json",
           ...(config.accountId ? { "ChatGPT-Account-Id": config.accountId } : {})
         }
       });

       if (!response.ok) throw new Error(`${this.name} quota fetch failed: ${response.status}`);

       const data = await response.json() as any;
       return this.parseQuota(data);

    } catch (e) {
      console.error(`${this.name} fetch failed:`, e);
      return null;
    }
  }

  private async refreshToken(refreshToken: string) {
     // For standard auth.openai.com refresh
     const body = {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: this.codexClientId, // Using Codex client ID as default for these types
     };

     const response = await fetch(this.tokenURL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
     });

     if (!response.ok) throw new Error(`${this.name} token refresh failed`);
     return await response.json() as any;
  }

  private parseQuota(data: any): ProviderQuotaData {
      const models: ModelQuota[] = [];
      let limitReached = false;

      if (data.rate_limit) {
          limitReached = data.rate_limit.limit_reached ?? false;
          
          if (data.rate_limit.primary_window) {
              const used = data.rate_limit.primary_window.used_percent ?? 0;
              const reset = data.rate_limit.primary_window.reset_at ? new Date(data.rate_limit.primary_window.reset_at * 1000).toISOString() : "";
              models.push({
                  name: `${this.name}-session`,
                  percentage: 100 - used,
                  resetTime: reset
              });
          }
          if (data.rate_limit.secondary_window) {
              const used = data.rate_limit.secondary_window.used_percent ?? 0;
              const reset = data.rate_limit.secondary_window.reset_at ? new Date(data.rate_limit.secondary_window.reset_at * 1000).toISOString() : "";
              models.push({
                  name: `${this.name}-weekly`,
                  percentage: 100 - used,
                  resetTime: reset
              });
          }
      }

      return {
          models,
          lastUpdated: new Date().toISOString(),
          isForbidden: limitReached,
          planType: data.plan_type
      };
  }
}


// --- Main ---

export class QuotaFetcher {
    private authPath = join(homedir(), ".local/share/opencode/auth.json");

    async fetchAll(): Promise<Record<string, ProviderQuotaData>> {
        if (!existsSync(this.authPath)) {
            console.error("Auth file not found:", this.authPath);
            return {};
        }

        const authContent = readFileSync(this.authPath, "utf-8");
        const authData: OpenCodeAuthFile = JSON.parse(authContent);
        let dirty = false;

        const results: Record<string, ProviderQuotaData> = {};

        // Google
        if (authData.google) {
            const googleFetcher = new GoogleQuotaFetcher();
            const quota = await googleFetcher.fetch(authData.google, (updates) => {
                if (authData.google) Object.assign(authData.google, updates);
                dirty = true;
            });
            if (quota) results["google"] = quota;
        }

        // OpenAI
        if (authData.openai) {
            const fetcher = new ChatGPTQuotaFetcher("openai");
            const quota = await fetcher.fetch(authData.openai, (updates) => {
                 if (authData.openai) Object.assign(authData.openai, updates);
                 dirty = true;
            });
            if (quota) results["openai"] = quota;
        }

        // Codex
        if (authData.codex) {
            const fetcher = new ChatGPTQuotaFetcher("codex");
            const quota = await fetcher.fetch(authData.codex, (updates) => {
                 if (authData.codex) Object.assign(authData.codex, updates);
                 dirty = true;
            });
            if (quota) results["codex"] = quota;
        }

        if (dirty) {
            try {
                writeFileSync(this.authPath, JSON.stringify(authData, null, 2));
            } catch (e) {
                console.error("Failed to save updated tokens:", e);
            }
        }

        return results;
    }
}

if (import.meta.main) {
    (async () => {
        const fetcher = new QuotaFetcher();
        const results = await fetcher.fetchAll();
        console.log(JSON.stringify(results, null, 2));
    })();
}
