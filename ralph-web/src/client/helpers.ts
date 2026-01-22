/**
 * Helper functions for Ralph Web Frontend
 * Extracted for testability and to handle property normalization
 */

// Types matching the main app types
export interface RunMetadata {
    runId: string;
    startedAt: string;
    endedAt: string | null;
    status: "active" | "completed" | "failed" | "stopped" | "pending" | "stopping";
    exitCode: number | null;
    prompt: string;
    modelQueue: string[];
    args: string[];
    mode: string;
    workdir?: string;
    targetId?: string;
    model?: string;
    maxIterations?: number;
    iteration?: number;
}

export interface StatusResponse {
    status: "active" | "idle";
    currentRun: RunMetadata | null;
    iterations: number;
    logs: LogEntry[];
    loopState: LoopState | null;
}

export interface LogEntry {
    id?: number;
    ts: string;
    level: "info" | "warn" | "error" | "tool" | "success";
    source: "stdout" | "stderr" | "system";
    message: string;
    tool?: string;
}

export interface LoopState {
    modelQueue?: string[];
    currentModelIndex?: number;
    iteration?: number;
    maxIterations?: number;
    model?: string;
}

/**
 * Extract run ID from a run object, handling both camelCase (runId) and snake_case (id) formats
 */
export function getRunId(run: any): string | null {
    if (!run) return null;
    return run.runId || run.id || null;
}

/**
 * Extract started timestamp from a run object, handling both formats
 */
export function getStartedAt(run: any): string | null {
    if (!run) return null;
    return run.startedAt || run.started_at || null;
}

/**
 * Normalize a run object from DB format (snake_case) to frontend format (camelCase)
 * This ensures consistent property access throughout the UI code
 */
export function normalizeRun(run: any): RunMetadata | null {
    if (!run) return null;
    
    return {
        runId: run.runId || run.id,
        startedAt: run.startedAt || run.started_at || '',
        endedAt: run.endedAt || run.ended_at || null,
        status: run.status,
        exitCode: run.exitCode ?? run.exit_code ?? null,
        prompt: run.prompt || '',
        modelQueue: run.modelQueue || run.model_queue || [],
        args: run.args || [],
        mode: run.mode || 'local',
        workdir: run.workdir,
        targetId: run.targetId || run.target_id,
        model: run.model,
        maxIterations: run.maxIterations || run.max_iterations,
        iteration: run.iteration
    };
}

/**
 * Normalize a log entry from DB format to frontend format
 */
export function normalizeLogEntry(log: any): LogEntry {
    return {
        id: log.id,
        ts: log.timestamp || log.ts,
        level: log.level,
        source: log.source,
        message: log.message,
        tool: log.tool_name || log.tool
    };
}

/**
 * Check if we have a current run (handles both id and runId properties)
 */
export function hasCurrentRun(data: StatusResponse): boolean {
    if (!data.currentRun) return false;
    return !!(data.currentRun.runId || (data.currentRun as any).id);
}

/**
 * Determine if the monitor view should be shown
 */
export function shouldShowMonitor(
    data: StatusResponse,
    forceStartView: boolean,
    currentRunId: string | null
): boolean {
    if (forceStartView) return false;
    
    const isActive = data.status === 'active';
    const hasRun = hasCurrentRun(data);
    const hasLogs = Array.isArray(data.logs) && data.logs.length > 0;
    
    // Show monitor view if:
    // 1. There's an active run, OR
    // 2. User explicitly selected a run (currentRunId is set and we have run data), OR
    // 3. There's a current run with logs
    return isActive || (currentRunId !== null && hasRun) || (hasRun && hasLogs);
}

/**
 * Escape HTML special characters to prevent XSS
 */
export function escapeHtml(str: string): string {
    if (!str) return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
