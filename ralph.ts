#!/usr/bin/env bun
/**
 * Ralph Wiggum Loop for OpenCode
 *
 * Implementation of the Ralph Wiggum technique - continuous self-referential
 * AI loops for iterative development. Based on ghuntley.com/ralph/
 */

import { $ } from "bun";
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { QuotaFetcher, type ProviderQuotaData, type ModelQuota } from "./src/quota-fetcher";
import { Database } from "bun:sqlite";

const VERSION = "1.0.10";

// State and context paths
let stateDir = process.env.RALPH_STATE_DIR ? resolve(process.env.RALPH_STATE_DIR) : join(process.cwd(), ".opencode");

// Early scan for --state-dir to override
const stateDirIdx = process.argv.indexOf("--state-dir");
if (stateDirIdx !== -1 && process.argv[stateDirIdx + 1]) {
  stateDir = resolve(process.argv[stateDirIdx + 1]);
}

const statePath = join(stateDir, "ralph-loop.state.json");
const contextPath = join(stateDir, "ralph-context.md");
const historyPath = join(stateDir, "ralph-history.json");

const args = process.argv.slice(2);

let dbPathArg = "";
let runIdArg = "";



function saveState(state: RalphState): void {
  if (dbPathArg && runIdArg) {
      try {
          const db = new Database(dbPathArg);
          db.exec("PRAGMA journal_mode = WAL;"); 
          db.exec("PRAGMA busy_timeout = 5000;"); 

          const stmt = db.prepare("UPDATE runs SET state = $state WHERE id = $id");
          stmt.run({ $state: JSON.stringify(state), $id: runIdArg });
          db.close();
          return;
      } catch (e) {
          console.error("Failed to save state to DB:", e);
          // Fallback to file?
      }
  }

  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function loadState(): RalphState | null {
  if (dbPathArg && runIdArg) {
      try {
          const db = new Database(dbPathArg);
          db.exec("PRAGMA journal_mode = WAL;");
          db.exec("PRAGMA busy_timeout = 5000;");
          
          const stmt = db.prepare("SELECT state FROM runs WHERE id = $id");
          const row = stmt.get({ $id: runIdArg }) as { state: string };
          db.close();
          if (row && row.state) {
              return JSON.parse(row.state);
          }
          return null;
      } catch (e) {
           console.error("Failed to load state from DB:", e);
           // Fallback to file?
      }
  }

  if (!existsSync(statePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(statePath, "utf-8"));
  } catch {
    return null;
  }
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`
Ralph Wiggum Loop - Iterative AI development with OpenCode

Usage:
  ralph "<prompt>" [options]
  ralph --prompt-file <path> [options]

Arguments:
  prompt              Task description for the AI to work on

Options:
  --min-iterations N  Minimum iterations before completion allowed (default: 1)
  --max-iterations N  Maximum iterations before stopping (default: unlimited)
  --completion-promise TEXT  Phrase that signals completion (default: COMPLETE)
  --model MODEL       Model to use (e.g., anthropic/claude-sonnet), or comma-separated list
  --prompt-file, --file, -f  Read prompt content from a file
  --no-stream         Buffer OpenCode output and print at the end
  --verbose-tools     Print every tool line (disable compact tool summary)
  --no-plugins        Disable non-auth OpenCode plugins for this run
  --no-commit         Don't auto-commit after each iteration
  --docker-image IMG  Run opencode in a docker container using image IMG
  --docker-args ARGS  Additional arguments for docker run (e.g. "-v /mnt:/mnt")
  --devcontainer-service SVC  Run opencode in devcontainer service SVC
  --allow-all         Auto-approve all tool permissions (for non-interactive use)
  --state-dir PATH    Directory for state and context (default: .opencode)
  --load-config PATH  Load run configuration from a JSON file
  --version, -v       Show version
  --help, -h          Show this help

Commands:
  --status            Show current Ralph loop status and history
  --add-context TEXT  Add context for the next iteration (or edit ralph-context.md in state dir)
  --clear-context     Clear any pending context

Examples:
  ralph "Build a REST API for todos"
  ralph "Fix the auth bug" --max-iterations 10
  ralph "Add tests" --completion-promise "ALL TESTS PASS" --model openai/gpt-5.1
  ralph --prompt-file ./prompt.md --max-iterations 5
  ralph --status                                        # Check loop status
  ralph --add-context "Focus on the auth module first"  # Add hint for next iteration

How it works:
  1. Sends your prompt to OpenCode
  2. AI works on the task
  3. Checks output for completion promise
  4. If not complete, repeats with same prompt
  5. AI sees its previous work in files
  6. Continues until promise detected or max iterations

To stop manually: Ctrl+C

Learn more: https://ghuntley.com/ralph/
`);
  process.exit(0);
}

if (args.includes("--version") || args.includes("-v")) {
  console.log(`ralph ${VERSION}`);
  process.exit(0);
}

// History tracking interface
interface IterationHistory {
  iteration: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
  toolsUsed: Record<string, number>;
  filesModified: string[];
  exitCode: number;
  completionDetected: boolean;
  errors: string[];
}

interface RalphHistory {
  iterations: IterationHistory[];
  totalDurationMs: number;
  struggleIndicators: {
    repeatedErrors: Record<string, number>;
    noProgressIterations: number;
    shortIterations: number;
  };
}

// Load history
function loadHistory(): RalphHistory {
  if (!existsSync(historyPath)) {
    return {
      iterations: [],
      totalDurationMs: 0,
      struggleIndicators: { repeatedErrors: {}, noProgressIterations: 0, shortIterations: 0 }
    };
  }
  try {
    return JSON.parse(readFileSync(historyPath, "utf-8"));
  } catch {
    return {
      iterations: [],
      totalDurationMs: 0,
      struggleIndicators: { repeatedErrors: {}, noProgressIterations: 0, shortIterations: 0 }
    };
  }
}

function saveHistory(history: RalphHistory): void {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  writeFileSync(historyPath, JSON.stringify(history, null, 2));
}

function clearHistory(): void {
  if (existsSync(historyPath)) {
    try {
      require("fs").unlinkSync(historyPath);
    } catch {}
  }
}

// Status command
if (args.includes("--status")) {
  const state = loadState();
  const history = loadHistory();
  const context = existsSync(contextPath) ? readFileSync(contextPath, "utf-8").trim() : null;

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    Ralph Wiggum Status                           ║
╚══════════════════════════════════════════════════════════════════╝
`);

  if (state?.active) {
    const elapsed = Date.now() - new Date(state.startedAt).getTime();
    const elapsedStr = formatDurationLong(elapsed);
    console.log(`🔄 ACTIVE LOOP`);
    console.log(`   Iteration:    ${state.iteration}${state.maxIterations > 0 ? ` / ${state.maxIterations}` : " (unlimited)"}`);
    console.log(`   Started:      ${state.startedAt}`);
    console.log(`   Elapsed:      ${elapsedStr}`);
    console.log(`   Promise:      ${state.completionPromise}`);
    if (state.model) {
      console.log(`   Model:        ${state.model} ${state.modelQueue && state.modelQueue.length > 1 ? `(Model ${state.currentModelIndex + 1}/${state.modelQueue.length} in queue)` : ""}`);
    }
    console.log(`   Prompt:       ${state.prompt.substring(0, 60)}${state.prompt.length > 60 ? "..." : ""}`);
  } else {
    console.log(`⏹️  No active loop`);
  }

  if (context) {
    console.log(`\n📝 PENDING CONTEXT (will be injected next iteration):`);
    console.log(`   ${context.split("\n").join("\n   ")}`);
  }

  if (history.iterations.length > 0) {
    console.log(`\n📊 HISTORY (${history.iterations.length} iterations)`);
    console.log(`   Total time:   ${formatDurationLong(history.totalDurationMs)}`);

    // Show last 5 iterations
    const recent = history.iterations.slice(-5);
    console.log(`\n   Recent iterations:`);
    for (const iter of recent) {
      const tools = Object.entries(iter.toolsUsed)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, v]) => `${k}:${v}`)
        .join(" ");
      const status = iter.completionDetected ? "✅" : iter.exitCode !== 0 ? "❌" : "🔄";
      console.log(`   ${status} #${iter.iteration}: ${formatDurationLong(iter.durationMs)} | ${tools || "no tools"}`);
    }

    // Struggle detection
    const struggle = history.struggleIndicators;
    const hasRepeatedErrors = Object.values(struggle.repeatedErrors).some(count => count >= 2);
    if (struggle.noProgressIterations >= 3 || struggle.shortIterations >= 3 || hasRepeatedErrors) {
      console.log(`\n⚠️  STRUGGLE INDICATORS:`);
      if (struggle.noProgressIterations >= 3) {
        console.log(`   - No file changes in ${struggle.noProgressIterations} iterations`);
      }
      if (struggle.shortIterations >= 3) {
        console.log(`   - ${struggle.shortIterations} very short iterations (< 30s)`);
      }
      const topErrors = Object.entries(struggle.repeatedErrors)
        .filter(([_, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      for (const [error, count] of topErrors) {
        console.log(`   - Same error ${count}x: "${error.substring(0, 50)}..."`);
      }
      console.log(`\n   💡 Consider using: ralph --add-context "your hint here"`);
    }
  }

  console.log("");
  process.exit(0);
}

// Add context command
const addContextIdx = args.indexOf("--add-context");
if (addContextIdx !== -1) {
  const contextText = args[addContextIdx + 1];
  if (!contextText) {
    console.error("Error: --add-context requires a text argument");
    console.error("Usage: ralph --add-context \"Your context or hint here\"");
    process.exit(1);
  }

  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }

  // Append to existing context or create new
  const timestamp = new Date().toISOString();
  const newEntry = `\n## Context added at ${timestamp}\n${contextText}\n`;

  if (existsSync(contextPath)) {
    const existing = readFileSync(contextPath, "utf-8");
    writeFileSync(contextPath, existing + newEntry);
  } else {
    writeFileSync(contextPath, `# Ralph Loop Context\n${newEntry}`);
  }

  console.log(`✅ Context added for next iteration`);
  console.log(`   File: ${contextPath}`);

  const state = loadState();
  if (state?.active) {
    console.log(`   Will be picked up in iteration ${state.iteration + 1}`);
  } else {
    console.log(`   Will be used when loop starts`);
  }
  process.exit(0);
}

// Clear context command
if (args.includes("--clear-context")) {
  if (existsSync(contextPath)) {
    require("fs").unlinkSync(contextPath);
    console.log(`✅ Context cleared`);
  } else {
    console.log(`ℹ️  No pending context to clear`);
  }
  process.exit(0);
}

function formatDurationLong(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

// Parse options
let prompt = "";
let minIterations = 1; // default: 1 iteration minimum
let maxIterations = 0; // 0 = unlimited
let completionPromise = "COMPLETE";
let model = "";
let autoCommit = true;
let disablePlugins = false;
let allowAllPermissions = false;
let promptFile = "";
let streamOutput = true;
let verboseTools = false;
let promptSource = "";
let dockerImage = "";
let dockerArgs: string[] = [];
let devcontainerService = "";
let currentProc: ReturnType<typeof Bun.spawn> | null = null;
let containerName = "";
let loadConfigPath = "";

const promptParts: string[] = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];

  if (arg === "--min-iterations") {
    const val = args[++i];
    if (!val || isNaN(parseInt(val))) {
      console.error("Error: --min-iterations requires a number");
      process.exit(1);
    }
    minIterations = parseInt(val);
  } else if (arg === "--max-iterations") {
    const val = args[++i];
    if (!val || isNaN(parseInt(val))) {
      console.error("Error: --max-iterations requires a number");
      process.exit(1);
    }
    maxIterations = parseInt(val);
  } else if (arg === "--completion-promise") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --completion-promise requires a value");
      process.exit(1);
    }
    completionPromise = val;
  } else if (arg === "--model") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --model requires a value");
      process.exit(1);
    }
    // Allow comma-separated list of models
    model = val; // Keep original string for display/logging if needed, or primarily use the queue
  } else if (arg === "--prompt-file" || arg === "--file" || arg === "-f") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --prompt-file requires a file path");
      process.exit(1);
    }
    promptFile = val;
  } else if (arg === "--no-stream") {
    streamOutput = false;
  } else if (arg === "--stream") {
    streamOutput = true;
  } else if (arg === "--verbose-tools") {
    verboseTools = true;
  } else if (arg === "--no-commit") {
    autoCommit = false;
  } else if (arg === "--no-plugins") {
    disablePlugins = true;
  } else if (arg === "--allow-all") {
    allowAllPermissions = true;
  } else if (arg === "--state-dir") {
    i++; // Skip value, handled at startup
  } else if (arg === "--load-config") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --load-config requires a file path");
      process.exit(1);
    }
    loadConfigPath = val;
  } else if (arg === "--docker-image") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --docker-image requires an image name");
      process.exit(1);
    }
    dockerImage = val;
  } else if (arg === "--docker-args") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --docker-args requires a value");
      process.exit(1);
    }
    // Simple split by space, respecting quotes would be better but keeping it simple for now
    // Users can pass multiple --docker-args if needed or we can accept simple string
    // Let's rely on simple split for now, or allow multiple flags? 
    // Let's assume one string with spaces. 
    // Matches sequences of non-whitespace OR quoted strings
    const matches = val.match(/(?:[^\s"]+|"[^"]*")+/g);
    if (matches) {
      dockerArgs.push(...matches.map(s => s.replace(/^"|"$/g, "")));
    }
  } else if (arg === "--devcontainer-service") {
    const val = args[++i];
    if (!val) {
      console.error("Error: --devcontainer-service requires a service name");
      process.exit(1);
    }
    devcontainerService = val;
  } else if (arg === "--db-path") {
    const val = args[++i];
    if (!val) {
        console.error("Error: --db-path requires a value");
        process.exit(1);
    }
    dbPathArg = val;
  } else if (arg === "--run-id") {
    const val = args[++i];
    if (!val) {
        console.error("Error: --run-id requires a value");
        process.exit(1);
    }
    runIdArg = val;
  } else if (arg.startsWith("-")) {
    console.error(`Error: Unknown option: ${arg}`);
    console.error("Run 'ralph --help' for available options");
    process.exit(1);
  } else {
    promptParts.push(arg);
  }
}

function readPromptFile(path: string): string {
  if (!existsSync(path)) {
    console.error(`Error: Prompt file not found: ${path}`);
    process.exit(1);
  }
  try {
    const stat = statSync(path);
    if (!stat.isFile()) {
      console.error(`Error: Prompt path is not a file: ${path}`);
      process.exit(1);
    }
  } catch {
    console.error(`Error: Unable to stat prompt file: ${path}`);
    process.exit(1);
  }
  try {
    const content = readFileSync(path, "utf-8");
    if (!content.trim()) {
      console.error(`Error: Prompt file is empty: ${path}`);
      process.exit(1);
    }
    return content;
  } catch {
    console.error(`Error: Unable to read prompt file: ${path}`);
    process.exit(1);
  }
}

// Load config if requested
if (loadConfigPath) {
  if (!existsSync(loadConfigPath)) {
    console.error(`Error: Config file not found: ${loadConfigPath}`);
    process.exit(1);
  }
  try {
    const config = JSON.parse(readFileSync(loadConfigPath, "utf-8"));
    if (config.run) {
      const r = config.run;
      if (r.prompt) prompt = r.prompt;
      if (r.modelQueue) model = r.modelQueue.join(",");
      if (r.minIterations !== undefined) minIterations = r.minIterations;
      if (r.maxIterations !== undefined) maxIterations = r.maxIterations;
      if (r.completionPromise) completionPromise = r.completionPromise;
      if (r.mode === "docker" && r.docker) {
        dockerImage = r.docker.image || dockerImage;
        if (r.docker.args) {
           const matches = r.docker.args.match(/(?:[^\s"]+|"[^"]*")+/g);
           if (matches) {
             dockerArgs.push(...matches.map((s: string) => s.replace(/^"|"$/g, "")));
           }
        }
      } else if (r.mode === "devcontainer" && r.devcontainer) {
        devcontainerService = r.devcontainer.service || devcontainerService;
      }
      
      if (r.flags) {
        if (r.flags.noCommit !== undefined) autoCommit = !r.flags.noCommit;
        if (r.flags.verboseTools !== undefined) verboseTools = r.flags.verboseTools;
        if (r.flags.noPlugins !== undefined) disablePlugins = r.flags.noPlugins;
        if (r.flags.allowAll !== undefined) allowAllPermissions = r.flags.allowAll;
        if (r.flags.noStream !== undefined) streamOutput = !r.flags.noStream;
      }
    }
  } catch (e) {
    console.error(`Error: Failed to parse config file: ${loadConfigPath}`);
    process.exit(1);
  }
}

if (promptFile) {
  promptSource = promptFile;
  prompt = readPromptFile(promptFile);
} else if (promptParts.length === 1 && existsSync(promptParts[0])) {
  promptSource = promptParts[0];
  prompt = readPromptFile(promptParts[0]);
} else {
  prompt = promptParts.join(" ");
}

if (!prompt) {
  console.error("Error: No prompt provided");
  console.error("Usage: ralph \"Your task description\" [options]");
  console.error("Run 'ralph --help' for more information");
  process.exit(1);
}

// Validate min/max iterations
if (maxIterations > 0 && minIterations > maxIterations) {
  console.error(`Error: --min-iterations (${minIterations}) cannot be greater than --max-iterations (${maxIterations})`);
  process.exit(1);
}

interface RalphState {
  active: boolean;
  iteration: number;
  minIterations: number;
  maxIterations: number;
  completionPromise: string;
  prompt: string;
  startedAt: string;
  model: string;
  modelQueue: string[];     // NEW: List of models to try in priority order
  currentModelIndex: number; // NEW: Index of current model in queue
}

// Create or update state


function clearState(): void {
  if (existsSync(statePath)) {
    try {
      require("fs").unlinkSync(statePath);
    } catch {}
  }
}

function loadPluginsFromConfig(configPath: string): string[] {
  if (!existsSync(configPath)) {
    return [];
  }
  try {
    const raw = readFileSync(configPath, "utf-8");
    // Basic JSONC support: strip // and /* */ comments.
    const withoutBlock = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const withoutLine = withoutBlock.replace(/^\s*\/\/.*$/gm, "");
    const parsed = JSON.parse(withoutLine);
    const plugins = parsed?.plugin;
    return Array.isArray(plugins) ? plugins.filter(p => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function ensureRalphConfig(options: { filterPlugins?: boolean; allowAllPermissions?: boolean }): string {
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true });
  }
  const configPath = join(stateDir, "ralph-opencode.config.json");
  const userConfigPath = join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config"), "opencode", "opencode.json");
  const projectConfigPath = join(process.cwd(), ".opencode", "opencode.json");

  const config: Record<string, unknown> = {
    $schema: "https://opencode.ai/config.json",
  };

  // Filter plugins if requested (only keep auth plugins)
  if (options.filterPlugins) {
    const plugins = [
      ...loadPluginsFromConfig(userConfigPath),
      ...loadPluginsFromConfig(projectConfigPath),
    ];
    config.plugin = Array.from(new Set(plugins)).filter(p => /auth/i.test(p));
  }

  // Auto-allow all permissions for non-interactive use
  if (options.allowAllPermissions) {
    config.permission = {
      read: "allow",
      edit: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      bash: "allow",
      task: "allow",
      webfetch: "allow",
      websearch: "allow",
      codesearch: "allow",
      todowrite: "allow",
      todoread: "allow",
      question: "allow",
      lsp: "allow",
      external_directory: "allow",
    };
  }

  writeFileSync(configPath, JSON.stringify(config, null, 2));
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

// --- Quota Management ---

async function checkAndSortModels(models: string[]): Promise<string[]> {
  console.log("Checking model quotas...");
  const fetcher = new QuotaFetcher();
  const quotas = await fetcher.fetchAll();
  
  const validModels: string[] = [];
  const lowQuotaModels: string[] = [];

  for (const model of models) {
    const [provider, modelName] = model.split("/");
    const p = provider.toLowerCase();
    
    let hasQuota = true; // Default to true if no quota info found
    let percentage = 100;

    if (quotas[p]) {
      const q = quotas[p];
      if (q.isForbidden) {
        hasQuota = false;
        percentage = 0;
      } else {
        // Provider specific logic
        if (p === "openai" || p === "codex") {
           // Check session quota
           const session = q.models.find(m => m.name.includes("session"));
           if (session) {
             percentage = session.percentage;
           }
        } else if (p === "google") {
           // Fuzzy match model name
           // CLI: gemini-3-pro -> Quota: gemini-3-pro-high
           // Need to handle modelName being potentially empty or simple
           if (modelName) {
               const match = q.models.find(m => m.name.includes(modelName) || modelName.includes(m.name));
               if (match) {
                 percentage = match.percentage;
               }
           }
        }
        
        if (percentage < 10) hasQuota = false;
      }
    }

    if (hasQuota) {
      validModels.push(model);
    } else {
      console.warn(`⚠️  Skipping model ${model} due to low/exhausted quota (${percentage.toFixed(1)}%)`);
      lowQuotaModels.push(model);
    }
  }
  
  if (validModels.length === 0) {
    console.warn("⚠️  All requested models have low quota! Falling back to original list.");
    return models;
  }
  
  return validModels;
}

// Provider Configuration for Fallback
interface ProviderErrorConfig {
  pattern: string;
}

interface ProviderConfig {
  [providerName: string]: ProviderErrorConfig;
}

function loadProviderConfig(stateDir: string): ProviderConfig {
  const defaults: ProviderConfig = {
    anthropic: { pattern: "overloaded_error|rate_limit_error|429" },
    openai: { pattern: "rate_limit_exceeded|insufficient_quota|429" },
    google: { pattern: "All Antigravity endpoints failed" },
    mistral: { pattern: "rate_limit_exceeded|429" },
  };

  const userConfigPath = join(stateDir, "ralph-providers.json");
  if (existsSync(userConfigPath)) {
    try {
      const userConfig = JSON.parse(readFileSync(userConfigPath, "utf-8"));
      // Deep merge or just shallow merge? Shallow merge of providers is likely enough.
      return { ...defaults, ...userConfig };
    } catch (e) {
      console.warn("⚠️  Failed to parse ralph-providers.json, using defaults");
    }
  }
  return defaults;
}

// Build the full prompt with iteration context
function loadContext(): string | null {
  if (!existsSync(contextPath)) {
    return null;
  }
  try {
    const content = readFileSync(contextPath, "utf-8").trim();
    return content || null;
  } catch {
    return null;
  }
}

function clearContext(): void {
  if (existsSync(contextPath)) {
    try {
      require("fs").unlinkSync(contextPath);
    } catch {}
  }
}

function buildPrompt(state: RalphState): string {
  const context = loadContext();
  const contextSection = context
    ? `
## Additional Context (added by user mid-loop)

${context}

---
`
    : "";

  return `
# Ralph Wiggum Loop - Iteration ${state.iteration}

You are in an iterative development loop. Work on the task below until you can genuinely complete it.
${contextSection}
## Your Task

${state.prompt}

## Instructions

1. Read the current state of files to understand what's been done
2. **Update your todo list** - Use the TodoWrite tool to track progress and plan remaining work
3. Make progress on the task
4. Run tests/verification if applicable
5. When the task is GENUINELY COMPLETE, output:
   <promise>${state.completionPromise}</promise>

## Critical Rules

- ONLY output <promise>${state.completionPromise}</promise> when the task is truly done
- Do NOT lie or output false promises to exit the loop
- If stuck, try a different approach
- Check your work before claiming completion
- The loop will continue until you succeed
- **IMPORTANT**: Update your todo list at the start of each iteration to show progress

## Current Iteration: ${state.iteration}${state.maxIterations > 0 ? ` / ${state.maxIterations}` : " (unlimited)"} (min: ${state.minIterations ?? 1})

Now, work on the task. Good luck!
`.trim();
}

// Check if output contains the completion promise
function checkCompletion(output: string, promise: string): boolean {
  const promisePattern = new RegExp(`<promise>\\s*${escapeRegex(promise)}\\s*</promise>`, "i");
  return promisePattern.test(output);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectPlaceholderPluginError(output: string): boolean {
  return output.includes("ralph-wiggum is not yet ready for use. This is a placeholder package.");
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B\[[0-9;]*m/g, "");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatToolSummary(toolCounts: Map<string, number>, maxItems = 6): string {
  if (!toolCounts.size) return "";
  const entries = Array.from(toolCounts.entries()).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, maxItems);
  const remaining = entries.length - shown.length;
  const parts = shown.map(([name, count]) => `${name} ${count}`);
  if (remaining > 0) {
    parts.push(`+${remaining} more`);
  }
  return parts.join(" • ");
}

function collectToolSummaryFromText(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const match = stripAnsi(line).match(/^\|\s{2}([A-Za-z0-9_-]+)/);
    if (match) {
      const tool = match[1];
      counts.set(tool, (counts.get(tool) ?? 0) + 1);
    }
  }
  return counts;
}

function printIterationSummary(params: {
  iteration: number;
  elapsedMs: number;
  toolCounts: Map<string, number>;
  exitCode: number;
  completionDetected: boolean;
}): void {
  const toolSummary = formatToolSummary(params.toolCounts);
  console.log("\nIteration Summary");
  console.log("────────────────────────────────────────────────────────────────────");
  console.log(`Iteration: ${params.iteration}`);
  console.log(`Elapsed:   ${formatDuration(params.elapsedMs)}`);
  if (toolSummary) {
    console.log(`Tools:     ${toolSummary}`);
  } else {
    console.log("Tools:     none");
  }
  console.log(`Exit code: ${params.exitCode}`);
  console.log(`Completion promise: ${params.completionDetected ? "detected" : "not detected"}`);
}

async function streamProcessOutput(
  proc: ReturnType<typeof Bun.spawn>,
  options: {
    compactTools: boolean;
    toolSummaryIntervalMs: number;
    heartbeatIntervalMs: number;
    iterationStart: number;
  },
): Promise<{ stdoutText: string; stderrText: string; toolCounts: Map<string, number> }> {
  console.log("DEBUG: streamProcessOutput starting...");
  const toolCounts = new Map<string, number>();
  let stdoutText = "";
  let stderrText = "";
  let lastPrintedAt = Date.now();
  let lastActivityAt = Date.now();
  let lastToolSummaryAt = 0;

  const compactTools = options.compactTools;

  const maybePrintToolSummary = (force = false) => {
    if (!compactTools || toolCounts.size === 0) return;
    const now = Date.now();
    if (!force && now - lastToolSummaryAt < options.toolSummaryIntervalMs) {
      return;
    }
    const summary = formatToolSummary(toolCounts);
    if (summary) {
      console.log(`| Tools    ${summary}`);
      lastPrintedAt = Date.now();
      lastToolSummaryAt = Date.now();
    }
  };

  const handleLine = (line: string, isError: boolean) => {
    lastActivityAt = Date.now();
    const match = stripAnsi(line).match(/^\|\s{2}([A-Za-z0-9_-]+)/);
    if (compactTools && match) {
      const tool = match[1];
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
      maybePrintToolSummary();
      return;
    }
    if (line.length === 0) {
      console.log("");
      lastPrintedAt = Date.now();
      return;
    }
    if (isError) {
      console.error(line);
    } else {
      console.log(line);
    }
    lastPrintedAt = Date.now();
  };

  const streamText = async (
    stream: ReadableStream<Uint8Array> | null,
    onText: (chunk: string) => void,
    isError: boolean,
  ) => {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) {
        onText(text);
        buffer += text;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          handleLine(line, isError);
        }
      }
    }
    const flushed = decoder.decode();
    if (flushed.length > 0) {
      onText(flushed);
      buffer += flushed;
    }
    if (buffer.length > 0) {
      handleLine(buffer, isError);
    }
  };

  const heartbeatTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastPrintedAt >= options.heartbeatIntervalMs) {
      const elapsed = formatDuration(now - options.iterationStart);
      const sinceActivity = formatDuration(now - lastActivityAt);
      console.log(`⏳ working... elapsed ${elapsed} · last activity ${sinceActivity} ago`);
      lastPrintedAt = now;
    }
  }, options.heartbeatIntervalMs);

  try {
    await Promise.all([
      streamText(
        proc.stdout as any,
        chunk => {
          stdoutText += chunk;
        },
        false,
      ),
      streamText(
        proc.stderr as any,
        chunk => {
          stderrText += chunk;
        },
        true,
      ),
    ]);
  } finally {
    clearInterval(heartbeatTimer);
  }

  if (compactTools) {
    maybePrintToolSummary(true);
  }

  return { stdoutText, stderrText, toolCounts };
}
// Main loop
// Helper to detect per-iteration file changes using content hashes
// Works correctly with --no-commit by comparing file content hashes

interface FileSnapshot {
  files: Map<string, string>; // filename -> hash/mtime
}

async function captureFileSnapshot(): Promise<FileSnapshot> {
  const files = new Map<string, string>();
  try {
    // Get list of all tracked and modified files
    const status = await $`git status --porcelain`.text();
    const trackedFiles = await $`git ls-files`.text();

    // Combine modified and tracked files
    const allFiles = new Set<string>();
    for (const line of status.split("\n")) {
      if (line.trim()) {
        allFiles.add(line.substring(3).trim());
      }
    }
    for (const file of trackedFiles.split("\n")) {
      if (file.trim()) {
        allFiles.add(file.trim());
      }
    }

    // Get hash for each file (using git hash-object for content comparison)
    for (const file of allFiles) {
      try {
        const hash = await $`git hash-object ${file} 2>/dev/null || stat -f '%m' ${file} 2>/dev/null || echo ''`.text();
        files.set(file, hash.trim());
      } catch {
        // File may not exist, skip
      }
    }
  } catch {
    // Git not available or error
  }
  return { files };
}

function getModifiedFilesSinceSnapshot(before: FileSnapshot, after: FileSnapshot): string[] {
  const changedFiles: string[] = [];

  // Check for new or modified files
  for (const [file, hash] of after.files) {
    const prevHash = before.files.get(file);
    if (prevHash !== hash) {
      changedFiles.push(file);
    }
  }

  // Check for deleted files
  for (const [file] of before.files) {
    if (!after.files.has(file)) {
      changedFiles.push(file);
    }
  }

  return changedFiles;
}

// Helper to extract error patterns from output
function extractErrors(output: string): string[] {
  const errors: string[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const lower = line.toLowerCase();
    // Match common error patterns
    if (
      lower.includes("error:") ||
      lower.includes("failed:") ||
      lower.includes("exception:") ||
      lower.includes("typeerror") ||
      lower.includes("syntaxerror") ||
      lower.includes("referenceerror") ||
      (lower.includes("test") && lower.includes("fail"))
    ) {
      const cleaned = line.trim().substring(0, 200);
      if (cleaned && !errors.includes(cleaned)) {
        errors.push(cleaned);
      }
    }
  }

  return errors.slice(0, 10); // Cap at 10 errors per iteration
}

async function runRalphLoop(): Promise<void> {
  // Check if a loop is already running
  const existingState = loadState();
  if (existingState?.active) {
    console.error(`Error: A Ralph loop is already active (iteration ${existingState.iteration})`);
    console.error(`Started at: ${existingState.startedAt}`);
    console.error(`To cancel it, press Ctrl+C in its terminal or delete ${statePath}`);
    process.exit(1);
  }

  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║                    Ralph Wiggum Loop                            ║
║            Iterative AI Development with OpenCode                ║
╚══════════════════════════════════════════════════════════════════╝
`);

  // Check quotas if needed
  let initialQueue = model ? model.split(',') : [];
  if (initialQueue.length > 0) {
      try {
        initialQueue = await checkAndSortModels(initialQueue);
      } catch (e) {
        console.warn("⚠️  Failed to check quotas, proceeding with original list:", e);
      }
  }
  const initialModel = initialQueue.length > 0 ? initialQueue[0] : (model ? model.split(',')[0] : "");

  // Initialize state
  const state: RalphState = {
    active: true,
    iteration: 1,
    minIterations,
    maxIterations,
    completionPromise,
    prompt,
    startedAt: new Date().toISOString(),
    model: initialModel, 
    modelQueue: initialQueue,
    currentModelIndex: 0,
  };

  saveState(state);

  // Initialize history tracking
  const history: RalphHistory = {
    iterations: [],
    totalDurationMs: 0,
    struggleIndicators: { repeatedErrors: {}, noProgressIterations: 0, shortIterations: 0 }
  };
  saveHistory(history);

  const promptPreview = prompt.replace(/\s+/g, " ").substring(0, 80) + (prompt.length > 80 ? "..." : "");
  if (promptSource) {
    console.log(`Task: ${promptSource}`);
    console.log(`Preview: ${promptPreview}`);
  } else {
    console.log(`Task: ${promptPreview}`);
  }
  console.log(`Completion promise: ${completionPromise}`);
  console.log(`Min iterations: ${minIterations}`);
  console.log(`Max iterations: ${maxIterations > 0 ? maxIterations : "unlimited"}`);
  if (model) console.log(`Model: ${model}`);
  if (disablePlugins) console.log("OpenCode plugins: non-auth plugins disabled");
  if (allowAllPermissions) console.log("Permissions: auto-approve all tools");
  console.log("");
  console.log("Starting loop... (Ctrl+C to stop)");
  console.log("═".repeat(68));

  // Track current subprocess for cleanup on SIGINT
  let currentProc: ReturnType<typeof Bun.spawn> | null = null;

  // Set up signal handler for graceful shutdown
  let stopping = false;
  process.on("SIGINT", () => {
    if (stopping) {
      console.log("\nForce stopping...");
      process.exit(1);
    }
    stopping = true;
    console.log("\nGracefully stopping Ralph loop...");

    // Kill the subprocess if it's running
    if (currentProc) {
      try {
        currentProc.kill();
      } catch {
        // Process may have already exited
      }
    }

    clearState();
    console.log("Loop cancelled.");
    process.exit(0);
  });

  // Main loop
  while (true) {
    // Reload state from disk to pick up external changes (e.g. from ralph-web)
    const diskState = loadState();
    if (diskState) {
        // Adopt fields that can be changed dynamically
        if (diskState.modelQueue) state.modelQueue = diskState.modelQueue;
        if (diskState.completionPromise) state.completionPromise = diskState.completionPromise;
        if (diskState.maxIterations !== undefined) {
            state.maxIterations = diskState.maxIterations;
            maxIterations = diskState.maxIterations; // Update local var too
        }
        // Ensure currentModelIndex is valid for new queue
        if (state.modelQueue && state.currentModelIndex >= state.modelQueue.length) {
            state.currentModelIndex = Math.max(0, state.modelQueue.length - 1);
        }
    }

    // Check max iterations
    if (maxIterations > 0 && state.iteration > maxIterations) {
      console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
      console.log(`║  Max iterations (${maxIterations}) reached. Loop stopped.`);
      console.log(`║  Total time: ${formatDurationLong(history.totalDurationMs)}`);
      console.log(`╚══════════════════════════════════════════════════════════════════╝`);
      clearState();
      // Keep history for analysis via --status
      break;
    }

    const iterInfo = maxIterations > 0 ? ` / ${maxIterations}` : "";
    const minInfo = minIterations > 1 && state.iteration < minIterations ? ` (min: ${minIterations})` : "";
    console.log(`\n🔄 Iteration ${state.iteration}${iterInfo}${minInfo}`);
    console.log("─".repeat(68));

    // Capture context at start of iteration (to only clear what was consumed)
    const contextAtStart = loadContext();

    // Capture git state before iteration to detect per-iteration changes
    const snapshotBefore = await captureFileSnapshot();

    // Build the prompt
    const fullPrompt = buildPrompt(state);
    const iterationStart = Date.now();

    try {


      // Helper to match environment construction
      const env = { ...process.env };
      if (disablePlugins || allowAllPermissions) {
        env.OPENCODE_CONFIG = ensureRalphConfig({
          filterPlugins: disablePlugins,
          allowAllPermissions: allowAllPermissions,
        });
      }

      // Helper to build spawn arguments
      const buildOpencodeCmd = (opencodeArgs: string[], options: { interactive?: boolean; tty?: boolean } = {}) => {
          const { interactive = true, tty = interactive } = options;
          let executable = "opencode";
          let argsToSpawn = [...opencodeArgs];
          
          if (dockerImage) {
            executable = "docker";
            containerName = `ralph-runner-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            const cwd = process.cwd();
            
            // RESET argsToSpawn for Docker command structure
            argsToSpawn = ["run", "--rm"];

            if (tty) {
               argsToSpawn.push("-t");
            }
            if (interactive) {
                argsToSpawn.push("-i");
            }

            argsToSpawn.push("--name", containerName);

            // Volume Mount Strategy:
            // 1. Always include user-provided arguments intact (dockerArgs)
            // 2. Default mount CWD -> CWD unless overridden by user args
            
            // Check for explicit workdir in user args
            const hasCustomWorkDir = dockerArgs.some(a => a.includes("-w") || a.includes("--workdir"));
            
            // If user did NOT specify a custom workdir, we assume standard behavior:
            // Mount the partial CWD to itself and set it as workdir.
            // If they DID specify one, we assume they are handling mounts for it (e.g. -v /host/path:/container/path -w /container/path)
            if (!hasCustomWorkDir) {
                argsToSpawn.push("-v", `${cwd}:${cwd}`);
                argsToSpawn.push("-w", cwd);
            }

            // Mount OpenCode config if present
            if (env.OPENCODE_CONFIG && !argsToSpawn.some(a => a.includes(env.OPENCODE_CONFIG as string))) {
                 argsToSpawn.push("-v", `${env.OPENCODE_CONFIG}:${env.OPENCODE_CONFIG}`);
            }

            // Mount OpenCode data directory if it exists (CRITICAL for model access + tools)
            const opencodeDataDir = join(process.env.HOME || "", ".local/share/opencode");
            if (existsSync(opencodeDataDir)) {
                argsToSpawn.push("-v", `${opencodeDataDir}:${opencodeDataDir}`);
            }

            // Mount OpenCode config directory if it exists (CRITICAL for provider config like antigravity-accounts.json)
            const opencodeConfigDir = join(process.env.HOME || "", ".config/opencode");
            if (existsSync(opencodeConfigDir)) {
                 argsToSpawn.push("-v", `${opencodeConfigDir}:${opencodeConfigDir}`);
            }

            // Add all user-provided docker args (including ports, other volumes)
            // SPREAD THEM DIRECTLY. Logic elsewhere parsing them might be flawed/splitting strings wrong.
            // But here we rely on them being in dockerArgs array correctly.
            argsToSpawn.push(
              "--env", "OPENCODE_CONFIG",
              ...dockerArgs,
              // Pass XDG paths explicitly so opencode finds mounted config directories
              // DON'T pass HOME - it causes opencode to look for ~/.cache, ~/.local/state which aren't mounted
              ...(process.env.XDG_CONFIG_HOME ? ["--env", `XDG_CONFIG_HOME=${process.env.XDG_CONFIG_HOME}`] : 
                  process.env.HOME ? ["--env", `XDG_CONFIG_HOME=${process.env.HOME}/.config`] : []),
              ...(process.env.XDG_DATA_HOME ? ["--env", `XDG_DATA_HOME=${process.env.XDG_DATA_HOME}`] : 
                  process.env.HOME ? ["--env", `XDG_DATA_HOME=${process.env.HOME}/.local/share`] : []),
              // Set XDG_STATE_HOME and XDG_CACHE_HOME to /tmp to avoid permission issues (these dirs aren't mounted)
              "--env", "XDG_STATE_HOME=/tmp/opencode-state",
              "--env", "XDG_CACHE_HOME=/tmp/opencode-cache",
              // Pass API keys and other relevant env vars
              ...Object.keys(process.env)
                .filter(k => k.startsWith("OPENAI_") || k.startsWith("ANTHROPIC_") || k.startsWith("GOOGLE_") || k === "NVM_DIR" || k === "BUN_INSTALL")
                .flatMap(k => ["--env", k]),
              dockerImage,
              "opencode", ...opencodeArgs
            );
          } else if (devcontainerService) {
            executable = "devcontainer";
            argsToSpawn = [
                "exec", 
                "--workspace-folder", process.cwd(),
                "--service-name", devcontainerService,
                "opencode", ...opencodeArgs
            ];
          }
          return { executable, argsToSpawn };
      };

      // Run 'opencode models' before the first iteration (but only once)
      if (state.iteration === 1) {
          console.log("\n📋 Checking available models (opencode models)...");
          // Disable interactive and TTY for models check to prevent hanging/pagination
          const { executable: modExec, argsToSpawn: modArgs } = buildOpencodeCmd(["models"], { interactive: false, tty: false });
          
          // Use synchronous spawn or await promise to block
          console.log(`DEBUG: Running ${modExec} ${modArgs.join(" ")}`);
          const modProc = Bun.spawn([modExec, ...modArgs], {
              env,
              stdin: "ignore",
              stdout: "inherit",
              stderr: "inherit"
          });
          await modProc.exited;
          console.log("────────────────────────────────────────────────────────────────────");
      }

      // Build main command arguments
      const cmdArgs = ["run"];
      
      // Determine current model from queue
      let currentModel = state.model;
      if (state.modelQueue && state.modelQueue.length > 0) {
        // Ensure index is within bounds
        if (state.currentModelIndex >= state.modelQueue.length) {
            state.currentModelIndex = state.modelQueue.length - 1;
        }
        currentModel = state.modelQueue[state.currentModelIndex];
        // Sync single model field for backward compatibility/logging
        state.model = currentModel;
        saveState(state); // Update state on disk immediately
      }

      if (currentModel) {
        cmdArgs.push("-m", currentModel);
      }
      cmdArgs.push(fullPrompt);

      // Build command using helper (Force non-interactive to fail fast on prompts, but use TTY for unbuffered output)
      const { executable, argsToSpawn } = buildOpencodeCmd(cmdArgs, { interactive: false, tty: true });

      // Log the command for debugging
      console.log(`\nCORE EXECUTOR: Spawning: ${executable} ${argsToSpawn.join(" ")}`);
      // Flush logging
      await new Promise(r => setTimeout(r, 100));

      // DEBUG: Restoring pipe for capture, config restored, TTY enabled
      currentProc = Bun.spawn([executable, ...argsToSpawn], {
        env,
        stdin: "ignore", 
        stdout: "pipe",
        stderr: "pipe",
      });
      const proc = currentProc;
      const exitCodePromise = proc.exited;

      // Quota Monitoring
      let quotaInterrupted = false;
      const quotaInterval = setInterval(async () => {
        if (!state.model) return;
        
        // Don't check if we haven't been running long? 
        // 10m interval implies we check 10m *after* start. 
        
        try {
           const fetcher = new QuotaFetcher();
           const quotas = await fetcher.fetchAll();
           
           // Check availability of current model
           // Reuse logic from checkAndSortModels approximately?
           // Or just check specificity.
           
           const currentModel = state.model;
           const [provider, modelName] = currentModel.split("/");
           const p = provider.toLowerCase();
           
           let percentage = 100;
           let isForbidden = false;

           if (quotas[p]) {
               const q = quotas[p];
               if (q.isForbidden) isForbidden = true;
               else {
                   if (p === "openai" || p === "codex") {
                       const session = q.models.find(m => m.name.includes("session"));
                       if (session) percentage = session.percentage;
                   } else if (p === "google") {
                        if (modelName) {
                           const match = q.models.find(m => m.name.includes(modelName));
                           if (match) percentage = match.percentage;
                        }
                   }
               }
           }
           
           if (isForbidden || percentage < 5) { // < 5% trigger switch
               console.log(`\n⚠️  Active Quota Monitor: Model ${currentModel} exhausted (${Math.round(percentage)}%). Switching...`);
               
               if (state.modelQueue && state.currentModelIndex < state.modelQueue.length - 1) {
                   state.currentModelIndex++;
                   state.model = state.modelQueue[state.currentModelIndex];
                   saveState(state);
                   
                   quotaInterrupted = true;
                   proc.kill(); // This will trigger exit
               } else {
                   console.log("   No more models in queue. Continuing with current model until failure.");
               }
           }
           
        } catch (e) {
            // ignore quota fetch errors during run
        }
      }, 10 * 60 * 1000); // 10 minutes check

      // Ensure we clear interval on exit
      exitCodePromise.then(() => clearInterval(quotaInterval));

      // Iteration Skip Signal (Every 1s)
      const skipSignalPath = join(stateDir, "ralph-skip.signal");
      const signalInterval = setInterval(() => {
          if (existsSync(skipSignalPath)) {
               console.log("\n⏩ Skip signal received. Skipping iteration...");
               try {
                  require("fs").unlinkSync(skipSignalPath);
               } catch {}
               
               quotaInterrupted = true; // Treat as "interrupted" so we retry/continue loop
               
               // Robust Kill Strategy
               if (dockerImage && containerName) {
                   console.log(`Killing docker container: ${containerName}`);
                   try {
                     Bun.spawnSync(["docker", "kill", containerName], {
                         stderr: "ignore", stdout: "ignore"
                     });
                   } catch (e) {
                     // ignore
                   }
               }
               
               // Force kill the process object as well
               try {
                   // Try graceful first, then force
                   proc.kill(); 
                   if (proc.pid) {
                       // Give it a tiny moment or just SIGKILL immediately?
                       // User wants "Skip NOW", so SIGKILL is appropriate.
                       process.kill(proc.pid, "SIGKILL");
                   }
               } catch (e) {
                   // Ignore if already dead
               }
          }
      }, 1000);
      exitCodePromise.then(() => clearInterval(signalInterval));

      let result = "";
      let stderr = "";
      let toolCounts = new Map<string, number>();

      if (streamOutput && proc.stdout) {
        const streamed = await streamProcessOutput(proc, {
          compactTools: !verboseTools,
          toolSummaryIntervalMs: 3000,
          heartbeatIntervalMs: 10000,
          iterationStart,
        });
        result = streamed.stdoutText;
        stderr = streamed.stderrText;
        toolCounts = streamed.toolCounts;
      } else if (proc.stdout) {
        const stdoutPromise = new Response(proc.stdout as any).text();
        const stderrPromise = new Response(proc.stderr as any).text();
        [result, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
        toolCounts = collectToolSummaryFromText(`${result}\n${stderr}`);
      } else {
        console.log("DEBUG: Output streaming skipped (stdout is inherit)");
      }

      const exitCode = await exitCodePromise;
      currentProc = null; // Clear reference after subprocess completes

      if (!streamOutput) {
        if (stderr) {
          console.error(stderr);
        }
        console.log(result);
      }

      const combinedOutput = `${result}\n${stderr}`;
      
      // Multi-Model Fallback Logic
      if (state.modelQueue && state.modelQueue.length > 1) {
        const providers = loadProviderConfig(stateDir);
        const currentModel = state.modelQueue[state.currentModelIndex];
        // Simple provider extraction: assumes format "provider/model" or just "provider"
        // If not containing '/', valid heuristics might vary, but let's try to match whole string or split
        const providerMatch = currentModel.match(/^([^/]+)/); 
        const providerName = providerMatch ? providerMatch[1].toLowerCase() : currentModel.toLowerCase();

        const config = providers[providerName];
        if (config) {
             const errorPattern = new RegExp(config.pattern, 'i');
             if (errorPattern.test(combinedOutput)) {
                 console.log(`\n⚠️  Quota/Rate Limit detected for model ${currentModel} using pattern "${config.pattern}"`);
                 
                 if (state.currentModelIndex < state.modelQueue.length - 1) {
                     console.log(`   Switching to next model: ${state.modelQueue[state.currentModelIndex + 1]}...`);
                     
                     // Advance model index
                     state.currentModelIndex++;
                     state.model = state.modelQueue[state.currentModelIndex];
                     saveState(state);
                     
                     // OPTIONAL: We could continue immediately to retry the iteration with the new model
                     // instead of marking this one as failed/completed.
                     // For now, let's just loop. The next iteration will pick up the new model.
                     // To avoid "wasting" an iteration count on a rate limit, we could arguably decrement state.iteration
                     // but that messes with history tracking. Let's keep it simple.
                 } else {
                     console.warn(`   ⚠️  All provided models have been exhausted or last model failed.`);
                 }
             }
        }
      }
      const completionDetected = checkCompletion(combinedOutput, completionPromise);

      const iterationDuration = Date.now() - iterationStart;

      printIterationSummary({
        iteration: state.iteration,
        elapsedMs: iterationDuration,
        toolCounts,
        exitCode,
        completionDetected,
      });

      // Track iteration history - compare against pre-iteration snapshot
      const snapshotAfter = await captureFileSnapshot();
      const filesModified = getModifiedFilesSinceSnapshot(snapshotBefore, snapshotAfter);
      const errors = extractErrors(combinedOutput);

      const iterationRecord: IterationHistory = {
        iteration: state.iteration,
        startedAt: new Date(iterationStart).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: iterationDuration,
        toolsUsed: Object.fromEntries(toolCounts),
        filesModified,
        exitCode,
        completionDetected,
        errors,
      };

      history.iterations.push(iterationRecord);
      history.totalDurationMs += iterationDuration;

      // Update struggle indicators
      if (filesModified.length === 0) {
        history.struggleIndicators.noProgressIterations++;
      } else {
        history.struggleIndicators.noProgressIterations = 0; // Reset on progress
      }

      if (iterationDuration < 30000) { // Less than 30 seconds
        history.struggleIndicators.shortIterations++;
      } else {
        history.struggleIndicators.shortIterations = 0; // Reset on normal-length iteration
      }

      if (errors.length === 0) {
        // Reset error tracking when iteration has no errors (issue resolved)
        history.struggleIndicators.repeatedErrors = {};
      } else {
        for (const error of errors) {
          const key = error.substring(0, 100);
          history.struggleIndicators.repeatedErrors[key] = (history.struggleIndicators.repeatedErrors[key] || 0) + 1;
        }
      }

      saveHistory(history);

      // Show struggle warning if detected
      const struggle = history.struggleIndicators;
      if (state.iteration > 2 && (struggle.noProgressIterations >= 3 || struggle.shortIterations >= 3)) {
        console.log(`\n⚠️  Potential struggle detected:`);
        if (struggle.noProgressIterations >= 3) {
          console.log(`   - No file changes in ${struggle.noProgressIterations} iterations`);
        }
        if (struggle.shortIterations >= 3) {
          console.log(`   - ${struggle.shortIterations} very short iterations`);
        }
        console.log(`   💡 Tip: Use 'ralph --add-context "hint"' in another terminal to guide the agent`);
      }

      if (detectPlaceholderPluginError(combinedOutput)) {
        console.error(
          "\n❌ OpenCode tried to load the legacy 'ralph-wiggum' plugin. This package is CLI-only.",
        );
        console.error(
          "Remove 'ralph-wiggum' from your opencode.json plugin list, or re-run with --no-plugins.",
        );
        clearState();
        process.exit(1);
      }

      if (exitCode !== 0) {
        if (quotaInterrupted) {
             console.log("   Restarting iteration with new model...");
             // Skip history recording for this interrupted run, or maybe record it as skipped?
             // Let's just continue, which means we skip history.push (oops, history push is below)
             // We need to `continue` the outer while loop *before* history recording logic 
             // if we don't want to record a failure.
             
             // But we need to cleanup (snapshots etc). 
             // Actually simplest is to just let it loop, but ensure we don't treat non-zero exit code as a crash.
        } else {
             console.warn(`\n⚠️  OpenCode exited with code ${exitCode}. Continuing to next iteration.`);
        }
      }

      // If interrupted by quota, we don't want to record this as a completed iteration
      if (quotaInterrupted) {
          continue; 
      }

      // Check for completion
      if (completionDetected) {
        if (state.iteration < minIterations) {
          // Completion detected but minimum iterations not reached
          console.log(`\n⏳ Completion promise detected, but minimum iterations (${minIterations}) not yet reached.`);
          console.log(`   Continuing to iteration ${state.iteration + 1}...`);
        } else {
          console.log(`\n╔══════════════════════════════════════════════════════════════════╗`);
          console.log(`║  ✅ Completion promise detected: <promise>${completionPromise}</promise>`);
          console.log(`║  Task completed in ${state.iteration} iteration(s)`);
          console.log(`║  Total time: ${formatDurationLong(history.totalDurationMs)}`);
          console.log(`╚══════════════════════════════════════════════════════════════════╝`);
          clearState();
          clearHistory();
          clearContext();
          break;
        }
      }

      // Clear context only if it was present at iteration start (preserve mid-iteration additions)
      if (contextAtStart) {
        console.log(`📝 Context was consumed this iteration`);
        clearContext();
      }

      // Auto-commit if enabled
      if (autoCommit) {
        try {
          // Check if there are changes to commit
          const status = await $`git status --porcelain`.text();
          if (status.trim()) {
            await $`git add -A`;
            await $`git commit -m "Ralph iteration ${state.iteration}: work in progress"`.quiet();
            console.log(`📝 Auto-committed changes`);
          }
        } catch {
          // Git commit failed, that's okay
        }
      }

      // Update state for next iteration
      state.iteration++;
      saveState(state);

      // Small delay between iterations
      await new Promise(r => setTimeout(r, 1000));

    } catch (error) {
      // Kill subprocess if still running to prevent orphaned processes
      if (currentProc) {
        try {
          currentProc.kill();
        } catch {
          // Process may have already exited
        }
        currentProc = null;
      }
      console.error(`\n❌ Error in iteration ${state.iteration}:`, error);
      console.log("Continuing to next iteration...");

      // Track failed iteration in history to keep state/history in sync
      const iterationDuration = Date.now() - iterationStart;
      const errorRecord: IterationHistory = {
        iteration: state.iteration,
        startedAt: new Date(iterationStart).toISOString(),
        endedAt: new Date().toISOString(),
        durationMs: iterationDuration,
        toolsUsed: {},
        filesModified: [],
        exitCode: -1,
        completionDetected: false,
        errors: [String(error).substring(0, 200)],
      };
      history.iterations.push(errorRecord);
      history.totalDurationMs += iterationDuration;
      saveHistory(history);

      state.iteration++;
      saveState(state);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// Handle graceful shutdown
function cleanupAndExit() {
  console.log("\nGracefully stopping Ralph loop...");
  
  if (containerName) {
     console.log(`Stopping container ${containerName}...`);
     try {
       Bun.spawnSync(["docker", "kill", containerName]);
     } catch (e) {
       // ignore
     }
  }

  if (currentProc) {
    try {
      currentProc.kill(); 
    } catch (e) {
      // ignore
    }
  }
  process.exit(130); // Standard exit code for SIGINT
}

process.on("SIGINT", cleanupAndExit);
process.on("SIGTERM", cleanupAndExit);

// Run the loop
runRalphLoop().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
