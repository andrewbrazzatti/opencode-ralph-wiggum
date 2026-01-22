/**
 * Ralph Web Frontend
 */

import { 
    getRunId, 
    getStartedAt, 
    normalizeRun, 
    normalizeLogEntry, 
    hasCurrentRun as helperHasCurrentRun, 
    shouldShowMonitor as helperShouldShowMonitor,
    escapeHtml as helperEscapeHtml
} from './helpers';
// State Interfaces
interface LogEntry {
  id?: number;
  ts: string;
  level: "info" | "warn" | "error" | "tool" | "success";
  source: "stdout" | "stderr" | "system";
  message: string;
  tool?: string;
}

interface RunMetadata {
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
}

interface Target {
    id: string;
    name: string;
    baseUrl: string;
    health?: {
        online: boolean;
        latency?: number;
        error?: string;
    };
}

interface LoopState {
    modelQueue?: string[];
    currentModelIndex?: number;
    iteration?: number;
    maxIterations?: number;
    model?: string;
}

interface StatusResponse {
  status: "active" | "idle";
  currentRun: RunMetadata | null;
  iterations: number;
  loopState: LoopState | null;
  logs: LogEntry[];
}

interface RunListResponse {
    runs: RunMetadata[];
}

interface TargetListResponse {
    targets: Target[];
}

interface QuotaModel {
    name: string;
    percentage: number;
}
interface QuotaProvider {
    isForbidden: boolean;
    models: QuotaModel[];
}
interface QuotaResponse {
    [key: string]: QuotaProvider;
}

// Global State
let pollInterval: Timer | null = null;
let currentTargetId: string = 'local';
let currentRunId: string | null = null;
let targets: Target[] = [];
let runs: RunMetadata[] = [];
let logStream: EventSource | null = null;
let logStreamRunId: string | null = null;
let logHistoryLoadedRunId: string | null = null;
let lastLogSignature: string | null = null;
let isScrolledToBottom = true;
let modelQueue: string[] = [];
let forceStartView = false;
let lastRunStatus: string | null = null;
let lastRunId: string | null = null;
let cachedHome: string = '';

// Get HOME path - fallback if not fetched yet
function getHome(): string {
    return cachedHome || '/home';
}

// DOM Elements
let views: { start: HTMLElement; active: HTMLElement } = null!;
let badge: HTMLElement = null!;
let terminal: HTMLElement = null!;

// Initialization
if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', () => {
        // Initialize DOM Elements
        views = {
            start: document.getElementById('view-start') as HTMLElement,
            active: document.getElementById('view-active') as HTMLElement
        };
        badge = document.getElementById('status-badge') as HTMLElement;
        terminal = document.getElementById('terminal') as HTMLElement;

        // Setup UI handlers
        setupModeSelection();
        setupContextModal();
        setupTargetModal();
        setupModelQueueUI();
        setupTerminal();
        
        // Initial Config Load
        loadConfig();
    
        // Initial Data Fetch
        refreshTargets();
        refreshRuns();
        fetchModels();
        fetchEnv();

        // Start Polling
        pollStatus();
        pollInterval = setInterval(pollStatus, 1000); // 1s polling
        
        // Quota Polling (every 60s for UI)
        pollQuota();
        setInterval(pollQuota, 60000);
        
        // Slow polling for background lists
        setInterval(() => {
            refreshTargets();
            refreshRuns();
        }, 5000);
        
        // Request Notification Permission
        if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
            document.body.addEventListener('click', () => {
                 Notification.requestPermission();
            }, { once: true });
        }
    });
}

// Export for testing
export function checkNotifications(data: StatusResponse, notifyFn = sendNotification) {
    if (!data.currentRun) return;
    const run = data.currentRun;
    
    // Detect new run
    if (run.runId !== lastRunId) {
        lastRunId = run.runId;
        lastRunStatus = run.status;
        return;
    }
    
    // Detect status change
    if (run.status !== lastRunStatus) {
        if (run.status === "completed") {
            notifyFn("Ralph Loop Completed", "The loop finished successfully.");
        } else if (run.status === "failed") {
            notifyFn("Ralph Loop Failed", "The loop encountered an error.");
        }
        lastRunStatus = run.status;
    }
}

export function resetNotificationState() {
    lastRunId = null;
    lastRunStatus = null;
}

function sendNotification(title: string, body: string) {
    if (typeof window !== 'undefined' && "Notification" in window && Notification.permission === "granted") {
        new Notification(title, { body, icon: '/favicon.ico' });
    }
}

// --- API Interactions ---

async function refreshTargets() {
    try {
        const res = await fetch('/api/targets');
        const data = await res.json() as TargetListResponse;
        targets = data.targets;
        updateTargetListUI();
    } catch (e) {
        console.warn("Failed to fetch targets:", e);
    }
}

async function refreshRuns() {
    try {
        const endpoint = currentTargetId === 'local' 
            ? '/api/runs?limit=20' 
            : `/api/targets/${currentTargetId}/runs?limit=20`;
        const res = await fetch(endpoint);
        const data = await res.json() as RunListResponse;
        runs = data.runs;
        updateRunListUI();
    } catch (e) {
        console.warn("Failed to fetch runs:", e);
    }
}

function updateTargetListUI() {
    const list = document.getElementById('target-list');
    if (!list) return;

    let html = `
        <div class="target-item ${currentTargetId === 'local' ? 'active' : ''}" onclick="selectTarget('local')">
            <span class="target-status online"></span>
            <span class="target-name">Local Engine</span>
        </div>
    `;

    const healthWarning = document.getElementById('target-health-warning');
    let currentTargetUnhealthy = false;

    targets.forEach(t => {
        let statusClass = 'offline';
        if (t.health?.online) statusClass = 'online';
        else if (currentTargetId === t.id) currentTargetUnhealthy = true;

        if (t.health?.error?.includes('Unauthorized')) {
            statusClass = 'unauthorized';
            if (currentTargetId === t.id) currentTargetUnhealthy = true;
        }

        html += `
            <div class="target-item ${currentTargetId === t.id ? 'active' : ''}" onclick="selectTarget('${t.id}')">
                <span class="target-status ${statusClass}" title="${t.health?.error || ''}"></span>
                <span class="target-name">${escapeHtml(t.name)}</span>
                <button class="icon-btn" onclick="deleteTarget(event, '${t.id}')" title="Delete">✕</button>
            </div>
        `;
    });

    list.innerHTML = html;
    
    if (healthWarning) {
        healthWarning.style.display = currentTargetUnhealthy ? 'block' : 'none';
        if (currentTargetUnhealthy) {
            const t = targets.find(x => x.id === currentTargetId);
            if (t?.health?.error?.includes('Unauthorized')) {
                healthWarning.textContent = '🔑 Auth Failure';
            } else {
                healthWarning.textContent = '⚠️ Target Offline';
            }
        }
    }

    // Update breadcrumb
    const nameElem = document.getElementById('current-target-name');
    if (nameElem) {
        if (currentTargetId === 'local') {
            nameElem.textContent = 'Local Engine';
        } else {
            const t = targets.find(x => x.id === currentTargetId);
            nameElem.textContent = t ? t.name : 'Remote Target';
        }
    }
}

function updateRunListUI() {
    const list = document.getElementById('run-list');
    if (!list) return;

    if (!runs || runs.length === 0) {
        list.innerHTML = '<div style="padding: 1rem; color: var(--text-faint); font-size: 0.8rem; text-align: center;">No runs found</div>';
        return;
    }

    let html = '';
    runs.forEach(r => {
        // Use helper functions for normalized property access
        const runId = getRunId(r);
        const startedAt = getStartedAt(r);
        const isActive = runId === currentRunId;
        const timeStr = startedAt ? new Date(startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        
        let statusText = r.status;
        let statusClass = `status-text-${r.status}`;
        const canDelete = r.status !== 'active';
        
        html += `
            <div class="run-item ${isActive ? 'active-run' : ''}" onclick="selectRun('${runId}')">
                <div class="run-item-header">
                    <span class="run-item-status ${statusClass}">${statusText}</span>
                    <span class="run-item-time">${timeStr}</span>
                </div>
                <div class="run-item-prompt">
                    ${helperEscapeHtml(r.prompt || '')}
                ${r.workdir ? `
                <div 
                    onmouseenter="showGlobalTooltip(event, '${helperEscapeHtml(r.workdir)}')"
                    onmouseleave="hideGlobalTooltip()"
                    style="font-size:0.75rem; color:var(--text-secondary); margin-top:2px; font-family:monospace; display: block; overflow: visible;">
                    📂 ${helperEscapeHtml(r.workdir.split('/').pop() || r.workdir)}
                </div>` : ''}
                </div>

                <div class="run-item-footer">
                    <span class="run-item-id">#${runId ? runId.slice(0, 8) : ''}</span>
                    ${canDelete ? `<button class="icon-btn run-delete-btn" onclick="deleteRun(event, '${runId}')" title="Delete run">✕</button>` : ''}
                </div>
            </div>
        `;
    });

    list.innerHTML = html;
}

if (typeof window !== 'undefined') {
    (window as any).selectTarget = (id: string) => {
        if (currentTargetId === id) return;
        currentTargetId = id;
        currentRunId = null; // Reset run when switching target
        forceStartView = false;
        refreshTargets();
        refreshRuns();
        pollStatus();
    };

    (window as any).selectRun = (id: string) => {
        currentRunId = id;
        forceStartView = false;
        resetLogState();
        refreshRuns();
        pollStatus();
    };

    (window as any).deleteTarget = async (e: Event, id: string) => {
        e.stopPropagation();
        if (!confirm('Are you sure you want to remove this target?')) return;
        try {
            await fetch(`/api/targets/${id}`, { method: 'DELETE' });
            if (currentTargetId === id) currentTargetId = 'local';
            refreshTargets();
        } catch (e) {
            alert('Failed to delete target');
        }
    };

    (window as any).deleteRun = async (e: Event, id: string) => {
        e.stopPropagation();
        if (!confirm('Are you sure you want to delete this run? This cannot be undone.')) return;
        try {
            const endpoint = currentTargetId === 'local'
                ? `/api/runs/${id}`
                : `/api/targets/${currentTargetId}/runs/${id}`;
            const res = await fetch(endpoint, { method: 'DELETE' });
            const data = await res.json();
            if (data.error) {
                alert('Error deleting run: ' + data.error);
            } else {
                if (currentRunId === id) {
                    currentRunId = null;
                    forceStartView = true;
                }
                refreshRuns();
            }
        } catch (e) {
            alert('Failed to delete run');
        }
    };
}

async function pollQuota() {
    const list = document.getElementById('quota-list');
    const container = document.getElementById('quota-widget');
    if (!container || !list) return;

    try {
        const res = await fetch('/api/quota');
        const data = await res.json() as QuotaResponse;
        
        let hasData = false;
        let html = '';
        interface Entry { label: string; percentage: number; }
        const entries: Entry[] = [];
        
        // Providers
        const providers = ['openai', 'codex', 'google']; // Display order
        
        for (const provider of providers) {
            if (data[provider] && !data[provider].isForbidden) {
                 const models = data[provider].models;
                 if (models && models.length > 0) {
                     hasData = true;
                     models.forEach(m => {
                         // Simplify name: 'openai-session' -> 'OpenAI Session'
                         let name = m.name.replace(provider + '-', '').replace(/-/g, ' ');
                         name = name.charAt(0).toUpperCase() + name.slice(1);
                         const label = `${provider.charAt(0).toUpperCase() + provider.slice(1)} ${name}`;
                         entries.push({ label, percentage: m.percentage });
                     });
                 }
            }
        }

        entries.sort((a, b) => a.label.localeCompare(b.label));

        for (const entry of entries) {
            let color = '#3fb950'; // Green
            if (entry.percentage < 20) color = '#f85149'; // Red
            else if (entry.percentage < 50) color = '#d29922'; // Orange

            html += `
                <div class="quota-item">
                    <div style="display:flex; justify-content:space-between; margin-bottom:0.25rem;">
                        <span style="font-size:0.8rem; color:var(--text-secondary);">${entry.label}</span>
                        <span style="font-size:0.8rem; color:${color}; font-weight:600;">${Math.round(entry.percentage)}%</span>
                    </div>
                    <div style="background:rgba(255,255,255,0.1); height:6px; border-radius:3px; overflow:hidden;">
                         <div style="background:${color}; width:${entry.percentage}%; height:100%;"></div>
                    </div>
                </div>
            `;
        }
        
        if (hasData) {
            list.innerHTML = html;
            container.style.display = 'block';
        } else {
            container.style.display = 'none';
        }

    } catch (e) {
        console.warn("Quota poll failed:", e);
    }
}

async function pollStatus() {
    try {
        let endpoint = '';
        if (currentTargetId === 'local') {
            if (currentRunId) {
                endpoint = `/api/runs/${currentRunId}`;
            } else {
                endpoint = '/api/status';
            }
        } else {
            if (currentRunId) {
                endpoint = `/api/targets/${currentTargetId}/runs/${currentRunId}`;
            } else {
                // Find most recent active run on target
                const res = await fetch(`/api/targets/${currentTargetId}/runs?limit=1&status=active`);
                const data = await res.json() as RunListResponse;
                if (data.runs && data.runs.length > 0) {
                    currentRunId = data.runs[0].runId;
                    endpoint = `/api/targets/${currentTargetId}/runs/${currentRunId}`;
                } else {
                    // No active run, show start view
                    updateUI({
                        status: 'idle',
                        currentRun: null,
                        iterations: 0,
                        loopState: null,
                        logs: []
                    });
                    return;
                }
            }
        }

        const res = await fetch(endpoint);
        const data = await res.json();
        
        if (currentRunId) {
            // It's a RunMetadata object + logs_count
            updateUI({
                status: data.status === 'active' ? 'active' : 'idle',
                currentRun: data,
                iterations: data.iteration || 0,
                loopState: {
                    modelQueue: data.modelQueue,
                    maxIterations: data.maxIterations,
                    model: data.model
                },
                logs: [] // Logs are handled by SSE/Initial fetch
            });
        } else {
            // It's a StatusResponse
            updateUI(data as StatusResponse);
        }
    } catch (e) {
        console.error("Polling error:", e);
    }
}

async function fetchRunLogs(runId: string) {
    try {
        const endpoint = currentTargetId === 'local'
            ? `/api/runs/${runId}/logs?limit=500`
            : `/api/targets/${currentTargetId}/runs/${runId}/logs?limit=500`;
        
        const res = await fetch(endpoint);
        if (res.ok) {
            const data = await res.json();
            if (data.logs && data.logs.length > 0) {
                // Use helper to normalize log format
                const logs: LogEntry[] = data.logs.map((log: any) => normalizeLogEntry(log));
                appendLogEntries(logs);
                logHistoryLoadedRunId = runId;
            }
        }
    } catch (e) {
        console.warn("Failed to fetch run logs:", e);
    }
}

async function startLoop() {
    const params = getFormValues();
    
    if (!params.prompt) {
        alert('Prompt is required');
        return;
    }

    try {
        const endpoint = currentTargetId === 'local' ? '/api/start' : `/api/targets/${currentTargetId}/runs`;
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(params)
        });
        
        const data = await res.json();
        if (data.error) {
            alert('Error starting loop: ' + data.error);
        } else {
            // Clear terminal for new run
            terminal.innerHTML = '';
            resetLogState();
            currentRunId = data.runId;
            forceStartView = false;
            // Immediate update
            pollStatus();
            refreshRuns();
        }
    } catch (e) {
        alert('Network error starting loop');
    }
}

async function stopLoop() {
    if (!confirm('Are you sure you want to stop the loop?')) return;
    
    try {
        const endpoint = currentTargetId === 'local' 
            ? (currentRunId ? `/api/runs/${currentRunId}/stop` : '/api/stop')
            : `/api/targets/${currentTargetId}/runs/${currentRunId}/stop`;
            
        await fetch(endpoint, { method: 'POST' });
        pollStatus();
        refreshRuns();
    } catch (e) {
        alert('Error stopping loop');
    }
}

async function skipIteration() {
    if (!confirm('Skip current iteration? This will restart with a fresh attempt.')) return;
    
    try {
        const endpoint = currentTargetId === 'local'
            ? (currentRunId ? `/api/runs/${currentRunId}/skip` : '/api/skip')
            : `/api/targets/${currentTargetId}/runs/${currentRunId}/skip`;

        await fetch(endpoint, { method: 'POST' });
        // Don't need to poll manually, UI will update when backend processes signal
    } catch (e) {
        alert('Error skipping iteration');
    }
}

async function clearLoopState() {
    if (!confirm('Delete .opencode/ralph-loop.state.json?')) return;
    
    try {
        const res = await fetch('/api/state', { method: 'DELETE' });
        const data = await res.json();
        if (data.error) {
            alert('Error deleting loop state: ' + data.error);
        } else {
            pollStatus();
        }
    } catch (e) {
        alert('Error deleting loop state');
    }
}

async function submitContext() {
    const input = document.getElementById('context-input') as HTMLTextAreaElement;
    const text = input.value.trim();
    
    if (!text) return;
    
    try {
        const endpoint = currentTargetId === 'local'
            ? (currentRunId ? `/api/runs/${currentRunId}/context` : '/api/context')
            : `/api/targets/${currentTargetId}/runs/${currentRunId}/context`;

        const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context: text })
        });
        
        const data = await res.json();
        if (data.error) {
            alert('Error adding context: ' + data.error);
        } else {
            input.value = '';
            closeContextModal();
            pollStatus();
        }
    } catch (e) {
        alert('Error adding context');
    }
}

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        if (res.ok) {
            const config = await res.json();
            applyConfigToForm(config);
        }
    } catch (e) {
        console.warn("Could not load config:", e);
    }
}

async function saveConfig() {
    const params = getFormValues();
    const config = {
        version: 1,
        run: params
    };

    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        const data = await res.json();
        if (data.success) {
            console.log("Config saved");
        } else {
            console.error("Failed to save config:", data.error);
        }
    } catch (e) {
        console.error("Error saving config:", e);
    }
}

function exportConfig() {
    const params = getFormValues();
    const config = {
        version: 1,
        run: params,
        exportedAt: new Date().toISOString()
    };
    
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ralph-config-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

function handleConfigUpload(input: HTMLInputElement) {
    const file = input.files?.[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const config = JSON.parse(e.target?.result as string);
            applyConfigToForm(config);
            alert("Config loaded successfully!");
        } catch (err) {
            alert("Error parsing config file: " + err);
        }
    };
    reader.readAsText(file);
    // Reset input so same file can be selected again
    input.value = '';
}

function resetToStart() {
    currentRunId = null; // Clear tracking so we fall back to normal view logic
    forceStartView = true;
    stopLogStream();
    resetLogState();
    refreshRuns(); // Refresh list to show the stopped/completed run
    updateUI({ 
        status: 'idle', 
        currentRun: null, 
        iterations: 0, 
        loopState: null, 
        logs: [] 
    }); // Force update to start view
}

// --- UI Logic ---

function updateUI(data: StatusResponse) {
    checkNotifications(data);
    const isActive = data.status === 'active';
    const hasLoopState = !!data.loopState;
    const clearButtons = [
        document.getElementById('btn-clear-state'),
        document.getElementById('btn-clear-state-start')
    ];
    clearButtons.forEach(btn => {
        if (btn) btn.style.display = hasLoopState ? 'inline-flex' : 'none';
    });
    
    // Badge
    badge.textContent = isActive ? '🔄 Active' : '⏹️ Ready';
    badge.className = `status-badge ${isActive ? 'active' : ''}`;
    
    // View Switching Logic - use tested helper functions
    const shouldShowMonitorView = helperShouldShowMonitor(data, forceStartView, currentRunId);

    if (shouldShowMonitorView) {
        views.start.classList.remove('active');
        views.active.classList.add('active');
        updateActiveView(data);
    } else {
        views.active.classList.remove('active');
        views.start.classList.add('active');
        stopLogStream();
        
        // Reset breadcrumb
        const runNameElem = document.getElementById('current-run-name');
        if (runNameElem) runNameElem.textContent = 'New Run';
    }
}

function updateActiveView(data: StatusResponse) {
    const run = data.currentRun;
    if (!run) return;
    
    // Use helper for normalized property access
    const runId = getRunId(run);
    
    // Breadcrumb
    const runNameElem = document.getElementById('current-run-name');
    if (runNameElem) {
        runNameElem.textContent = run.prompt ? (run.prompt.length > 30 ? run.prompt.slice(0, 30) + '...' : run.prompt) : (runId ? runId.slice(0, 8) : '');
    }

    // Header Info
    const promptElem = document.getElementById('active-prompt');
    if (promptElem) promptElem.textContent = `"${run.prompt || 'Unknown Task'}"`;
    
    // Status Indicator
    const indicator = document.getElementById('run-status-indicator');
    if (indicator) {
        const dot = indicator.querySelector('.status-dot') as HTMLElement;
        const text = indicator.querySelector('.status-text') as HTMLElement;
        
        if (run.status === 'active') {
            dot.style.background = '#3fb950';
            dot.style.boxShadow = '0 0 5px #3fb950';
            text.textContent = 'Running';
        } else if (run.status === 'failed') {
            dot.style.background = '#f85149';
            dot.style.boxShadow = '0 0 5px #f85149';
            text.textContent = 'Failed';
        } else if (run.status === 'stopped') {
             dot.style.background = '#d29922'; // Orange
             dot.style.boxShadow = 'none';
             text.textContent = 'Stopped';
        } else if (run.status === 'completed') {
             dot.style.background = '#238636'; // Darker green
             dot.style.boxShadow = 'none';
             text.textContent = 'Completed';
        }
    }
    
    const btnNew = document.getElementById('btn-new-loop');
    if (btnNew) {
        btnNew.style.display = run.status === 'active' ? 'none' : 'block';
    }

    const iterationDisplay = document.querySelector('.active-iteration-display');
    if (iterationDisplay) {
        let maxIter: string | number = '∞';
        if (data.loopState && typeof data.loopState.maxIterations === 'number') {
            maxIter = data.loopState.maxIterations > 0 ? data.loopState.maxIterations : '∞';
        } else if (run.args && run.args.includes('--max-iterations')) {
            const maxIterIndex = run.args.indexOf('--max-iterations') + 1;
            if (maxIterIndex > 0 && maxIterIndex < run.args.length) {
                maxIter = run.args[maxIterIndex];
            }
        }
        const currentIter = (typeof data.iterations === 'number' && data.iterations > 0)
            ? data.iterations
            : (data.loopState && typeof data.loopState.iteration === 'number' ? data.loopState.iteration : 0);
        iterationDisplay.textContent = `${currentIter} / ${maxIter}`;
    }

    // Update Model Queue in active view (read only for now)
    const loopQueue = data.loopState && Array.isArray(data.loopState.modelQueue)
        ? data.loopState.modelQueue
        : [];
    const runQueue = Array.isArray(run.modelQueue) ? run.modelQueue : [];
    const queueSource = runQueue.length > 0 ? runQueue : loopQueue;
    const activeModel = data.loopState && data.loopState.model ? data.loopState.model : queueSource[0];
    let activeIndex = 0;
    if (activeModel && queueSource.includes(activeModel)) {
        activeIndex = queueSource.indexOf(activeModel);
    } else if (JSON.stringify(queueSource) === JSON.stringify(loopQueue) && typeof data.loopState?.currentModelIndex === 'number') {
        activeIndex = data.loopState.currentModelIndex;
    }
    updateModelQueueActive(queueSource, activeIndex);

    // Logs
    const newLogs = data.logs || [];
    if (runId !== currentRunId) {
        resetLogState();
        currentRunId = runId;
    }

    // Load initial log history once per run
    if (logHistoryLoadedRunId !== runId) {
        if (newLogs.length) {
            // Use logs from status response (live runs)
            appendLogEntries(newLogs);
            logHistoryLoadedRunId = runId;
        } else if (runId) {
            // Fetch historical logs from database (for completed/stopped runs)
            fetchRunLogs(runId);
        }
    }

    // Stream new logs for active runs to avoid missing output
    if (run.status === 'active' && runId) {
        startLogStream(runId);
    } else {
        stopLogStream();
    }
}

function getFormValues() {
    const modeInput = document.querySelector('input[name="mode"]:checked') as HTMLInputElement;
    const mode = modeInput.value;
    
    // Use startModelQueue for the source of truth
    const modelList = startModelQueue.length > 0 ? startModelQueue : [];
    // Fallback?
    if (modelList.length === 0) {
        // Maybe alert or just send empty? Backend might handle it.
    }

    const minIterInput = document.getElementById('min-iterations') as HTMLInputElement;
    const maxIterInput = document.getElementById('iterations') as HTMLInputElement;
    const promiseInput = document.getElementById('promise') as HTMLInputElement;
    const promptInput = document.getElementById('prompt') as HTMLTextAreaElement;

    const params: any = {
        prompt: promptInput.value,
        modelQueue: modelList,
        model: modelList[0] || "", // For simple start
        minIterations: parseInt(minIterInput.value) || 1,
        maxIterations: parseInt(maxIterInput.value) || 0,
        completionPromise: promiseInput.value,
        mode: mode,
        
        // Flags
        flags: {
            noCommit: (document.getElementById('no-commit') as HTMLInputElement).checked,
            verboseTools: (document.getElementById('verbose-tools') as HTMLInputElement).checked,
            noPlugins: (document.getElementById('no-plugins') as HTMLInputElement).checked,
            allowAll: (document.getElementById('allow-all') as HTMLInputElement).checked,
            noStream: (document.getElementById('no-stream') as HTMLInputElement).checked
        }
    };
    
    // Flatten flags
    params.noCommit = params.flags.noCommit;
    params.verboseTools = params.flags.verboseTools;
    params.noPlugins = params.flags.noPlugins;
    params.allowAll = params.flags.allowAll;
    params.noStream = params.flags.noStream;

    if (mode === 'docker') {
        params.dockerImage = (document.getElementById('docker') as HTMLInputElement).value;
        params.codeDirectory = (document.getElementById('docker-codedir') as HTMLInputElement).value;
        params.dockerArgs = (document.getElementById('docker-args') as HTMLInputElement).value;
        
        // Collect MANUAL volumes only (not auto-added ones)
        const manualVols: {src: string, target: string, opts: string}[] = [];
        document.querySelectorAll('.volume-row').forEach(row => {
            const src = (row.querySelector('.vol-src') as HTMLInputElement).value.trim();
            const target = (row.querySelector('.vol-target') as HTMLInputElement).value.trim();
            const opts = (row.querySelector('.vol-opts') as HTMLInputElement).value.trim();
            
            if (src && target) {
                manualVols.push({ src, target, opts });
            }
        });
        
        // Store manual volumes separately for config persistence
        params.manualDockerVolumes = manualVols;
        
        // Build full volumes list (manual + auto-added) for runtime
        const allVols = [...manualVols];
        
        const mountConfig = (document.getElementById('mount-opencode-config') as HTMLInputElement).checked;
        const mountData = (document.getElementById('mount-opencode-data') as HTMLInputElement).checked;
        const mountSocket = (document.getElementById('mount-docker-socket') as HTMLInputElement).checked;
        
        const configPath = (document.getElementById('opencode-config-path') as HTMLInputElement).value.trim();
        const dataPath = (document.getElementById('opencode-data-path') as HTMLInputElement).value.trim();
        const socketHostPath = (document.getElementById('docker-socket-host') as HTMLInputElement).value.trim() || '/var/run/docker.sock';
        const socketContainerPath = (document.getElementById('docker-socket-container') as HTMLInputElement).value.trim() || '/var/run/docker.sock';
        
        // Add auto-generated volumes to runtime list
        if (mountConfig) {
            const src = configPath || `${getHome()}/.config/opencode`;
            allVols.push({ src, target: src, opts: '' });
        }
        if (mountData) {
            const src = dataPath || `${getHome()}/.local/share/opencode`;
            allVols.push({ src, target: src, opts: '' });
        }
        if (mountSocket) {
            allVols.push({ src: socketHostPath, target: socketContainerPath, opts: '' });
        }
        
        params.dockerVolumes = allVols;
    } else if (mode === 'host') {
        params.codeDirectory = (document.getElementById('host-codedir') as HTMLInputElement).value;
    }
    
    // Always capture docker settings for config persistence (regardless of current mode)
    params.docker = {
        mountOpencodeConfig: (document.getElementById('mount-opencode-config') as HTMLInputElement)?.checked ?? true,
        mountOpencodeData: (document.getElementById('mount-opencode-data') as HTMLInputElement)?.checked ?? true,
        mountDockerSocket: (document.getElementById('mount-docker-socket') as HTMLInputElement)?.checked ?? false,
        opencodeConfigPath: (document.getElementById('opencode-config-path') as HTMLInputElement)?.value?.trim() || '',
        opencodeDataPath: (document.getElementById('opencode-data-path') as HTMLInputElement)?.value?.trim() || '',
        dockerSocketHostPath: (document.getElementById('docker-socket-host') as HTMLInputElement)?.value?.trim() || '/var/run/docker.sock',
        dockerSocketContainerPath: (document.getElementById('docker-socket-container') as HTMLInputElement)?.value?.trim() || '/var/run/docker.sock'
    };
    
    return params;
}

function applyConfigToForm(config: any) {
    if (!config || !config.run) return;
    const r = config.run;
    
    if (r.prompt !== undefined) (document.getElementById('prompt') as HTMLInputElement).value = r.prompt;
    if (r.prompt !== undefined) (document.getElementById('prompt') as HTMLInputElement).value = r.prompt;
    if (Array.isArray(r.modelQueue)) {
        startModelQueue = r.modelQueue;
        renderStartQueue();
    } else if (r.modelQueue) {
         // handle string case if any
    }
    // Also handle legacy input just in case
    if (startModelQueue.length === 0 && (document.getElementById('model') as HTMLInputElement).value) {
        startModelQueue = (document.getElementById('model') as HTMLInputElement).value.split(',').filter(s=>s.trim());
        renderStartQueue();
    }
    if (r.minIterations !== undefined) (document.getElementById('min-iterations') as HTMLInputElement).value = r.minIterations;
    if (r.maxIterations !== undefined) (document.getElementById('iterations') as HTMLInputElement).value = r.maxIterations;
    if (r.completionPromise !== undefined) (document.getElementById('promise') as HTMLInputElement).value = r.completionPromise;
    
    if (r.mode) setMode(r.mode);
    
    if (r.flags) {
        (document.getElementById('no-commit') as HTMLInputElement).checked = !!r.flags.noCommit;
        (document.getElementById('verbose-tools') as HTMLInputElement).checked = !!r.flags.verboseTools;
        (document.getElementById('no-plugins') as HTMLInputElement).checked = !!r.flags.noPlugins;
        (document.getElementById('allow-all') as HTMLInputElement).checked = !!r.flags.allowAll;
        (document.getElementById('no-stream') as HTMLInputElement).checked = !!r.flags.noStream;
    }

    if (r.dockerImage) (document.getElementById('docker') as HTMLInputElement).value = r.dockerImage;
    if (r.codeDirectory) {
        if (r.mode === 'docker') (document.getElementById('docker-codedir') as HTMLInputElement).value = r.codeDirectory;
        else (document.getElementById('host-codedir') as HTMLInputElement).value = r.codeDirectory;
    }
    if (r.dockerArgs) (document.getElementById('docker-args') as HTMLInputElement).value = r.dockerArgs;
    
    // Rebuild Docker Volumes (use manualDockerVolumes for UI, fallback to dockerVolumes for legacy)
    const volsToLoad = r.manualDockerVolumes ?? r.dockerVolumes;
    if (volsToLoad && Array.isArray(volsToLoad)) {
        const list = document.getElementById('volume-mounts-list');
        if (list) {
            list.innerHTML = '';
            volsToLoad.forEach((vol: any) => {
                 const id = Date.now() + Math.random().toString(16).slice(2);
                 const div = document.createElement('div');
                 div.className = 'volume-row';
                 div.id = `vol-${id}`;
                 div.innerHTML = `
                    <input type="text" placeholder="Source Path (e.g. ./src)" class="vol-src" value="${escapeHtml(vol.src || '')}">
                    <input type="text" placeholder="Target Path (e.g. /app/src)" class="vol-target" value="${escapeHtml(vol.target || '')}">
                    <input type="text" placeholder="Opts (e.g. ro)" class="vol-opts" value="${escapeHtml(vol.opts || '')}">
                    <button class="icon-btn" onclick="removeVolume('${id}')" title="Remove">✕</button>
                 `;
                 list.appendChild(div);
            });
        }
    }

    // Restore Docker mount options
    if (r.docker) {
        const d = r.docker;
        if (d.mountOpencodeConfig !== undefined) {
            (document.getElementById('mount-opencode-config') as HTMLInputElement).checked = d.mountOpencodeConfig;
        }
        if (d.mountOpencodeData !== undefined) {
            (document.getElementById('mount-opencode-data') as HTMLInputElement).checked = d.mountOpencodeData;
        }
        if (d.mountDockerSocket !== undefined) {
            (document.getElementById('mount-docker-socket') as HTMLInputElement).checked = d.mountDockerSocket;
        }
        if (d.opencodeConfigPath) {
            (document.getElementById('opencode-config-path') as HTMLInputElement).value = d.opencodeConfigPath;
        }
        if (d.opencodeDataPath) {
            (document.getElementById('opencode-data-path') as HTMLInputElement).value = d.opencodeDataPath;
        }
        if (d.dockerSocketHostPath) {
            (document.getElementById('docker-socket-host') as HTMLInputElement).value = d.dockerSocketHostPath;
        }
        if (d.dockerSocketContainerPath) {
            (document.getElementById('docker-socket-container') as HTMLInputElement).value = d.dockerSocketContainerPath;
        }
        // Legacy support for old config format
        if (d.dockerSocketPath && !d.dockerSocketHostPath) {
            (document.getElementById('docker-socket-host') as HTMLInputElement).value = d.dockerSocketPath;
            (document.getElementById('docker-socket-container') as HTMLInputElement).value = d.dockerSocketPath;
        }
    }
}

// --- Interaction Handlers ---

// --- Interaction Handlers ---

function setupModeSelection() {
    if (typeof window !== 'undefined') {
        (window as any).setMode = (mode: string) => {
            document.querySelectorAll('input[name="mode"]').forEach((r: any) => {
                const card = r.closest('.radio-card');
                if (r.value === mode) {
                    card.classList.add('active');
                    r.checked = true;
                }
                else card.classList.remove('active');
            });
    
            document.querySelectorAll('.opts-group').forEach(el => el.classList.remove('active'));
            if (mode === 'host') document.getElementById('opts-host')?.classList.add('active');
            if (mode === 'docker') document.getElementById('opts-docker')?.classList.add('active');
        };
        setMode = (window as any).setMode;
    }
}

// Volume Mounts Logic
if (typeof window !== 'undefined') {
    (window as any).addVolumeMount = () => {
        const list = document.getElementById('volume-mounts-list');
        if (!list) return;
        const id = Date.now();
        const div = document.createElement('div');
        div.className = 'volume-row';
        div.id = `vol-${id}`;
        div.innerHTML = `
            <input type="text" placeholder="Source Path (e.g. ./src)" class="vol-src">
            <input type="text" placeholder="Target Path (e.g. /app/src)" class="vol-target">
            <input type="text" placeholder="Opts (e.g. ro)" class="vol-opts">
            <button class="icon-btn" onclick="removeVolume('${id}')" title="Remove">✕</button>
        `;
        list.appendChild(div);
    };
    
    (window as any).removeVolume = (id: string) => {
        const el = document.getElementById(`vol-${id}`);
        if (el) el.remove();
    };
}

function toggleAdvanced() {
    const el = document.getElementById('advanced-options');
    if (el) el.classList.toggle('open');
}

function setupContextModal() {
    if (typeof window !== 'undefined') {
        (window as any).openContextModal = () => document.getElementById('context-modal')?.classList.add('open');
        (window as any).closeContextModal = () => document.getElementById('context-modal')?.classList.remove('open');
        closeContextModal = (window as any).closeContextModal;
    }
}

function setupTargetModal() {
    if (typeof window !== 'undefined') {
        (window as any).openTargetModal = () => document.getElementById('target-modal')?.classList.add('open');
        (window as any).closeTargetModal = () => document.getElementById('target-modal')?.classList.remove('open');
        (window as any).saveTarget = async () => {
            const name = (document.getElementById('target-name') as HTMLInputElement).value;
            const baseUrl = (document.getElementById('target-url') as HTMLInputElement).value;
            const token = (document.getElementById('target-token') as HTMLInputElement).value;

            if (!name || !baseUrl) {
                alert('Name and URL are required');
                return;
            }

            try {
                const res = await fetch('/api/targets', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, baseUrl, token })
                });
                if (res.ok) {
                    (window as any).closeTargetModal();
                    // Clear inputs
                    (document.getElementById('target-name') as HTMLInputElement).value = '';
                    (document.getElementById('target-url') as HTMLInputElement).value = '';
                    (document.getElementById('target-token') as HTMLInputElement).value = '';
                    refreshTargets();
                } else {
                    const data = await res.json();
                    alert('Error: ' + data.error);
                }
            } catch (e) {
                alert('Failed to save target');
            }
        };
        closeTargetModal = (window as any).closeTargetModal;
    }
}

let closeTargetModal: () => void;
let closeContextModal: () => void;
let setMode: (mode: string) => void;

function setupModelQueueUI() {
    const modelInput = document.getElementById('model') as HTMLInputElement;
    modelInput.addEventListener('change', () => {
        saveConfig();
    });
}

function updateModelQueueActive(queue?: string[], activeIndex = 0) {
    // Update global state if new data provided
    if (queue) modelQueue = queue;

    const list = document.getElementById('queue-list');
    if (!list) return;
    
    list.innerHTML = '';
    if (!modelQueue || modelQueue.length === 0) {
        list.innerHTML = '<div class="queue-item">No models configured</div>';
        return;
    }

    modelQueue.forEach((model, idx) => {
        const item = document.createElement('div');
        item.className = `queue-item ${idx === activeIndex ? 'active' : ''}`;
        
        let actions = '';
        if (idx > 0) { 
             actions += `<button class="icon-btn" onclick="moveModel(${idx}, -1)" title="Move Up">⬆️</button>`;
        }
        if (idx < modelQueue.length - 1) {
             actions += `<button class="icon-btn" onclick="moveModel(${idx}, 1)" title="Move Down">⬇️</button>`;
        }
        actions += `<button class="icon-btn" onclick="removeModel(${idx})" title="Remove" style="color: #f85149;">✕</button>`;

        const badgeLabel = idx === activeIndex
            ? 'Active'
            : (idx === activeIndex + 1 ? 'Next' : idx + 1);

        item.innerHTML = `
            <div class="queue-item-name">
                <span class="queue-badge ${idx === activeIndex ? 'badge-active' : 'badge-pending'}">${badgeLabel}</span>
                <span>${escapeHtml(model)}</span>
            </div>
            <div class="queue-actions">
                ${idx === activeIndex ? '<span style="font-size: 0.8rem; color: var(--text-secondary); margin-right: 0.5rem;">Running...</span>' : ''}
                ${actions}
            </div>
        `;
        list.appendChild(item);
    });
}

function saveQueueToBackend() {
    fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queue: modelQueue })
    }).catch(e => console.error("Failed to save queue", e));
}

if (typeof window !== 'undefined') {
    (window as any).moveModel = (idx: number, direction: number) => {
        const newIdx = idx + direction;
        if (newIdx < 0 || newIdx >= modelQueue.length) return;
        
        const temp = modelQueue[idx];
        modelQueue[idx] = modelQueue[newIdx];
        modelQueue[newIdx] = temp;
        
        updateModelQueueActive();
        saveQueueToBackend();
    };
}


// Helpers
export function escapeHtml(text: string) {
    if (!text) return '';
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function logSignature(entry: LogEntry) {
    if (!entry) return '';
    return `${entry.ts}|${entry.level}|${entry.source}|${entry.tool || ''}|${entry.message}`;
}

function appendLogEntry(log: LogEntry) {
    if (!log) return;

    const signature = logSignature(log);
    if (signature && signature === lastLogSignature) return;

    const div = document.createElement('div');
    div.className = `log-entry log-${log.level}`;

    const timeStr = new Date(log.ts).toLocaleTimeString([], { hour12: false });
    let html = `<span style="opacity:0.5">[${timeStr}]</span> `;
    if (log.tool) {
        html += `<span class="log-tool">${log.tool}</span> `;
    }

    html += escapeHtml(log.message);

    div.innerHTML = html;
    terminal.appendChild(div);

    lastLogSignature = signature;
}

function appendLogEntries(entries: LogEntry[]) {
    if (!entries || entries.length === 0) return;

    entries.forEach(appendLogEntry);

    if (isScrolledToBottom) {
        terminal.scrollTop = terminal.scrollHeight;
    }
}

let logPollingInterval: Timer | null = null;
let lastSeenLogId: number | null = null;

async function pollLogs(runId: string) {
    if (!runId) return;
    try {
        const endpoint = currentTargetId === 'local'
            ? `/api/runs/${runId}/logs?limit=100${lastSeenLogId ? `&afterId=${lastSeenLogId}` : ''}`
            : `/api/targets/${currentTargetId}/runs/${runId}/logs?limit=100${lastSeenLogId ? `&afterId=${lastSeenLogId}` : ''}`;
            
        const res = await fetch(endpoint);
        const data = await res.json();
        const logs = data.logs || data; // Handle both {logs, total} and raw array
        
        if (Array.isArray(logs) && logs.length > 0) {
            appendLogEntries(logs);
            // Assuming the last log has an ID we can use for afterId
            // If not, we might need to rely on timestamps or count
            // The backend LogEntry has 'id' if coming from DB
            const lastLog = logs[logs.length - 1];
            if (lastLog.id) lastSeenLogId = lastLog.id;
        }
    } catch (e) {
        console.warn("Log polling failed:", e);
    }
}

function startLogPolling(runId: string) {
    stopLogPolling();
    logPollingInterval = setInterval(() => pollLogs(runId), 3000);
}

function stopLogPolling() {
    if (logPollingInterval) {
        clearInterval(logPollingInterval);
        logPollingInterval = null;
    }
}

function startLogStream(runId: string) {
    if (!runId || typeof EventSource === 'undefined') return;
    if (logStream && logStreamRunId === runId) return;

    stopLogStream();
    stopLogPolling();
    logStreamRunId = runId;

    const endpoint = currentTargetId === 'local'
        ? `/api/runs/${runId}/stream`
        : `/api/targets/${currentTargetId}/runs/${runId}/stream`;

    logStream = new EventSource(endpoint);
    
    let connected = false;

    logStream.onopen = () => {
        connected = true;
        stopLogPolling();
        console.log("Log stream connected");
    };

    logStream.addEventListener('log', (event) => {
        try {
            const entry = JSON.parse(event.data);
            appendLogEntry(entry);
            if (isScrolledToBottom) {
                terminal.scrollTop = terminal.scrollHeight;
            }
        } catch (e) {
            console.warn('Failed to parse log stream entry', e);
        }
    });

    logStream.onerror = () => {
        if (connected) {
            console.warn('Log stream lost, falling back to polling');
            connected = false;
            startLogPolling(runId);
        }
    };
}

function stopLogStream() {
    if (logStream) {
        logStream.close();
        logStream = null;
    }
    logStreamRunId = null;
    stopLogPolling();
}

function resetLogState() {
    terminal.innerHTML = '';
    lastLogSignature = null;
    logHistoryLoadedRunId = null;
    lastSeenLogId = null;
}

// Scroll detection
function setupTerminal() {
    if (terminal) {
        terminal.addEventListener('scroll', () => {
             const threshold = 50;
             const position = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight;
             isScrolledToBottom = position < threshold;
        });
    }
}

// Expose functions to window
if (typeof window !== 'undefined') {
    (window as any).startLoop = startLoop;
    (window as any).stopLoop = stopLoop;
    (window as any).showGlobalTooltip = showGlobalTooltip;
    (window as any).hideGlobalTooltip = hideGlobalTooltip;
    
    // Check if these were already exported or if I need to re-add them
    // Based on previous replace, I might have cut off submitContext...
    (window as any).loadConfig = loadConfig;
    (window as any).saveConfig = saveConfig;
    (window as any).exportConfig = exportConfig;
    (window as any).handleConfigUpload = handleConfigUpload;
    (window as any).skipIteration = skipIteration;
    (window as any).resetToStart = resetToStart;
    (window as any).toggleAdvanced = toggleAdvanced;
    (window as any).clearLoopState = clearLoopState;
    (window as any).removeModel = (idx: number) => {
        modelQueue.splice(idx, 1);
        updateModelQueueActive();
        saveQueueToBackend();
    };
    (window as any).addModelFromSelect = addModelFromSelect;
    (window as any).removeStartModel = removeStartModel;
    (window as any).moveStartModel = moveStartModel;
}

let tooltipEl: HTMLElement | null = null;

function showGlobalTooltip(e: MouseEvent, text: string) {
    if (tooltipEl) tooltipEl.remove();
    
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'global-tooltip';
    tooltipEl.textContent = text; // Already escaped in invocation if needed, but textContent is safe
    
    document.body.appendChild(tooltipEl);
    
    const target = e.target as HTMLElement;
    const rect = target.getBoundingClientRect();
    
    // Position above centered
    const tooltipRect = tooltipEl.getBoundingClientRect();
    let top = rect.top - tooltipRect.height - 8;
    let left = rect.left + (rect.width - tooltipRect.width) / 2;
    
    // Prevent top overflow
    if (top < 0) {
        top = rect.bottom + 8; // flip to bottom
    }
    
    // Prevent horizontal overflow
    if (left < 0) left = 10;
    if (left + tooltipRect.width > window.innerWidth) {
        left = window.innerWidth - tooltipRect.width - 10;
    }
    
    tooltipEl.style.top = `${top}px`;
    tooltipEl.style.left = `${left}px`;
}

function hideGlobalTooltip() {
    if (tooltipEl) {
        tooltipEl.remove();
        tooltipEl = null;
    }
}


// --- Model Selector Logic (Start View) ---
let startModelQueue: string[] = [];

async function fetchModels() {
    try {
        const res = await fetch('/api/models');
        if (res.ok) {
            const data = await res.json();
            const select = document.getElementById('model-select') as HTMLSelectElement;
            if (select && data.models) {
                select.innerHTML = '<option value="" disabled selected>Select a model...</option>';
                data.models.forEach((m: string) => {
                    const opt = document.createElement('option');
                    opt.value = m;
                    opt.textContent = m;
                    select.appendChild(opt);
                });
                
                // Pre-populate if empty
                if (startModelQueue.length === 0) {
                     // Maybe add defaults if needed, or just leave empty
                     // Default from previous config if applied
                }
            }
        }
    } catch (e) {
        console.warn("Failed to fetch models:", e);
    }
}

async function fetchEnv() {
    try {
        const res = await fetch('/api/env');
        if (res.ok) {
            const data = await res.json();
            cachedHome = data.HOME || '/home';
        }
    } catch (e) {
        console.warn("Failed to fetch env:", e);
    }
}

function addModelFromSelect(e: Event) {
    e.preventDefault();
    const select = document.getElementById('model-select') as HTMLSelectElement;
    const model = select.value;
    if (model) {
        startModelQueue.push(model);
        renderStartQueue();
        select.value = ""; // Reset select
    }
}

function removeStartModel(idx: number) {
    startModelQueue.splice(idx, 1);
    renderStartQueue();
}

function moveStartModel(idx: number, direction: number) {
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= startModelQueue.length) return;
    
    const temp = startModelQueue[idx];
    startModelQueue[idx] = startModelQueue[newIdx];
    startModelQueue[newIdx] = temp;
    
    renderStartQueue();
}

function renderStartQueue() {
    const list = document.getElementById('start-queue-list');
    if (!list) return;
    
    list.innerHTML = '';
    if (startModelQueue.length === 0) {
        list.innerHTML = '<div class="queue-empty-state">No models selected</div>';
        // helper input update
        (document.getElementById('model') as HTMLInputElement).value = "";
        return;
    }

    startModelQueue.forEach((model, idx) => {
        const item = document.createElement('div');
        item.className = 'queue-item';
        
        let actions = '';
        if (idx > 0) { 
             actions += `<button class="icon-btn" onclick="moveStartModel(${idx}, -1)" title="Move Up">⬆️</button>`;
        }
        if (idx < startModelQueue.length - 1) {
             actions += `<button class="icon-btn" onclick="moveStartModel(${idx}, 1)" title="Move Down">⬇️</button>`;
        }
        actions += `<button class="icon-btn" onclick="removeStartModel(${idx})" title="Remove" style="color: #f85149;">✕</button>`;

        item.innerHTML = `
            <div class="queue-item-name">
                <span class="queue-badge badge-pending">${idx + 1}</span>
                <span>${escapeHtml(model)}</span>
            </div>
            <div class="queue-actions">
                ${actions}
            </div>
        `;
        list.appendChild(item);
    });
    
    // Update hidden input for legacy or config saving
    (document.getElementById('model') as HTMLInputElement).value = startModelQueue.join(', ');
}

// End of Model Selector Logic

