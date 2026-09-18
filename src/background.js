const api = typeof browser !== "undefined" ? browser : chrome;
const isFirefox = typeof browser !== "undefined";
const JEV_URL = "https://openrouter.ai/api/alpha/decisions";

// Chrome MV3 service worker loads these itself; Firefox MV2 lists them in the
// manifest's background.scripts, where importScripts does not exist.
if (typeof importScripts === "function") importScripts("/src/factcheck-prompt.js", "/src/factcheck.js");

// Chrome: declarativeNetRequest
if (!isFirefox && api.declarativeNetRequest) {
  const rules = [
    { id: 1, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "remove" }] }, condition: { urlFilter: "||localhost", resourceTypes: ["xmlhttprequest"] } },
    { id: 2, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "remove" }] }, condition: { urlFilter: "||127.0.0.1", resourceTypes: ["xmlhttprequest"] } },
  ];
  api.runtime.onInstalled.addListener(() => {
    api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1, 2], addRules: rules });
  });
}

// Firefox: webRequest
if (isFirefox && api.webRequest) {
  api.webRequest.onBeforeSendHeaders.addListener(
    (details) => ({ requestHeaders: details.requestHeaders.filter((h) => h.name.toLowerCase() !== "origin") }),
    { urls: ["*://localhost/*", "*://127.0.0.1/*"] },
    ["blocking", "requestHeaders"]
  );
}

// Fact-check runs for tens of seconds over many calls, so it streams progress
// back over a port rather than resolving one message. The open port also keeps
// the MV3 service worker alive for the duration.
api.runtime.onConnect.addListener((port) => {
  if (port.name !== "factcheck") return;
  port.onMessage.addListener(async (msg) => {
    if (msg.type !== "RUN") return;
    const emit = (e) => {
      try {
        port.postMessage(e);
      } catch (_) {} // panel closed mid-run
    };
    try {
      await self.runFactCheck(msg.text, msg.urls || [], emit);
    } catch (e) {
      emit({ k: "error", message: e.message });
    }
  });
});

// The local daemon needs no auth; ollama.com needs the API key. Both speak the
// same OpenAI-shaped API and both serve /api/tags, so one URL setting covers
// "local daemon" and "no daemon at all, straight to the cloud".
function isLocalOllama(url) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(url);
}

async function ollamaAuthHeaders(url) {
  if (isLocalOllama(url)) return {};
  const { ollamaApiKey } = await api.storage.local.get(["ollamaApiKey"]);
  return ollamaApiKey ? { Authorization: `Bearer ${ollamaApiKey}` } : {};
}

self.ollamaAuthHeaders = ollamaAuthHeaders;

api.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === "OLLAMA_REQUEST") {
    ollamaRequest(msg.url, msg.options).then(respond);
    return true;
  }
  if (msg.type === "OLLAMA_FETCH_MODELS") {
    fetchModels(msg.url).then(respond);
    return true;
  }
  if (msg.type === "JEV_REQUEST") {
    jevRequest(msg.body).then(respond);
    return true;
  }
});

// Jev answers typed questions with probabilities on OpenRouter's Decisions
// route, not chat completions. Callers treat any error as "ask Ollama instead".
async function jevRequest(body) {
  try {
    const { openrouterApiKey } = await api.storage.local.get(["openrouterApiKey"]);
    if (!openrouterApiKey) return { error: "No OpenRouter API key" };
    const res = await fetch(JEV_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${openrouterApiKey}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { error: `Jev error: ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: e.message };
  }
}

async function ollamaRequest(url, options) {
  try {
    if (options.body && typeof options.body === "object") {
      options.body = JSON.stringify(options.body);
    }
    options.headers = { ...options.headers, ...(await ollamaAuthHeaders(url)) };
    const res = await fetch(url, options);
    if (res.status === 401) return { error: "Ollama API key missing or rejected" };
    if (!res.ok) return { error: `Ollama API error: ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchModels(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, { headers: await ollamaAuthHeaders(baseUrl) });
    if (res.status === 401) return { error: "API key missing or rejected" };
    if (!res.ok) return { error: `Failed to fetch models: ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: e.message };
  }
}
