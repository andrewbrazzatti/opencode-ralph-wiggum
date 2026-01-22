import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { spawn } from "bun";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const PORT_LOCAL = 46000;
const PORT_REMOTE = 46001;
const DIR_LOCAL = join(process.cwd(), "temp_integration_local");
const DIR_REMOTE = join(process.cwd(), "temp_integration_remote");

describe("Remote Integration", () => {
    let localProc: any;
    let remoteProc: any;

    beforeAll(async () => {
        mkdirSync(DIR_LOCAL, { recursive: true });
        mkdirSync(DIR_REMOTE, { recursive: true });

        // Dummy ralph for remote
        const dummyRalph = join(DIR_REMOTE, "ralph.sh");
        writeFileSync(dummyRalph, "#!/bin/sh\necho \"Iteration 1\"\nsleep 10\n", { mode: 0o755 });

        const serverPath = join(process.cwd(), "src/server.ts");

        // Spawn Remote
        remoteProc = spawn([process.execPath, "run", serverPath, "--port", String(PORT_REMOTE)], {
            cwd: DIR_REMOTE,
            env: { ...process.env, PORT: String(PORT_REMOTE), RALPH_CLI_PATH: dummyRalph }
        });

        // Wait for remote
        for (let i = 0; i < 20; i++) {
            try {
                const res = await fetch(`http://localhost:${PORT_REMOTE}/api/status`);
                if (res.ok) break;
            } catch (e) {}
            await new Promise(r => setTimeout(r, 200));
        }

        // Spawn Local
        localProc = spawn([process.execPath, "run", serverPath, "--port", String(PORT_LOCAL)], {
            cwd: DIR_LOCAL,
            env: { ...process.env, PORT: String(PORT_LOCAL) }
        });

        // Wait for local
        for (let i = 0; i < 20; i++) {
            try {
                const res = await fetch(`http://localhost:${PORT_LOCAL}/api/status`);
                if (res.ok) break;
            } catch (e) {}
            await new Promise(r => setTimeout(r, 200));
        }
    });

    afterAll(() => {
        if (localProc) localProc.kill();
        if (remoteProc) remoteProc.kill();
        rmSync(DIR_LOCAL, { recursive: true, force: true });
        rmSync(DIR_REMOTE, { recursive: true, force: true });
    });

    test("should proxy run lifecycle to remote target", async () => {
        // 1. Add remote target to local
        const addRes = await fetch(`http://localhost:${PORT_LOCAL}/api/targets`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                name: "My Remote",
                baseUrl: `http://localhost:${PORT_REMOTE}`
            })
        });
        const target = await addRes.json();
        const targetId = target.id;

        // 2. Start run on remote via local proxy
        const startRes = await fetch(`http://localhost:${PORT_LOCAL}/api/targets/${targetId}/runs`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: "proxy test" })
        });
        expect(startRes.status).toBe(202);
        const { runId } = await startRes.json();

        // 3. Check status on remote via local proxy
        const statusRes = await fetch(`http://localhost:${PORT_LOCAL}/api/targets/${targetId}/runs/${runId}`);
        expect(statusRes.status).toBe(200);
        const statusData = await statusRes.json();
        expect(statusData.status).toBe("active");

        // 4. Stream logs from remote via local proxy (SSE)
        const streamRes = await fetch(`http://localhost:${PORT_LOCAL}/api/targets/${targetId}/runs/${runId}/stream`);
        expect(streamRes.status).toBe(200);
        expect(streamRes.headers.get("Content-Type")).toBe("text/event-stream");
        
        const reader = streamRes.body?.getReader();
        const { value } = await reader!.read();
        const text = new TextDecoder().decode(value);
        expect(text).toContain("event: state");
        reader!.releaseLock();

        // 5. Stop run on remote via local proxy
        const stopRes = await fetch(`http://localhost:${PORT_LOCAL}/api/targets/${targetId}/runs/${runId}/stop`, {
            method: "POST"
        });
        expect(stopRes.status).toBe(200);
    });
});
