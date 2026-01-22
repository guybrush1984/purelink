const api = typeof browser !== "undefined" ? browser : chrome;
const DEFAULT_URL = "http://localhost:11434";
const DEFAULT_MODEL = "ministral-3:14b-cloud";
const MAX_TEXT = 2000;

let settings = { ollamaUrl: DEFAULT_URL, model: DEFAULT_MODEL };

async function loadSettings() {
  const saved = await api.storage.local.get(["ollamaUrl", "model"]);
  if (saved.ollamaUrl) settings.ollamaUrl = saved.ollamaUrl;
  if (saved.model) settings.model = saved.model;
}

loadSettings();

api.storage.onChanged.addListener((changes) => {
  if (changes.ollamaUrl) settings.ollamaUrl = changes.ollamaUrl.newValue;
  if (changes.model) settings.model = changes.model.newValue;
});

async function detectAIContent(text) {
  if (!settings.model) return { error: "No model configured" };
  if (!window.DETECTION_SYSTEM_PROMPT) return { error: "System prompt not loaded" };

  const truncated = text.length > MAX_TEXT ? text.substring(0, MAX_TEXT) + "..." : text;

  try {
    const res = await api.runtime.sendMessage({
      type: "OLLAMA_REQUEST",
      url: `${settings.ollamaUrl}/v1/chat/completions`,
      options: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: {
          model: settings.model,
          messages: [
            { role: "system", content: window.DETECTION_SYSTEM_PROMPT },
            { role: "user", content: truncated },
          ],
          temperature: 0.1,
          max_tokens: 4096,
        },
      },
    });

    if (res.error) return { error: res.error };

    const content = res.data.choices?.[0]?.message?.content || "";
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { error: "Parse error" };

    const { verdict, reason } = JSON.parse(match[0]);
    const isAI = verdict === "LIKELY_AI" || verdict === "DEFINITELY_AI";

    return { verdict, reason, isAI };
  } catch (e) {
    return { error: e.message };
  }
}

window.detectAIContent = detectAIContent;
window.reloadDetectorSettings = loadSettings;
