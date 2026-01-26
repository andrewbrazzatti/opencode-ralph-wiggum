#!/usr/bin/env bun
/**
 * Ralph Web Interface
 * 
 * Provides a web-based UI for controlling the Ralph loop.
 */

import { serve, file, spawn } from "bun";
import { join } from "path";
import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync, readdirSync, openSync, readSync, fstatSync, closeSync, unlinkSync } from "fs";

// CLI Arguments
const args = Bun.argv.slice(2);
let port = parseInt(process.env.PORT || "3000");
let host = process.env.HOST || "127.0.0.1";
let authToken = process.env.RALPH_WEB_TOKEN || "";
let corsOrigin = process.env.CORS_ORIGIN || "";

for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" || args[i] === "-p") {
        if (args[i + 1] === undefined) {
            console.error("Missing value for --port/-p");
            process.exit(1);
        }
        const parsed = Number.parseInt(args[++i], 10);
        if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
            console.error("Invalid --port/-p value. Expected an integer between 1 and 65535.");
            process.exit(1);
        }
        port = parsed;
    } else if (args[i] === "--host" || args[i] === "-h") {
        if (args[i + 1] === undefined) {
            console.error("Missing value for --host/-h");
            process.exit(1);
        }
        host = args[++i];
    } else if (args[i] === "--expose") {
        host = "0.0.0.0";
    } else if (args[i] === "--token") {
        if (args[i + 1] === undefined) {
            console.error("Missing value for --token");
            process.exit(1);
        }
        authToken = args[++i];
    } else if (args[i] === "--cors-origin") {
        if (args[i + 1] === undefined) {
            console.error("Missing value for --cors-origin");
            process.exit(1);
        }
        corsOrigin = args[++i];
    }
}

const PORT = port;
const HOST = host;
const TOKEN = authToken;
const CORS_ORIGIN = corsOrigin;
const WEB_ROOT = join(import.meta.dir, "../public");
const DATA_DIR = join(process.cwd(), ".opencode/ralph-web");
const LOGS_DIR = join(DATA_DIR, "logs");
const RUNS_DIR = join(DATA_DIR, "runs");
const CONFIG_PATH = join(process.cwd(), ".opencode/ralph-run.config.json");
const STATE_PATH = join(process.cwd(), ".opencode/ralph-loop.state.json");

// Ensure directories exist
mkdirSync(LOGS_DIR, { recursive: true });
mkdirSync(RUNS_DIR, { recursive: true });

console.log(`Starting Ralph Web on http://${HOST}:${PORT}`);

// State Management
import { RalphManager, type LogEntry } from "./manager";

const manager = new RalphManager(LOGS_DIR, RUNS_DIR);

// --- API Handlers ---
const loadLoopState = () => {
    if (!existsSync(STATE_PATH)) {
        return null;
    }
    try {
        return JSON.parse(readFileSync(STATE_PATH, "utf-8"));
    } catch {
        return null;
    }
};

export const handleApiRequest = async (req: Request, url: URL): Promise<Response> => {
    // --- Targets ---

    // GET /api/targets - List targets
    if (url.pathname === "/api/targets" && req.method === "GET") {
        const targets = manager.listTargets();
        return Response.json({ targets });
    }

    // POST /api/targets - Add target
    if (url.pathname === "/api/targets" && req.method === "POST") {
        try {
            const body = await req.json();
            if (!body.name || !body.baseUrl) {
                return Response.json({ error: "Missing name or baseUrl" }, { status: 400 });
            }
            const target = manager.addTarget(body);
            return Response.json(target, { status: 201 });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 500 });
        }
    }

    // DELETE /api/targets/:id - Remove target
    const targetMatch = url.pathname.match(/^\/api\/targets\/([^\/]+)$/);
    if (targetMatch && req.method === "DELETE") {
        const id = targetMatch[1];
        manager.removeTarget(id);
        return Response.json({ success: true });
    }

    // POST /api/targets/:id/test - Test target connectivity
    const targetTestMatch = url.pathname.match(/^\/api\/targets\/([^\/]+)\/test$/);
    if (targetTestMatch && req.method === "POST") {
        const id = targetTestMatch[1];
        try {
            const result = await manager.testTarget(id);
            return Response.json(result);
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 404 });
        }
    }

    // GET /api/models - List available models
    if (url.pathname === "/api/models" && req.method === "GET") {
        const models = await manager.getModels();
        return Response.json({ models });
    }

    // GET /api/env - Return environment info for frontend
    if (url.pathname === "/api/env" && req.method === "GET") {
        return Response.json({ 
            HOME: process.env.HOME || '/home',
            XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
            XDG_DATA_HOME: process.env.XDG_DATA_HOME
        });
    }

    // --- Proxy Routes ---
    const proxyRunsMatch = url.pathname.match(/^\/api\/targets\/([^\/]+)\/runs$/);
    if (proxyRunsMatch) {
        const targetId = proxyRunsMatch[1];
        try {
            const query = url.search ? url.search : "";
            const res = await manager.proxyRequest(targetId, req.method, `/api/runs${query}`, req.method === "POST" ? await req.json() : undefined);
            return new Response(res.body, {
                status: res.status,
                headers: { "Content-Type": "application/json" }
            });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 502 });
        }
    }

    const proxyRunIdMatch = url.pathname.match(/^\/api\/targets\/([^\/]+)\/runs\/([^\/]+)$/);
    if (proxyRunIdMatch && req.method === "GET") {
        const targetId = proxyRunIdMatch[1];
        const runId = proxyRunIdMatch[2];
        try {
            const res = await manager.proxyRequest(targetId, "GET", `/api/runs/${runId}`);
            return new Response(res.body, {
                status: res.status,
                headers: { "Content-Type": "application/json" }
            });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 502 });
        }
    }

    const proxyRunStopMatch = url.pathname.match(/^\/api\/targets\/([^\/]+)\/runs\/([^\/]+)\/stop$/);
    if (proxyRunStopMatch && req.method === "POST") {
        const targetId = proxyRunStopMatch[1];
        const runId = proxyRunStopMatch[2];
        try {
            const res = await manager.proxyRequest(targetId, "POST", `/api/runs/${runId}/stop`);
            return new Response(res.body, {
                status: res.status,
                headers: { "Content-Type": "application/json" }
            });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 502 });
        }
    }

    const proxyRunContextMatch = url.pathname.match(/^\/api\/targets\/([^\/]+)\/runs\/([^\/]+)\/context$/);
    if (proxyRunContextMatch && req.method === "POST") {
        const targetId = proxyRunContextMatch[1];
        const runId = proxyRunContextMatch[2];
        try {
            const body = await req.json();
            const res = await manager.proxyRequest(targetId, "POST", `/api/runs/${runId}/context`, body);
            return new Response(res.body, {
                status: res.status,
                headers: { "Content-Type": "application/json" }
            });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 502 });
        }
    }

    const proxyRunSkipMatch = url.pathname.match(/^\/api\/targets\/([^\/]+)\/runs\/([^\/]+)\/skip$/);
    if (proxyRunSkipMatch && req.method === "POST") {
        const targetId = proxyRunSkipMatch[1];
        const runId = proxyRunSkipMatch[2];
        try {
            const res = await manager.proxyRequest(targetId, "POST", `/api/runs/${runId}/skip`);
            return new Response(res.body, {
                status: res.status,
                headers: { "Content-Type": "application/json" }
            });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 502 });
        }
    }

    const proxyRunLogsMatch = url.pathname.match(/^\/api\/targets\/([^\/]+)\/runs\/([^\/]+)\/logs$/);
    if (proxyRunLogsMatch && req.method === "GET") {
        const targetId = proxyRunLogsMatch[1];
        const runId = proxyRunLogsMatch[2];
        const query = url.search ? url.search : "";
        try {
            const res = await manager.proxyRequest(targetId, "GET", `/api/runs/${runId}/logs${query}`);
            return new Response(res.body, {
                status: res.status,
                headers: { "Content-Type": "application/json" }
            });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 502 });
        }
    }

    const proxyRunStreamMatch = url.pathname.match(/^\/api\/targets\/([^\/]+)\/runs\/([^\/]+)\/stream$/);
    if (proxyRunStreamMatch && req.method === "GET") {
        const targetId = proxyRunStreamMatch[1];
        const runId = proxyRunStreamMatch[2];
        try {
            const res = await manager.proxyRequest(targetId, "GET", `/api/runs/${runId}/stream`, undefined, req.signal);
            
            // SSE passthrough
            return new Response(res.body, {
                status: res.status,
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                },
            });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 502 });
        }
    }

    // --- REST API Runs ---
    
    // GET /api/runs - List runs
    if (url.pathname === "/api/runs" && req.method === "GET") {
        const limit = parseInt(url.searchParams.get("limit") || "50");
        const offset = parseInt(url.searchParams.get("offset") || "0");
        const rawRuns = manager.getDatabase().listRuns(limit, offset);
        
        // Enrich runs with modelQueue from config
        const runs = rawRuns.map(run => {
            let modelQueue: string[] = [];
            try {
                const config = JSON.parse(run.config || "{}");
                modelQueue = config.modelQueue || [];
            } catch (e) {
                // ignore parse errors
            }
            return { ...run, modelQueue };
        });
        
        return Response.json({ runs });
    }

    // POST /api/runs - Start run
    if (url.pathname === "/api/runs" && req.method === "POST") {
        try {
            const body = await req.json();
            const runId = await manager.start(body);
            const run = manager.getRun(runId);
            return Response.json({ runId, status: "active", workdir: run?.metadata.workdir }, { status: 202 });
        } catch (e: any) {
            const status = e.message?.includes("already active") ? 409 : 500;
            return Response.json({ error: String(e) }, { status });
        }
    }

    // DELETE /api/runs/:id - Delete a run
    const runDeleteMatch = url.pathname.match(/^\/api\/runs\/([^\/]+)$/);
    if (runDeleteMatch && req.method === "DELETE") {
        const runId = runDeleteMatch[1];
        
        // Check if run is active
        const controller = manager.getRun(runId);
        if (controller) {
            return Response.json({ error: "Cannot delete an active run. Stop it first." }, { status: 409 });
        }
        
        const deleted = manager.getDatabase().deleteRun(runId);
        if (deleted) {
            return Response.json({ success: true, message: "Run deleted" });
        }
        return Response.json({ error: "Run not found" }, { status: 404 });
    }

    // GET /api/runs/:id - Get run details
    const runIdMatch = url.pathname.match(/^\/api\/runs\/([^\/]+)$/);
    if (runIdMatch && req.method === "GET") {
        const runId = runIdMatch[1];
        
        // First check if there's an active controller with live metadata
        const controller = manager.getRun(runId);
        if (controller) {
            const { total } = manager.getDatabase().getRunLogs(runId, 0, 0);
            return Response.json({ ...controller.metadata, logs_count: total });
        }
        
        // Fall back to database record
        const run = manager.getDatabase().getRun(runId);
        if (run) {
            const { total } = manager.getDatabase().getRunLogs(runId, 0, 0);
            // Parse config to extract modelQueue
            let modelQueue: string[] = [];
            try {
                const config = JSON.parse(run.config || "{}");
                modelQueue = config.modelQueue || [];
            } catch (e) {
                // ignore parse errors
            }
            return Response.json({ ...run, modelQueue, logs_count: total });
        }
        return Response.json({ error: "Run not found" }, { status: 404 });
    }

    // GET /api/runs/:id/logs - Get run logs
    const logsMatch = url.pathname.match(/^\/api\/runs\/([^\/]+)\/logs$/);
    if (logsMatch && req.method === "GET") {
        const runId = logsMatch[1];
        const limit = parseInt(url.searchParams.get("limit") || "1000");
        const offset = parseInt(url.searchParams.get("offset") || "0");
        const level = url.searchParams.get("level") || undefined;
        const afterId = url.searchParams.get("afterId") ? parseInt(url.searchParams.get("afterId")!) : undefined;
        
        const result = manager.getDatabase().getRunLogs(runId, limit, offset, level, afterId);
        return Response.json(result);
    }

    // GET /api/runs/:id/stream - Stream run logs (SSE)
    const streamMatch = url.pathname.match(/^\/api\/runs\/([^\/]+)\/stream$/);
    if (streamMatch && req.method === "GET") {
        const runId = streamMatch[1];
        const runController = manager.getRun(runId);
        
        if (!runController) {
            return Response.json({ error: "Run not found or not active" }, { status: 404 });
        }

        const heartbeatInterval = parseInt(process.env.RALPH_WEB_SSE_HEARTBEAT_INTERVAL || "15000");

        const stream = new ReadableStream({
            start(streamController) {
                const encoder = new TextEncoder();
                // Send initial state
                streamController.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify(runController.metadata)}\n\n`));

                let lastSentIndex = -1;

                const logListener = (entry: LogEntry) => {
                    try {
                        const index = runController.logs.lastIndexOf(entry);
                        if (index <= lastSentIndex) return;
                        streamController.enqueue(encoder.encode(`event: log\ndata: ${JSON.stringify(entry)}\n\n`));
                    } catch { /* closed */ }
                };

                runController.addLogListener(logListener);

                lastSentIndex = runController.logs.length - 1;
                const existingLogs = runController.logs.slice(0, lastSentIndex + 1);
                for (const log of existingLogs) {
                    streamController.enqueue(encoder.encode(`event: log\ndata: ${JSON.stringify(log)}\n\n`));
                }

                const heartbeat = setInterval(() => {
                    try {
                        streamController.enqueue(encoder.encode(`:ping\n\n`));
                    } catch {
                        clearInterval(heartbeat);
                    }
                }, heartbeatInterval);

                req.signal.addEventListener("abort", () => {
                    runController.removeLogListener(logListener);
                    clearInterval(heartbeat);
                    try {
                        streamController.close();
                    } catch { /* already closed */ }
                });
            }
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        });
    }

    // POST /api/runs/:id/stop - Stop run
    const stopMatch = url.pathname.match(/^\/api\/runs\/([^\/]+)\/stop$/);
    if (stopMatch && req.method === "POST") {
        const runId = stopMatch[1];
        const controller = manager.getRun(runId);
        if (controller) {
            await manager.stop(runId);
            return Response.json({ success: true, message: "Signal sent" });
        }
        
        const run = manager.getDatabase().getRun(runId);
        if (!run) {
            return Response.json({ error: "Run not found" }, { status: 404 });
        }
        return Response.json({ success: false, message: "Run is not active" }, { status: 400 });
    }

    // POST /api/runs/:id/context - Add context to run
    const runContextMatch = url.pathname.match(/^\/api\/runs\/([^\/]+)\/context$/);
    if (runContextMatch && req.method === "POST") {
        const runId = runContextMatch[1];
        try {
            const body = await req.json();
            await manager.addContext(body.context || body.text, runId);
            return Response.json({ success: true });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 500 });
        }
    }

    // POST /api/runs/:id/skip - Skip iteration in run
    const runSkipMatch = url.pathname.match(/^\/api\/runs\/([^\/]+)\/skip$/);
    if (runSkipMatch && req.method === "POST") {
        const runId = runSkipMatch[1];
        try {
            await manager.skip(runId);
            return Response.json({ success: true });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 500 });
        }
    }

    // --- Legacy / Existing Routes ---

    if (url.pathname === "/api/status") {
        const loopState = loadLoopState();
        return Response.json({
            status: manager.active ? "active" : "idle",
            currentRun: manager.currentRun,
            iterations: manager.iterations || loopState?.iteration || 0,
            loopState,
            logs: manager.logs.slice(-50)
        });
    }

    if (url.pathname === "/api/start" && req.method === "POST") {
        try {
            const body = await req.json();
            const runId = await manager.start({
                prompt: body.prompt,
                model: body.model,
                modelQueue: body.modelQueue,
                minIterations: body.minIterations,
                maxIterations: body.maxIterations,
                completionPromise: body.completionPromise,
                mode: body.mode,
                dockerImage: body.dockerImage,
                dockerArgs: body.dockerArgs,
                codeDirectory: body.codeDirectory,
                dockerVolumes: body.dockerVolumes,
                noCommit: body.noCommit,
                verboseTools: body.verboseTools,
                noPlugins: body.noPlugins,
                allowAll: body.allowAll,
                noStream: body.noStream
            });
            const run = manager.getRun(runId);
            return Response.json({ success: true, runId, workdir: run?.metadata.workdir });
        } catch (e: any) {
            const status = e.message?.includes("already active") ? 409 : 500;
            return Response.json({ error: String(e) }, { status });
        }
    }

    if (url.pathname === "/api/stop" && req.method === "POST") {
        if (!manager.active) {
            return Response.json({ error: "No active run" }, { status: 409 });
        }
        await manager.stop();
        return Response.json({ success: true });
    }

    if (url.pathname === "/api/context" && req.method === "POST") {
        if (!manager.active) {
            return Response.json({ error: "No active run" }, { status: 409 });
        }
        try {
            const body = await req.json();
            await manager.addContext(body.context || body.text); // support both for compat
            return Response.json({ success: true });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 500 });
        }
    }

    if (url.pathname === "/api/skip" && req.method === "POST") {
        if (!manager.active) {
            return Response.json({ error: "No active run" }, { status: 409 });
        }
        try {
            await manager.skip();
            return Response.json({ success: true });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 500 });
        }
    }

    if (url.pathname === "/api/queue") {
         try {
             if (req.method === "GET") {
                 if (manager.currentRun && manager.currentRun.modelQueue) {
                     return Response.json({ queue: manager.currentRun.modelQueue });
                 }
                 return Response.json({ queue: [] });
             }
             if (req.method === "POST") {
                 // No-op for now or update pending config
                 return Response.json({ success: true });
             }
         } catch(e) {
             return Response.json({ error: String(e) }, { status: 500 });
         }
    }

    if (url.pathname === "/api/config") {
        if (req.method === "GET") {
            if (existsSync(CONFIG_PATH)) {
                try {
                    const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
                    return Response.json(config);
                } catch (e) {
                    return Response.json({ error: "Failed to parse config" }, { status: 500 });
                }
            }
            return Response.json({ error: "Config not found" }, { status: 404 });
        } else if (req.method === "POST") {
            try {
                const config = await req.json();
                if (config.version !== 1) return Response.json({ error: "Invalid config version" }, { status: 400 });
                writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
                return Response.json({ success: true });
            } catch (e) {
                return Response.json({ error: String(e) }, { status: 500 });
            }
        }
        return new Response("Method not allowed", { status: 405 });
    }

    if (url.pathname === "/api/quota") {
        try {
            const { QuotaFetcher } = await import("./quota-fetcher");
            const fetcher = new QuotaFetcher();
            const results = await fetcher.fetchAll();
            return Response.json(results);
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 500 });
        }
    }

    // GET /api/logs/stream - Live log streaming
    if (url.pathname === "/api/logs/stream") {
        const runId = url.searchParams.get("runId");
        
        const stream = new ReadableStream({
            start(controller) {
                // Keep-alive comment
                controller.enqueue(": keep-alive\n\n");

                const listener = (entry: LogEntry) => {
                    try {
                        controller.enqueue(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
                    } catch {
                        // Channel closed presumably
                    }
                };

                // Only stream if it matches the active run
                if (manager.active && manager.currentRun?.runId === runId) {
                    manager.addLogListener(listener);
                } else {
                    // If not active or mismatched run, maybe just close or keep open but silent?
                    // Frontend reconnects if closed error, so maybe just keep open until client disconnects
                    // or until run actually finishes?
                    // For now, let's allow it to attempt to listen.
                    // If the run becomes active later? No, runId is specific.
                }

                req.signal.addEventListener("abort", () => {
                    manager.removeLogListener(listener);
                    controller.close();
                });
            }
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        });
    }
    
    
    // Legacy Events Endpoint (kept for backward compat)
    if (url.pathname === "/api/events") {
        const heartbeatInterval = parseInt(process.env.RALPH_WEB_SSE_HEARTBEAT_INTERVAL || "15000");
        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder();
                controller.enqueue(encoder.encode(`event: state\ndata: ${JSON.stringify({
                    active: manager.active,
                    currentRun: manager.currentRun,
                    iterations: manager.iterations
                })}\n\n`));
                
                // Existing logs
                for (const log of manager.logs) {
                    controller.enqueue(encoder.encode(`event: log\ndata: ${JSON.stringify(log)}\n\n`));
                }

                const logListener = (entry: LogEntry) => {
                    try {
                        controller.enqueue(encoder.encode(`event: log\ndata: ${JSON.stringify(entry)}\n\n`));
                    } catch { /* closed */ }
                };
                
                manager.addLogListener(logListener);

                const heartbeat = setInterval(() => {
                    try {
                        controller.enqueue(encoder.encode(`:ping\n\n`));
                    } catch {
                        clearInterval(heartbeat);
                    }
                }, heartbeatInterval);

                req.signal.addEventListener("abort", () => {
                    manager.removeLogListener(logListener);
                    clearInterval(heartbeat);
                    try {
                        controller.close();
                    } catch { /* already closed */ }
                });
            }
        });
        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        });
    }

    // DELETE /api/state - Delete loop state
    if (url.pathname === "/api/state" && req.method === "DELETE") {
        try {
            if (existsSync(STATE_PATH)) {
                unlinkSync(STATE_PATH);
                return Response.json({ success: true, deleted: true });
            }
            return Response.json({ success: true, deleted: false });
        } catch (e) {
            return Response.json({ error: String(e) }, { status: 500 });
        }
    }

    // Default 404
    return new Response("Not Found", { status: 404 });
};

// --- Server ---

serve({
    port: PORT,
    hostname: HOST,
    async fetch(req) {
        const url = new URL(req.url);

        // Handle CORS Preflight
        if (req.method === "OPTIONS" && CORS_ORIGIN) {
            return new Response(null, {
                headers: {
                    "Access-Control-Allow-Origin": CORS_ORIGIN,
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, DELETE",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                }
            });
        }

        // Favicon
        if (url.pathname === "/favicon.ico") {
            const faviconPath = join(WEB_ROOT, "favicon.ico");
            if (existsSync(faviconPath)) return new Response(file(faviconPath));
            return new Response(null, { status: 204 });
        }
        
        // API Routes
        if (url.pathname.startsWith("/api/")) {
            // Token Auth
            if (TOKEN) {
                const authHeader = req.headers.get("Authorization");
                if (authHeader !== `Bearer ${TOKEN}`) {
                    return new Response(JSON.stringify({ error: "Unauthorized" }), { 
                        status: 401,
                        headers: { "Content-Type": "application/json" }
                    });
                }
            }

            const response = await handleApiRequest(req, url);
            // Add CORS headers to API responses
            if (CORS_ORIGIN) {
                response.headers.set("Access-Control-Allow-Origin", CORS_ORIGIN);
            }
            return response;
        }

        // Static Files
        let path = url.pathname === "/" ? "/index.html" : url.pathname;
        let filePath = join(WEB_ROOT, path);
        
        // Fallback to mocks
        if (!existsSync(filePath)) {
             const mockPath = join(WEB_ROOT, "mocks", path);
             if (existsSync(mockPath)) {
                 filePath = mockPath;
             }
        }

        const f = file(filePath);
        if (await f.exists()) {
            return new Response(f);
        }

        return new Response("Not Found", { status: 404 });
    }
});
