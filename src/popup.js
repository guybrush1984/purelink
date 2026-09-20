const api = typeof browser !== "undefined" ? browser : chrome;
const DEFAULT_URL = "http://localhost:11434";
const DEFAULT_MODEL = "gemma4:31b-cloud";

const $ = (id) => document.getElementById(id);
const toggle = $("enableToggle");
const statusDot = $("statusDot");
const statusText = $("statusText");
const urlInput = $("ollamaUrl");
const modelSelect = $("modelSelect");
const modelError = $("modelError");
const keyInput = $("ollamaApiKey");
const refreshBtn = $("refreshModels");
const saveBtn = $("saveBtn");
const jevKeyInput = $("jevApiKey");
const jevStats = $("jevStats");
const copyLogBtn = $("copyLog");

function updateStatus(enabled) {
  toggle.checked = enabled;
  statusDot.className = "status-dot " + (enabled ? "active" : "inactive");
  statusText.textContent = enabled ? "Active on LinkedIn" : "Disabled";
}

// The local daemon exposes cloud models suffixed ("gemma4:31b-cloud"); ollama.com
// lists them bare ("gemma4:31b"). Without this, switching the server to the cloud
// leaves the dropdown blank on a perfectly valid saved model.
function selectModel(want) {
  const names = [...modelSelect.options].map((o) => o.value);
  const alt = want.endsWith("-cloud") ? want.slice(0, -6) : want + "-cloud";
  modelSelect.value = names.includes(want) ? want : names.includes(alt) ? alt : "";
}

function showError(msg) {
  modelError.textContent = msg || "";
  modelError.style.display = msg ? "block" : "none";
}

function formatSize(bytes) {
  if (!bytes) return "?";
  const gb = bytes / (1024 * 1024 * 1024);
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(bytes / (1024 * 1024)).toFixed(0)}MB`;
}

async function fetchModels() {
  const url = urlInput.value || DEFAULT_URL;
  showError(null);
  modelSelect.innerHTML = '<option value="">Loading...</option>';
  modelSelect.disabled = refreshBtn.disabled = true;

  try {
    const res = await api.runtime.sendMessage({ type: "OLLAMA_FETCH_MODELS", url });
    if (res.error) throw new Error(res.error);

    const models = res.data.models || [];
    modelSelect.innerHTML = '<option value="">-- Select model --</option>';

    if (!models.length) {
      showError("No models found");
    } else {
      models.forEach((m) => {
        const opt = document.createElement("option");
        opt.value = m.name;
        opt.textContent = `${m.name} (${formatSize(m.size)})`;
        modelSelect.appendChild(opt);
      });
    }

    const saved = await api.storage.local.get(["model"]);
    selectModel(saved.model || DEFAULT_MODEL);
  } catch (e) {
    modelSelect.innerHTML = '<option value="">-- Connection failed --</option>';
    showError(`Cannot connect to ${url}`);
  } finally {
    modelSelect.disabled = refreshBtn.disabled = false;
  }
}

// Share of your feed flagged AI: the number to compare with the ~2% of real
// authors the cut-offs were fitted to flag.
async function showJevStats() {
  const { jevLog = [] } = await api.storage.local.get(["jevLog"]);
  const scored = jevLog.filter((e) => e.s != null);
  if (!scored.length) return;
  const ai = scored.filter((e) => e.v === "LIKELY_AI" || e.v === "DEFINITELY_AI").length;
  const bait = scored.filter((e) => e.b).length;
  jevStats.textContent = `${scored.length} posts · ${Math.round((ai / scored.length) * 100)}% flagged AI · ${Math.round((bait / scored.length) * 100)}% bait`;
}

async function copyLog() {
  const { jevLog = [] } = await api.storage.local.get(["jevLog"]);
  await navigator.clipboard.writeText(JSON.stringify(jevLog));
  copyLogBtn.textContent = "Copied";
  setTimeout(() => (copyLogBtn.textContent = "Copy log"), 1500);
}

async function saveSettings() {
  const settings = {
    enabled: toggle.checked,
    ollamaUrl: urlInput.value || DEFAULT_URL,
    model: modelSelect.value,
    ollamaApiKey: keyInput.value.trim(),
    jevApiKey: jevKeyInput.value.trim(),
  };
  await api.storage.local.set(settings);
  // Settings the Jev-only detector no longer reads
  await api.storage.local.remove(["openrouterApiKey", "jevLow", "jevHigh"]);
  showJevStats();

  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes("linkedin.com")) {
      await api.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED", settings });
    }
  } catch (e) {}

  saveBtn.textContent = "Saved!";
  setTimeout(() => (saveBtn.textContent = "Save Settings"), 1500);
  updateStatus(settings.enabled);
}

async function sendToggle(enabled) {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes("linkedin.com")) {
      await api.tabs.sendMessage(tab.id, { type: "TOGGLE_ENABLED", enabled });
    }
  } catch (e) {}
}

async function init() {
  const saved = await api.storage.local.get(["enabled", "ollamaUrl", "model", "ollamaApiKey", "jevApiKey", "openrouterApiKey"]);
  urlInput.value = saved.ollamaUrl || DEFAULT_URL;
  keyInput.value = saved.ollamaApiKey || "";
  jevKeyInput.value = saved.jevApiKey || saved.openrouterApiKey || "";
  showJevStats();
  updateStatus(saved.enabled !== false);

  await fetchModels();
  selectModel(saved.model || DEFAULT_MODEL);

  toggle.addEventListener("change", async () => {
    const on = toggle.checked;
    await api.storage.local.set({ enabled: on });
    updateStatus(on);
    sendToggle(on);
  });

  refreshBtn.addEventListener("click", fetchModels);
  saveBtn.addEventListener("click", saveSettings);
  copyLogBtn.addEventListener("click", copyLog);
  urlInput.addEventListener("blur", fetchModels);
}

init();
