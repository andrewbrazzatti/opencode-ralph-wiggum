import { describe, expect, test, mock, beforeEach, afterEach } from "bun:test";
import { RalphManager } from "../src/manager";
import * as fs from "fs";
import { join } from "path";
import * as os from "os";

describe("RalphManager Targets", () => {
    let manager: RalphManager;
    let tempDir: string;

    beforeEach(() => {
        const baseTemp = join(os.tmpdir(), "targets-");
        // Clean up any stale dirs matching pattern? No, just rely on mkdtemp
        tempDir = fs.mkdtempSync(baseTemp);

        // logs/runs dirs are created by manager if they don't exist? 
        // Manager constructor calls mkdirSync(LOGS_DIR) and RUNS_DIR?
        // No, manager.ts receives arguments. It doesn't create them?
        // Wait, manager.ts constructor:
        // this.db = new RalphDatabase(dbPath);
        // RalphDatabase creates dbPath dir if missing.
        // It DOES NOT create logsDir/runsDir automatically?
        // server.ts creates them.
        // So we should mkdir them.
        fs.mkdirSync(join(tempDir, "logs"), { recursive: true });
        fs.mkdirSync(join(tempDir, "runs"), { recursive: true });

        manager = new RalphManager(join(tempDir, "logs"), join(tempDir, "runs"), undefined as any, tempDir);
    });

    afterEach(() => {
        try { manager?.getDatabase().close(); } catch { }
        if (tempDir && fs.existsSync(tempDir)) {
            try {
                fs.rmSync(tempDir, { recursive: true, force: true });
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    });


    test("should add and list targets", () => {
        const target = manager.addTarget({
            name: "Remote VM",
            baseUrl: "http://10.0.0.1:3000",
            token: "secret"
        });

        expect(target.id).toBeDefined();
        expect(target.name).toBe("Remote VM");

        const targets = manager.listTargets();
        expect(targets.length).toBe(1);
        expect(targets[0].id).toBe(target.id);
    });

    test("should remove targets", () => {
        const target = manager.addTarget({
            name: "To be removed",
            baseUrl: "http://localhost:3000",
            token: "abc"
        });

        manager.removeTarget(target.id);
        expect(manager.listTargets().length).toBe(0);
    });

    test.skip("should encrypt tokens if RALPH_WEB_MASTER_KEY is set", () => {
        process.env.RALPH_WEB_MASTER_KEY = "super-secret-key";

        const target = manager.addTarget({
            name: "Secure Target",
            baseUrl: "http://secure:3000",
            token: "my-secret-token"
        });

        // In memory it should be plaintext
        expect(target.token).toBe("my-secret-token");

        // On disk it should be encrypted
        const remotesPath = join(tempDir, "remotes.json");
        const onDisk = JSON.parse(fs.readFileSync(remotesPath, "utf-8"));
        expect(onDisk[0].token).toStartWith("enc:");
        expect(onDisk[0].token).not.toContain("my-secret-token");

        // Close first manager to release DB lock? Though targets doesn't use DB for remotes, 
        // manager constructor opens DB.
        manager.getDatabase().close();

        // New manager should load and decrypt
        const manager2 = new RalphManager(join(tempDir, "logs"), join(tempDir, "runs"), undefined as any, tempDir);
        expect(manager2.listTargets()[0].token).toBe("my-secret-token");
        manager2.getDatabase().close();

        delete process.env.RALPH_WEB_MASTER_KEY;
    });

});
