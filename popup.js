const DEFAULT_URL = "http://localhost:11434";
const DEFAULT_MODEL = "ministral-3:14b-cloud";

const $ = (id) => document.getElementById(id);
const toggle = $("enableToggle");
const statusDot = $("statusDot");
const statusText = $("statusText");
const urlInput = $("ollamaUrl");
const modelSelect = $("modelSelect");
const modelError = $("modelError");
const refreshBtn = $("refreshModels");
const saveBtn = $("saveBtn");

function updateStatus(enabled) {
  toggle.checked = enabled;
  statusDot.className = "status-dot " + (enabled ? "active" : "inactive");
  statusText.textContent = enabled ? "Active on LinkedIn" : "Disabled";
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
    const res = await chrome.runtime.sendMessage({ type: "OLLAMA_FETCH_MODELS", url });
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

    const saved = await chrome.storage.local.get(["model"]);
    modelSelect.value = saved.model || DEFAULT_MODEL;
  } catch (e) {
    modelSelect.innerHTML = '<option value="">-- Connection failed --</option>';
    showError(`Cannot connect to ${url}`);
  } finally {
    modelSelect.disabled = refreshBtn.disabled = false;
  }
}

async function saveSettings() {
  const settings = {
    enabled: toggle.checked,
    ollamaUrl: urlInput.value || DEFAULT_URL,
    model: modelSelect.value,
  };
  await chrome.storage.local.set(settings);

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes("linkedin.com")) {
      await chrome.tabs.sendMessage(tab.id, { type: "SETTINGS_UPDATED", settings });
    }
  } catch (e) {}

  saveBtn.textContent = "Saved!";
  setTimeout(() => (saveBtn.textContent = "Save Settings"), 1500);
  updateStatus(settings.enabled);
}

async function sendToggle(enabled) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes("linkedin.com")) {
      await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_ENABLED", enabled });
    }
  } catch (e) {}
}

async function init() {
  const saved = await chrome.storage.local.get(["enabled", "ollamaUrl", "model"]);
  urlInput.value = saved.ollamaUrl || DEFAULT_URL;
  updateStatus(saved.enabled !== false);

  await fetchModels();
  modelSelect.value = saved.model || DEFAULT_MODEL;

  toggle.addEventListener("change", async () => {
    const on = toggle.checked;
    await chrome.storage.local.set({ enabled: on });
    updateStatus(on);
    sendToggle(on);
  });

  refreshBtn.addEventListener("click", fetchModels);
  saveBtn.addEventListener("click", saveSettings);
  urlInput.addEventListener("blur", fetchModels);
}

init();
