// src/client/helpers.ts
function getRunId(run) {
  if (!run)
    return null;
  return run.runId || run.id || null;
}
function getStartedAt(run) {
  if (!run)
    return null;
  return run.startedAt || run.started_at || null;
}
function normalizeLogEntry(log) {
  return {
    id: log.id,
    ts: log.timestamp || log.ts,
    level: log.level,
    source: log.source,
    message: log.message,
    tool: log.tool_name || log.tool
  };
}
function hasCurrentRun(data) {
  if (!data.currentRun)
    return false;
  return !!(data.currentRun.runId || data.currentRun.id);
}
function shouldShowMonitor(data, forceStartView, currentRunId) {
  if (forceStartView)
    return false;
  const isActive = data.status === "active";
  const hasRun = hasCurrentRun(data);
  const hasLogs = Array.isArray(data.logs) && data.logs.length > 0;
  return isActive || currentRunId !== null && hasRun || hasRun && hasLogs;
}
function escapeHtml(str) {
  if (!str)
    return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

// src/client/app.ts
var pollInterval = null;
var currentTargetId = "local";
var currentRunId = null;
var targets = [];
var runs = [];
var logStream = null;
var logStreamRunId = null;
var logHistoryLoadedRunId = null;
var lastLogSignature = null;
var isScrolledToBottom = true;
var modelQueue = [];
var forceStartView = false;
var lastRunStatus = null;
var lastRunId = null;
var cachedHome = "";
function getHome() {
  return cachedHome || "/home";
}
var views = null;
var badge = null;
var terminal = null;
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    views = {
      start: document.getElementById("view-start"),
      active: document.getElementById("view-active")
    };
    badge = document.getElementById("status-badge");
    terminal = document.getElementById("terminal");
    setupModeSelection();
    setupContextModal();
    setupTargetModal();
    setupModelQueueUI();
    setupTerminal();
    loadConfig();
    refreshTargets();
    refreshRuns();
    fetchModels();
    fetchEnv();
    pollStatus();
    pollInterval = setInterval(pollStatus, 1000);
    pollQuota();
    setInterval(pollQuota, 60000);
    setInterval(() => {
      refreshTargets();
      refreshRuns();
    }, 5000);
    if ("Notification" in window && Notification.permission !== "granted" && Notification.permission !== "denied") {
      document.body.addEventListener("click", () => {
        Notification.requestPermission();
      }, { once: true });
    }
  });
}
function checkNotifications(data, notifyFn = sendNotification) {
  if (!data.currentRun)
    return;
  const run = data.currentRun;
  if (run.runId !== lastRunId) {
    lastRunId = run.runId;
    lastRunStatus = run.status;
    return;
  }
  if (run.status !== lastRunStatus) {
    if (run.status === "completed") {
      notifyFn("Ralph Loop Completed", "The loop finished successfully.");
    } else if (run.status === "failed") {
      notifyFn("Ralph Loop Failed", "The loop encountered an error.");
    }
    lastRunStatus = run.status;
  }
}
function resetNotificationState() {
  lastRunId = null;
  lastRunStatus = null;
}
function sendNotification(title, body) {
  if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body, icon: "/favicon.ico" });
  }
}
async function refreshTargets() {
  try {
    const res = await fetch("/api/targets");
    const data = await res.json();
    targets = data.targets;
    updateTargetListUI();
  } catch (e) {
    console.warn("Failed to fetch targets:", e);
  }
}
async function refreshRuns() {
  try {
    const endpoint = currentTargetId === "local" ? "/api/runs?limit=20" : `/api/targets/${currentTargetId}/runs?limit=20`;
    const res = await fetch(endpoint);
    const data = await res.json();
    runs = data.runs;
    updateRunListUI();
  } catch (e) {
    console.warn("Failed to fetch runs:", e);
  }
}
function updateTargetListUI() {
  const list = document.getElementById("target-list");
  if (!list)
    return;
  let html = `
        <div class="target-item ${currentTargetId === "local" ? "active" : ""}" onclick="selectTarget('local')">
            <span class="target-status online"></span>
            <span class="target-name">Local Engine</span>
        </div>
    `;
  const healthWarning = document.getElementById("target-health-warning");
  let currentTargetUnhealthy = false;
  targets.forEach((t) => {
    let statusClass = "offline";
    if (t.health?.online)
      statusClass = "online";
    else if (currentTargetId === t.id)
      currentTargetUnhealthy = true;
    if (t.health?.error?.includes("Unauthorized")) {
      statusClass = "unauthorized";
      if (currentTargetId === t.id)
        currentTargetUnhealthy = true;
    }
    html += `
            <div class="target-item ${currentTargetId === t.id ? "active" : ""}" onclick="selectTarget('${t.id}')">
                <span class="target-status ${statusClass}" title="${t.health?.error || ""}"></span>
                <span class="target-name">${escapeHtml2(t.name)}</span>
                <button class="icon-btn" onclick="deleteTarget(event, '${t.id}')" title="Delete">✕</button>
            </div>
        `;
  });
  list.innerHTML = html;
  if (healthWarning) {
    healthWarning.style.display = currentTargetUnhealthy ? "block" : "none";
    if (currentTargetUnhealthy) {
      const t = targets.find((x) => x.id === currentTargetId);
      if (t?.health?.error?.includes("Unauthorized")) {
        healthWarning.textContent = "\uD83D\uDD11 Auth Failure";
      } else {
        healthWarning.textContent = "⚠️ Target Offline";
      }
    }
  }
  const nameElem = document.getElementById("current-target-name");
  if (nameElem) {
    if (currentTargetId === "local") {
      nameElem.textContent = "Local Engine";
    } else {
      const t = targets.find((x) => x.id === currentTargetId);
      nameElem.textContent = t ? t.name : "Remote Target";
    }
  }
}
function updateRunListUI() {
  const list = document.getElementById("run-list");
  if (!list)
    return;
  if (!runs || runs.length === 0) {
    list.innerHTML = '<div style="padding: 1rem; color: var(--text-faint); font-size: 0.8rem; text-align: center;">No runs found</div>';
    return;
  }
  let html = "";
  runs.forEach((r) => {
    const runId = getRunId(r);
    const startedAt = getStartedAt(r);
    const isActive = runId === currentRunId;
    const timeStr = startedAt ? new Date(startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    let statusText = r.status;
    let statusClass = `status-text-${r.status}`;
    const canDelete = r.status !== "active";
    html += `
            <div class="run-item ${isActive ? "active-run" : ""}" onclick="selectRun('${runId}')">
                <div class="run-item-header">
                    <span class="run-item-status ${statusClass}">${statusText}</span>
                    <span class="run-item-time">${timeStr}</span>
                </div>
                <div class="run-item-prompt">
                    ${escapeHtml(r.prompt || "")}
                ${r.workdir ? `
                <div 
                    onmouseenter="showGlobalTooltip(event, '${escapeHtml(r.workdir)}')"
                    onmouseleave="hideGlobalTooltip()"
                    style="font-size:0.75rem; color:var(--text-secondary); margin-top:2px; font-family:monospace; display: block; overflow: visible;">
                    \uD83D\uDCC2 ${escapeHtml(r.workdir.split("/").pop() || r.workdir)}
                </div>` : ""}
                </div>

                <div class="run-item-footer">
                    <span class="run-item-id">#${runId ? runId.slice(0, 8) : ""}</span>
                    ${canDelete ? `<button class="icon-btn run-delete-btn" onclick="deleteRun(event, '${runId}')" title="Delete run">✕</button>` : ""}
                </div>
            </div>
        `;
  });
  list.innerHTML = html;
}
if (typeof window !== "undefined") {
  window.selectTarget = (id) => {
    if (currentTargetId === id)
      return;
    currentTargetId = id;
    currentRunId = null;
    forceStartView = false;
    refreshTargets();
    refreshRuns();
    pollStatus();
  };
  window.selectRun = (id) => {
    currentRunId = id;
    forceStartView = false;
    resetLogState();
    refreshRuns();
    pollStatus();
  };
  window.deleteTarget = async (e, id) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to remove this target?"))
      return;
    try {
      await fetch(`/api/targets/${id}`, { method: "DELETE" });
      if (currentTargetId === id)
        currentTargetId = "local";
      refreshTargets();
    } catch (e2) {
      alert("Failed to delete target");
    }
  };
  window.deleteRun = async (e, id) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this run? This cannot be undone."))
      return;
    try {
      const endpoint = currentTargetId === "local" ? `/api/runs/${id}` : `/api/targets/${currentTargetId}/runs/${id}`;
      const res = await fetch(endpoint, { method: "DELETE" });
      const data = await res.json();
      if (data.error) {
        alert("Error deleting run: " + data.error);
      } else {
        if (currentRunId === id) {
          currentRunId = null;
          forceStartView = true;
        }
        refreshRuns();
      }
    } catch (e2) {
      alert("Failed to delete run");
    }
  };
}
async function pollQuota() {
  const list = document.getElementById("quota-list");
  const container = document.getElementById("quota-widget");
  if (!container || !list)
    return;
  try {
    const res = await fetch("/api/quota");
    const data = await res.json();
    let hasData = false;
    let html = "";
    const entries = [];
    const providers = ["openai", "codex", "google"];
    for (const provider of providers) {
      if (data[provider] && !data[provider].isForbidden) {
        const models = data[provider].models;
        if (models && models.length > 0) {
          hasData = true;
          models.forEach((m) => {
            let name = m.name.replace(provider + "-", "").replace(/-/g, " ");
            name = name.charAt(0).toUpperCase() + name.slice(1);
            const label = `${provider.charAt(0).toUpperCase() + provider.slice(1)} ${name}`;
            entries.push({ label, percentage: m.percentage });
          });
        }
      }
    }
    entries.sort((a, b) => a.label.localeCompare(b.label));
    for (const entry of entries) {
      let color = "#3fb950";
      if (entry.percentage < 20)
        color = "#f85149";
      else if (entry.percentage < 50)
        color = "#d29922";
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
      container.style.display = "block";
    } else {
      container.style.display = "none";
    }
  } catch (e) {
    console.warn("Quota poll failed:", e);
  }
}
async function pollStatus() {
  try {
    let endpoint = "";
    if (currentTargetId === "local") {
      if (currentRunId) {
        endpoint = `/api/runs/${currentRunId}`;
      } else {
        endpoint = "/api/status";
      }
    } else {
      if (currentRunId) {
        endpoint = `/api/targets/${currentTargetId}/runs/${currentRunId}`;
      } else {
        const res2 = await fetch(`/api/targets/${currentTargetId}/runs?limit=1&status=active`);
        const data2 = await res2.json();
        if (data2.runs && data2.runs.length > 0) {
          currentRunId = data2.runs[0].runId;
          endpoint = `/api/targets/${currentTargetId}/runs/${currentRunId}`;
        } else {
          updateUI({
            status: "idle",
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
      updateUI({
        status: data.status === "active" ? "active" : "idle",
        currentRun: data,
        iterations: data.iteration || 0,
        loopState: {
          modelQueue: data.modelQueue,
          maxIterations: data.maxIterations,
          model: data.model
        },
        logs: []
      });
    } else {
      updateUI(data);
    }
  } catch (e) {
    console.error("Polling error:", e);
  }
}
async function fetchRunLogs(runId) {
  try {
    const endpoint = currentTargetId === "local" ? `/api/runs/${runId}/logs?limit=500` : `/api/targets/${currentTargetId}/runs/${runId}/logs?limit=500`;
    const res = await fetch(endpoint);
    if (res.ok) {
      const data = await res.json();
      if (data.logs && data.logs.length > 0) {
        const logs = data.logs.map((log) => normalizeLogEntry(log));
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
    alert("Prompt is required");
    return;
  }
  try {
    const endpoint = currentTargetId === "local" ? "/api/start" : `/api/targets/${currentTargetId}/runs`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params)
    });
    const data = await res.json();
    if (data.error) {
      alert("Error starting loop: " + data.error);
    } else {
      terminal.innerHTML = "";
      resetLogState();
      currentRunId = data.runId;
      forceStartView = false;
      pollStatus();
      refreshRuns();
    }
  } catch (e) {
    alert("Network error starting loop");
  }
}
async function stopLoop() {
  if (!confirm("Are you sure you want to stop the loop?"))
    return;
  try {
    const endpoint = currentTargetId === "local" ? currentRunId ? `/api/runs/${currentRunId}/stop` : "/api/stop" : `/api/targets/${currentTargetId}/runs/${currentRunId}/stop`;
    await fetch(endpoint, { method: "POST" });
    pollStatus();
    refreshRuns();
  } catch (e) {
    alert("Error stopping loop");
  }
}
async function skipIteration() {
  if (!confirm("Skip current iteration? This will restart with a fresh attempt."))
    return;
  try {
    const endpoint = currentTargetId === "local" ? currentRunId ? `/api/runs/${currentRunId}/skip` : "/api/skip" : `/api/targets/${currentTargetId}/runs/${currentRunId}/skip`;
    await fetch(endpoint, { method: "POST" });
  } catch (e) {
    alert("Error skipping iteration");
  }
}
async function clearLoopState() {
  if (!confirm("Delete .opencode/ralph-loop.state.json?"))
    return;
  try {
    const res = await fetch("/api/state", { method: "DELETE" });
    const data = await res.json();
    if (data.error) {
      alert("Error deleting loop state: " + data.error);
    } else {
      pollStatus();
    }
  } catch (e) {
    alert("Error deleting loop state");
  }
}
async function loadConfig() {
  try {
    const res = await fetch("/api/config");
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
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ralph-config-${Date.now()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
function handleConfigUpload(input) {
  const file = input.files?.[0];
  if (!file)
    return;
  const reader = new FileReader;
  reader.onload = (e) => {
    try {
      const config = JSON.parse(e.target?.result);
      applyConfigToForm(config);
      alert("Config loaded successfully!");
    } catch (err) {
      alert("Error parsing config file: " + err);
    }
  };
  reader.readAsText(file);
  input.value = "";
}
function resetToStart() {
  currentRunId = null;
  forceStartView = true;
  stopLogStream();
  resetLogState();
  refreshRuns();
  updateUI({
    status: "idle",
    currentRun: null,
    iterations: 0,
    loopState: null,
    logs: []
  });
}
function updateUI(data) {
  checkNotifications(data);
  const isActive = data.status === "active";
  const hasLoopState = !!data.loopState;
  const clearButtons = [
    document.getElementById("btn-clear-state"),
    document.getElementById("btn-clear-state-start")
  ];
  clearButtons.forEach((btn) => {
    if (btn)
      btn.style.display = hasLoopState ? "inline-flex" : "none";
  });
  badge.textContent = isActive ? "\uD83D\uDD04 Active" : "⏹️ Ready";
  badge.className = `status-badge ${isActive ? "active" : ""}`;
  const shouldShowMonitorView = shouldShowMonitor(data, forceStartView, currentRunId);
  if (shouldShowMonitorView) {
    views.start.classList.remove("active");
    views.active.classList.add("active");
    updateActiveView(data);
  } else {
    views.active.classList.remove("active");
    views.start.classList.add("active");
    stopLogStream();
    const runNameElem = document.getElementById("current-run-name");
    if (runNameElem)
      runNameElem.textContent = "New Run";
  }
}
function updateActiveView(data) {
  const run = data.currentRun;
  if (!run)
    return;
  const runId = getRunId(run);
  const runNameElem = document.getElementById("current-run-name");
  if (runNameElem) {
    runNameElem.textContent = run.prompt ? run.prompt.length > 30 ? run.prompt.slice(0, 30) + "..." : run.prompt : runId ? runId.slice(0, 8) : "";
  }
  const promptElem = document.getElementById("active-prompt");
  if (promptElem)
    promptElem.textContent = `"${run.prompt || "Unknown Task"}"`;
  const indicator = document.getElementById("run-status-indicator");
  if (indicator) {
    const dot = indicator.querySelector(".status-dot");
    const text = indicator.querySelector(".status-text");
    if (run.status === "active") {
      dot.style.background = "#3fb950";
      dot.style.boxShadow = "0 0 5px #3fb950";
      text.textContent = "Running";
    } else if (run.status === "failed") {
      dot.style.background = "#f85149";
      dot.style.boxShadow = "0 0 5px #f85149";
      text.textContent = "Failed";
    } else if (run.status === "stopped") {
      dot.style.background = "#d29922";
      dot.style.boxShadow = "none";
      text.textContent = "Stopped";
    } else if (run.status === "completed") {
      dot.style.background = "#238636";
      dot.style.boxShadow = "none";
      text.textContent = "Completed";
    }
  }
  const btnNew = document.getElementById("btn-new-loop");
  if (btnNew) {
    btnNew.style.display = run.status === "active" ? "none" : "block";
  }
  const iterationDisplay = document.querySelector(".active-iteration-display");
  if (iterationDisplay) {
    let maxIter = "∞";
    if (data.loopState && typeof data.loopState.maxIterations === "number") {
      maxIter = data.loopState.maxIterations > 0 ? data.loopState.maxIterations : "∞";
    } else if (run.args && run.args.includes("--max-iterations")) {
      const maxIterIndex = run.args.indexOf("--max-iterations") + 1;
      if (maxIterIndex > 0 && maxIterIndex < run.args.length) {
        maxIter = run.args[maxIterIndex];
      }
    }
    const currentIter = typeof data.iterations === "number" && data.iterations > 0 ? data.iterations : data.loopState && typeof data.loopState.iteration === "number" ? data.loopState.iteration : 0;
    iterationDisplay.textContent = `${currentIter} / ${maxIter}`;
  }
  const loopQueue = data.loopState && Array.isArray(data.loopState.modelQueue) ? data.loopState.modelQueue : [];
  const runQueue = Array.isArray(run.modelQueue) ? run.modelQueue : [];
  const queueSource = runQueue.length > 0 ? runQueue : loopQueue;
  const activeModel = data.loopState && data.loopState.model ? data.loopState.model : queueSource[0];
  let activeIndex = 0;
  if (activeModel && queueSource.includes(activeModel)) {
    activeIndex = queueSource.indexOf(activeModel);
  } else if (JSON.stringify(queueSource) === JSON.stringify(loopQueue) && typeof data.loopState?.currentModelIndex === "number") {
    activeIndex = data.loopState.currentModelIndex;
  }
  updateModelQueueActive(queueSource, activeIndex);
  const newLogs = data.logs || [];
  if (runId !== currentRunId) {
    resetLogState();
    currentRunId = runId;
  }
  if (logHistoryLoadedRunId !== runId) {
    if (newLogs.length) {
      appendLogEntries(newLogs);
      logHistoryLoadedRunId = runId;
    } else if (runId) {
      fetchRunLogs(runId);
    }
  }
  if (run.status === "active" && runId) {
    startLogStream(runId);
  } else {
    stopLogStream();
  }
}
function getFormValues() {
  const modeInput = document.querySelector('input[name="mode"]:checked');
  const mode = modeInput.value;
  const modelList = startModelQueue.length > 0 ? startModelQueue : [];
  if (modelList.length === 0) {}
  const minIterInput = document.getElementById("min-iterations");
  const maxIterInput = document.getElementById("iterations");
  const promiseInput = document.getElementById("promise");
  const promptInput = document.getElementById("prompt");
  const params = {
    prompt: promptInput.value,
    modelQueue: modelList,
    model: modelList[0] || "",
    minIterations: parseInt(minIterInput.value) || 1,
    maxIterations: parseInt(maxIterInput.value) || 0,
    completionPromise: promiseInput.value,
    mode,
    flags: {
      noCommit: document.getElementById("no-commit").checked,
      verboseTools: document.getElementById("verbose-tools").checked,
      noPlugins: document.getElementById("no-plugins").checked,
      allowAll: document.getElementById("allow-all").checked,
      noStream: document.getElementById("no-stream").checked
    }
  };
  params.noCommit = params.flags.noCommit;
  params.verboseTools = params.flags.verboseTools;
  params.noPlugins = params.flags.noPlugins;
  params.allowAll = params.flags.allowAll;
  params.noStream = params.flags.noStream;
  if (mode === "docker") {
    params.dockerImage = document.getElementById("docker").value;
    params.codeDirectory = document.getElementById("docker-codedir").value;
    params.dockerArgs = document.getElementById("docker-args").value;
    const manualVols = [];
    document.querySelectorAll(".volume-row").forEach((row) => {
      const src = row.querySelector(".vol-src").value.trim();
      const target = row.querySelector(".vol-target").value.trim();
      const opts = row.querySelector(".vol-opts").value.trim();
      if (src && target) {
        manualVols.push({ src, target, opts });
      }
    });
    params.manualDockerVolumes = manualVols;
    const allVols = [...manualVols];
    const mountConfig = document.getElementById("mount-opencode-config").checked;
    const mountData = document.getElementById("mount-opencode-data").checked;
    const mountSocket = document.getElementById("mount-docker-socket").checked;
    const configPath = document.getElementById("opencode-config-path").value.trim();
    const dataPath = document.getElementById("opencode-data-path").value.trim();
    const socketHostPath = document.getElementById("docker-socket-host").value.trim() || "/var/run/docker.sock";
    const socketContainerPath = document.getElementById("docker-socket-container").value.trim() || "/var/run/docker.sock";
    if (mountConfig) {
      const src = configPath || `${getHome()}/.config/opencode`;
      allVols.push({ src, target: src, opts: "" });
    }
    if (mountData) {
      const src = dataPath || `${getHome()}/.local/share/opencode`;
      allVols.push({ src, target: src, opts: "" });
    }
    if (mountSocket) {
      allVols.push({ src: socketHostPath, target: socketContainerPath, opts: "" });
    }
    params.dockerVolumes = allVols;
  } else if (mode === "host") {
    params.codeDirectory = document.getElementById("host-codedir").value;
  }
  params.docker = {
    mountOpencodeConfig: document.getElementById("mount-opencode-config")?.checked ?? true,
    mountOpencodeData: document.getElementById("mount-opencode-data")?.checked ?? true,
    mountDockerSocket: document.getElementById("mount-docker-socket")?.checked ?? false,
    opencodeConfigPath: document.getElementById("opencode-config-path")?.value?.trim() || "",
    opencodeDataPath: document.getElementById("opencode-data-path")?.value?.trim() || "",
    dockerSocketHostPath: document.getElementById("docker-socket-host")?.value?.trim() || "/var/run/docker.sock",
    dockerSocketContainerPath: document.getElementById("docker-socket-container")?.value?.trim() || "/var/run/docker.sock"
  };
  return params;
}
function applyConfigToForm(config) {
  if (!config || !config.run)
    return;
  const r = config.run;
  if (r.prompt !== undefined)
    document.getElementById("prompt").value = r.prompt;
  if (r.prompt !== undefined)
    document.getElementById("prompt").value = r.prompt;
  if (Array.isArray(r.modelQueue)) {
    startModelQueue = r.modelQueue;
    renderStartQueue();
  } else if (r.modelQueue) {}
  if (startModelQueue.length === 0 && document.getElementById("model").value) {
    startModelQueue = document.getElementById("model").value.split(",").filter((s) => s.trim());
    renderStartQueue();
  }
  if (r.minIterations !== undefined)
    document.getElementById("min-iterations").value = r.minIterations;
  if (r.maxIterations !== undefined)
    document.getElementById("iterations").value = r.maxIterations;
  if (r.completionPromise !== undefined)
    document.getElementById("promise").value = r.completionPromise;
  if (r.mode)
    setMode(r.mode);
  if (r.flags) {
    document.getElementById("no-commit").checked = !!r.flags.noCommit;
    document.getElementById("verbose-tools").checked = !!r.flags.verboseTools;
    document.getElementById("no-plugins").checked = !!r.flags.noPlugins;
    document.getElementById("allow-all").checked = !!r.flags.allowAll;
    document.getElementById("no-stream").checked = !!r.flags.noStream;
  }
  if (r.dockerImage)
    document.getElementById("docker").value = r.dockerImage;
  if (r.codeDirectory) {
    if (r.mode === "docker")
      document.getElementById("docker-codedir").value = r.codeDirectory;
    else
      document.getElementById("host-codedir").value = r.codeDirectory;
  }
  if (r.dockerArgs)
    document.getElementById("docker-args").value = r.dockerArgs;
  const volsToLoad = r.manualDockerVolumes ?? r.dockerVolumes;
  if (volsToLoad && Array.isArray(volsToLoad)) {
    const list = document.getElementById("volume-mounts-list");
    if (list) {
      list.innerHTML = "";
      volsToLoad.forEach((vol) => {
        const id = Date.now() + Math.random().toString(16).slice(2);
        const div = document.createElement("div");
        div.className = "volume-row";
        div.id = `vol-${id}`;
        div.innerHTML = `
                    <input type="text" placeholder="Source Path (e.g. ./src)" class="vol-src" value="${escapeHtml2(vol.src || "")}">
                    <input type="text" placeholder="Target Path (e.g. /app/src)" class="vol-target" value="${escapeHtml2(vol.target || "")}">
                    <input type="text" placeholder="Opts (e.g. ro)" class="vol-opts" value="${escapeHtml2(vol.opts || "")}">
                    <button class="icon-btn" onclick="removeVolume('${id}')" title="Remove">✕</button>
                 `;
        list.appendChild(div);
      });
    }
  }
  if (r.docker) {
    const d = r.docker;
    if (d.mountOpencodeConfig !== undefined) {
      document.getElementById("mount-opencode-config").checked = d.mountOpencodeConfig;
    }
    if (d.mountOpencodeData !== undefined) {
      document.getElementById("mount-opencode-data").checked = d.mountOpencodeData;
    }
    if (d.mountDockerSocket !== undefined) {
      document.getElementById("mount-docker-socket").checked = d.mountDockerSocket;
    }
    if (d.opencodeConfigPath) {
      document.getElementById("opencode-config-path").value = d.opencodeConfigPath;
    }
    if (d.opencodeDataPath) {
      document.getElementById("opencode-data-path").value = d.opencodeDataPath;
    }
    if (d.dockerSocketHostPath) {
      document.getElementById("docker-socket-host").value = d.dockerSocketHostPath;
    }
    if (d.dockerSocketContainerPath) {
      document.getElementById("docker-socket-container").value = d.dockerSocketContainerPath;
    }
    if (d.dockerSocketPath && !d.dockerSocketHostPath) {
      document.getElementById("docker-socket-host").value = d.dockerSocketPath;
      document.getElementById("docker-socket-container").value = d.dockerSocketPath;
    }
  }
}
function setupModeSelection() {
  if (typeof window !== "undefined") {
    window.setMode = (mode) => {
      document.querySelectorAll('input[name="mode"]').forEach((r) => {
        const card = r.closest(".radio-card");
        if (r.value === mode) {
          card.classList.add("active");
          r.checked = true;
        } else
          card.classList.remove("active");
      });
      document.querySelectorAll(".opts-group").forEach((el) => el.classList.remove("active"));
      if (mode === "host")
        document.getElementById("opts-host")?.classList.add("active");
      if (mode === "docker")
        document.getElementById("opts-docker")?.classList.add("active");
    };
    setMode = window.setMode;
  }
}
if (typeof window !== "undefined") {
  window.addVolumeMount = () => {
    const list = document.getElementById("volume-mounts-list");
    if (!list)
      return;
    const id = Date.now();
    const div = document.createElement("div");
    div.className = "volume-row";
    div.id = `vol-${id}`;
    div.innerHTML = `
            <input type="text" placeholder="Source Path (e.g. ./src)" class="vol-src">
            <input type="text" placeholder="Target Path (e.g. /app/src)" class="vol-target">
            <input type="text" placeholder="Opts (e.g. ro)" class="vol-opts">
            <button class="icon-btn" onclick="removeVolume('${id}')" title="Remove">✕</button>
        `;
    list.appendChild(div);
  };
  window.removeVolume = (id) => {
    const el = document.getElementById(`vol-${id}`);
    if (el)
      el.remove();
  };
}
function toggleAdvanced() {
  const el = document.getElementById("advanced-options");
  if (el)
    el.classList.toggle("open");
}
function setupContextModal() {
  if (typeof window !== "undefined") {
    window.openContextModal = () => document.getElementById("context-modal")?.classList.add("open");
    window.closeContextModal = () => document.getElementById("context-modal")?.classList.remove("open");
    closeContextModal = window.closeContextModal;
  }
}
function setupTargetModal() {
  if (typeof window !== "undefined") {
    window.openTargetModal = () => document.getElementById("target-modal")?.classList.add("open");
    window.closeTargetModal = () => document.getElementById("target-modal")?.classList.remove("open");
    window.saveTarget = async () => {
      const name = document.getElementById("target-name").value;
      const baseUrl = document.getElementById("target-url").value;
      const token = document.getElementById("target-token").value;
      if (!name || !baseUrl) {
        alert("Name and URL are required");
        return;
      }
      try {
        const res = await fetch("/api/targets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, baseUrl, token })
        });
        if (res.ok) {
          window.closeTargetModal();
          document.getElementById("target-name").value = "";
          document.getElementById("target-url").value = "";
          document.getElementById("target-token").value = "";
          refreshTargets();
        } else {
          const data = await res.json();
          alert("Error: " + data.error);
        }
      } catch (e) {
        alert("Failed to save target");
      }
    };
    closeTargetModal = window.closeTargetModal;
  }
}
var closeTargetModal;
var closeContextModal;
var setMode;
function setupModelQueueUI() {
  const modelInput = document.getElementById("model");
  modelInput.addEventListener("change", () => {
    saveConfig();
  });
}
function updateModelQueueActive(queue, activeIndex = 0) {
  if (queue)
    modelQueue = queue;
  const list = document.getElementById("queue-list");
  if (!list)
    return;
  list.innerHTML = "";
  if (!modelQueue || modelQueue.length === 0) {
    list.innerHTML = '<div class="queue-item">No models configured</div>';
    return;
  }
  modelQueue.forEach((model, idx) => {
    const item = document.createElement("div");
    item.className = `queue-item ${idx === activeIndex ? "active" : ""}`;
    let actions = "";
    if (idx > 0) {
      actions += `<button class="icon-btn" onclick="moveModel(${idx}, -1)" title="Move Up">⬆️</button>`;
    }
    if (idx < modelQueue.length - 1) {
      actions += `<button class="icon-btn" onclick="moveModel(${idx}, 1)" title="Move Down">⬇️</button>`;
    }
    actions += `<button class="icon-btn" onclick="removeModel(${idx})" title="Remove" style="color: #f85149;">✕</button>`;
    const badgeLabel = idx === activeIndex ? "Active" : idx === activeIndex + 1 ? "Next" : idx + 1;
    item.innerHTML = `
            <div class="queue-item-name">
                <span class="queue-badge ${idx === activeIndex ? "badge-active" : "badge-pending"}">${badgeLabel}</span>
                <span>${escapeHtml2(model)}</span>
            </div>
            <div class="queue-actions">
                ${idx === activeIndex ? '<span style="font-size: 0.8rem; color: var(--text-secondary); margin-right: 0.5rem;">Running...</span>' : ""}
                ${actions}
            </div>
        `;
    list.appendChild(item);
  });
}
function saveQueueToBackend() {
  fetch("/api/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queue: modelQueue })
  }).catch((e) => console.error("Failed to save queue", e));
}
if (typeof window !== "undefined") {
  window.moveModel = (idx, direction) => {
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= modelQueue.length)
      return;
    const temp = modelQueue[idx];
    modelQueue[idx] = modelQueue[newIdx];
    modelQueue[newIdx] = temp;
    updateModelQueueActive();
    saveQueueToBackend();
  };
}
function escapeHtml2(text) {
  if (!text)
    return "";
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function logSignature(entry) {
  if (!entry)
    return "";
  return `${entry.ts}|${entry.level}|${entry.source}|${entry.tool || ""}|${entry.message}`;
}
function appendLogEntry(log) {
  if (!log)
    return;
  const signature = logSignature(log);
  if (signature && signature === lastLogSignature)
    return;
  const div = document.createElement("div");
  div.className = `log-entry log-${log.level}`;
  const timeStr = new Date(log.ts).toLocaleTimeString([], { hour12: false });
  let html = `<span style="opacity:0.5">[${timeStr}]</span> `;
  if (log.tool) {
    html += `<span class="log-tool">${log.tool}</span> `;
  }
  html += escapeHtml2(log.message);
  div.innerHTML = html;
  terminal.appendChild(div);
  lastLogSignature = signature;
}
function appendLogEntries(entries) {
  if (!entries || entries.length === 0)
    return;
  entries.forEach(appendLogEntry);
  if (isScrolledToBottom) {
    terminal.scrollTop = terminal.scrollHeight;
  }
}
var logPollingInterval = null;
var lastSeenLogId = null;
async function pollLogs(runId) {
  if (!runId)
    return;
  try {
    const endpoint = currentTargetId === "local" ? `/api/runs/${runId}/logs?limit=100${lastSeenLogId ? `&afterId=${lastSeenLogId}` : ""}` : `/api/targets/${currentTargetId}/runs/${runId}/logs?limit=100${lastSeenLogId ? `&afterId=${lastSeenLogId}` : ""}`;
    const res = await fetch(endpoint);
    const data = await res.json();
    const logs = data.logs || data;
    if (Array.isArray(logs) && logs.length > 0) {
      appendLogEntries(logs);
      const lastLog = logs[logs.length - 1];
      if (lastLog.id)
        lastSeenLogId = lastLog.id;
    }
  } catch (e) {
    console.warn("Log polling failed:", e);
  }
}
function startLogPolling(runId) {
  stopLogPolling();
  logPollingInterval = setInterval(() => pollLogs(runId), 3000);
}
function stopLogPolling() {
  if (logPollingInterval) {
    clearInterval(logPollingInterval);
    logPollingInterval = null;
  }
}
function startLogStream(runId) {
  if (!runId || typeof EventSource === "undefined")
    return;
  if (logStream && logStreamRunId === runId)
    return;
  stopLogStream();
  stopLogPolling();
  logStreamRunId = runId;
  const endpoint = currentTargetId === "local" ? `/api/runs/${runId}/stream` : `/api/targets/${currentTargetId}/runs/${runId}/stream`;
  logStream = new EventSource(endpoint);
  let connected = false;
  logStream.onopen = () => {
    connected = true;
    stopLogPolling();
    console.log("Log stream connected");
  };
  logStream.addEventListener("log", (event) => {
    try {
      const entry = JSON.parse(event.data);
      appendLogEntry(entry);
      if (isScrolledToBottom) {
        terminal.scrollTop = terminal.scrollHeight;
      }
    } catch (e) {
      console.warn("Failed to parse log stream entry", e);
    }
  });
  logStream.onerror = () => {
    if (connected) {
      console.warn("Log stream lost, falling back to polling");
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
  terminal.innerHTML = "";
  lastLogSignature = null;
  logHistoryLoadedRunId = null;
  lastSeenLogId = null;
}
function setupTerminal() {
  if (terminal) {
    terminal.addEventListener("scroll", () => {
      const threshold = 50;
      const position = terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight;
      isScrolledToBottom = position < threshold;
    });
  }
}
if (typeof window !== "undefined") {
  window.startLoop = startLoop;
  window.stopLoop = stopLoop;
  window.showGlobalTooltip = showGlobalTooltip;
  window.hideGlobalTooltip = hideGlobalTooltip;
  window.loadConfig = loadConfig;
  window.saveConfig = saveConfig;
  window.exportConfig = exportConfig;
  window.handleConfigUpload = handleConfigUpload;
  window.skipIteration = skipIteration;
  window.resetToStart = resetToStart;
  window.toggleAdvanced = toggleAdvanced;
  window.clearLoopState = clearLoopState;
  window.removeModel = (idx) => {
    modelQueue.splice(idx, 1);
    updateModelQueueActive();
    saveQueueToBackend();
  };
  window.addModelFromSelect = addModelFromSelect;
  window.removeStartModel = removeStartModel;
  window.moveStartModel = moveStartModel;
}
var tooltipEl = null;
function showGlobalTooltip(e, text) {
  if (tooltipEl)
    tooltipEl.remove();
  tooltipEl = document.createElement("div");
  tooltipEl.className = "global-tooltip";
  tooltipEl.textContent = text;
  document.body.appendChild(tooltipEl);
  const target = e.target;
  const rect = target.getBoundingClientRect();
  const tooltipRect = tooltipEl.getBoundingClientRect();
  let top = rect.top - tooltipRect.height - 8;
  let left = rect.left + (rect.width - tooltipRect.width) / 2;
  if (top < 0) {
    top = rect.bottom + 8;
  }
  if (left < 0)
    left = 10;
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
var startModelQueue = [];
async function fetchModels() {
  try {
    const res = await fetch("/api/models");
    if (res.ok) {
      const data = await res.json();
      const select = document.getElementById("model-select");
      if (select && data.models) {
        select.innerHTML = '<option value="" disabled selected>Select a model...</option>';
        data.models.forEach((m) => {
          const opt = document.createElement("option");
          opt.value = m;
          opt.textContent = m;
          select.appendChild(opt);
        });
        if (startModelQueue.length === 0) {}
      }
    }
  } catch (e) {
    console.warn("Failed to fetch models:", e);
  }
}
async function fetchEnv() {
  try {
    const res = await fetch("/api/env");
    if (res.ok) {
      const data = await res.json();
      cachedHome = data.HOME || "/home";
    }
  } catch (e) {
    console.warn("Failed to fetch env:", e);
  }
}
function addModelFromSelect(e) {
  e.preventDefault();
  const select = document.getElementById("model-select");
  const model = select.value;
  if (model) {
    startModelQueue.push(model);
    renderStartQueue();
    select.value = "";
  }
}
function removeStartModel(idx) {
  startModelQueue.splice(idx, 1);
  renderStartQueue();
}
function moveStartModel(idx, direction) {
  const newIdx = idx + direction;
  if (newIdx < 0 || newIdx >= startModelQueue.length)
    return;
  const temp = startModelQueue[idx];
  startModelQueue[idx] = startModelQueue[newIdx];
  startModelQueue[newIdx] = temp;
  renderStartQueue();
}
function renderStartQueue() {
  const list = document.getElementById("start-queue-list");
  if (!list)
    return;
  list.innerHTML = "";
  if (startModelQueue.length === 0) {
    list.innerHTML = '<div class="queue-empty-state">No models selected</div>';
    document.getElementById("model").value = "";
    return;
  }
  startModelQueue.forEach((model, idx) => {
    const item = document.createElement("div");
    item.className = "queue-item";
    let actions = "";
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
                <span>${escapeHtml2(model)}</span>
            </div>
            <div class="queue-actions">
                ${actions}
            </div>
        `;
    list.appendChild(item);
  });
  document.getElementById("model").value = startModelQueue.join(", ");
}
export {
  resetNotificationState,
  escapeHtml2 as escapeHtml,
  checkNotifications
};
