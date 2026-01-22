const HEADER_RULES = [
  { id: 1, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "remove" }] }, condition: { urlFilter: "||localhost", resourceTypes: ["xmlhttprequest"] } },
  { id: 2, priority: 1, action: { type: "modifyHeaders", requestHeaders: [{ header: "Origin", operation: "remove" }] }, condition: { urlFilter: "||127.0.0.1", resourceTypes: ["xmlhttprequest"] } },
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [1, 2], addRules: HEADER_RULES });
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (msg.type === "OLLAMA_REQUEST") {
    ollamaRequest(msg.url, msg.options).then(respond);
    return true;
  }
  if (msg.type === "OLLAMA_FETCH_MODELS") {
    fetchModels(msg.url).then(respond);
    return true;
  }
});

async function ollamaRequest(url, options) {
  try {
    if (options.body && typeof options.body === "object") {
      options.body = JSON.stringify(options.body);
    }
    const res = await fetch(url, options);
    if (!res.ok) return { error: `Ollama API error: ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: e.message };
  }
}

async function fetchModels(baseUrl) {
  try {
    const res = await fetch(`${baseUrl}/api/tags`);
    if (!res.ok) return { error: `Failed to fetch models: ${res.status}` };
    return { data: await res.json() };
  } catch (e) {
    return { error: e.message };
  }
}
