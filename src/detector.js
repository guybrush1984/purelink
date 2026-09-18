const api = typeof browser !== "undefined" ? browser : chrome;
const DEFAULT_URL = "http://localhost:11434";
const DEFAULT_MODEL = "gemma4:31b-cloud";
const JEV_MODEL = "typesafe/jev-1.13";
const MAX_TEXT = 2000;
const LOG_MAX = 2000;

let settings = { ollamaUrl: DEFAULT_URL, model: DEFAULT_MODEL, jev: false, jevLow: window.JEV_LOW, jevHigh: window.JEV_HIGH };

async function loadSettings() {
  const saved = await api.storage.local.get(["ollamaUrl", "model", "openrouterApiKey", "jevLow", "jevHigh"]);
  if (saved.ollamaUrl) settings.ollamaUrl = saved.ollamaUrl;
  if (saved.model) settings.model = saved.model;
  settings.jev = !!saved.openrouterApiKey;
  settings.jevLow = saved.jevLow ?? window.JEV_LOW;
  settings.jevHigh = saved.jevHigh ?? window.JEV_HIGH;
}

loadSettings();

api.storage.onChanged.addListener((changes) => {
  if (changes.ollamaUrl) settings.ollamaUrl = changes.ollamaUrl.newValue;
  if (changes.model) settings.model = changes.model.newValue;
  if (changes.openrouterApiKey) settings.jev = !!changes.openrouterApiKey.newValue;
  if (changes.jevLow) settings.jevLow = changes.jevLow.newValue ?? window.JEV_LOW;
  if (changes.jevHigh) settings.jevHigh = changes.jevHigh.newValue ?? window.JEV_HIGH;
});

// Jev rejects invalid Unicode, and LinkedIn's 𝗯𝗼𝗹𝗱 letters are surrogate pairs
// that a plain cut can split.
const truncate = (text) =>
  text.length > MAX_TEXT ? text.substring(0, MAX_TEXT).replace(/[\uD800-\uDBFF]$/, "") + "..." : text;

async function askJev(post) {
  const res = await api.runtime.sendMessage({
    type: "JEV_REQUEST",
    body: { model: JEV_MODEL, state: { post }, questions: window.JEV_QUESTIONS },
  });
  if (res.error) return null;
  const { ai_written, author } = res.data.answers;
  return { slop: ai_written.noul, author: author.probabilities };
}

async function askOllama(post) {
  if (!settings.model) return { error: "No model configured" };
  if (!window.DETECTION_SYSTEM_PROMPT) return { error: "System prompt not loaded" };

  // LLMs can't perceive these characters reliably; flag them in text instead
  const machineChars = post.match(/[\u2011\u202F]/g);
  const userContent = machineChars
    ? `${post}\n\n[scanner: contains ${machineChars.length}x typographic Unicode (non-breaking hyphen/narrow space) rarely typed by humans]`
    : post;

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
          { role: "user", content: userContent },
        ],
        temperature: 0.1,
        max_tokens: 4096,
        response_format: { type: "json_object" },
      },
    },
  });

  if (res.error) return { error: res.error };

  const content = res.data.choices?.[0]?.message?.content || "";
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return { error: "Parse error" };

  const { verdict, reason } = JSON.parse(match[0]);
  return { verdict, reason };
}

// Scores only, never post text: enough to see what share of the feed reaches
// Ollama and to re-fit the cut-offs. Chained so concurrent posts don't drop entries.
let logChain = Promise.resolve();
function logResult(jev, result, post) {
  const entry = { t: Date.now(), p: jev?.slop ?? null, a: jev?.author ?? null, via: result.via, v: result.verdict, n: post.length };
  logChain = logChain
    .then(async () => {
      const { jevLog = [] } = await api.storage.local.get(["jevLog"]);
      jevLog.push(entry);
      await api.storage.local.set({ jevLog: jevLog.slice(-LOG_MAX) });
    })
    .catch(() => {});
}

// Jev decides the confident ends of the scale; only the band between the
// cut-offs costs an Ollama call. Any Jev failure falls through to Ollama.
async function detectAIContent(text) {
  const post = truncate(text);
  try {
    const jev = settings.jev ? await askJev(post).catch(() => null) : null;
    const slop = jev?.slop ?? null;

    let result;
    if (jev && slop < settings.jevLow) result = { verdict: "LIKELY_HUMAN", reason: `Jev: ${Math.round(slop * 100)}% AI`, via: "jev" };
    else if (jev && slop >= settings.jevHigh) result = { verdict: "LIKELY_AI", reason: `Jev: ${Math.round(slop * 100)}% AI`, via: "jev" };
    else {
      const ollama = await askOllama(post);
      // Without Ollama, a mid-band post is exactly what UNCERTAIN means
      if (ollama.error && !jev) return ollama;
      result = ollama.error
        ? { verdict: "UNCERTAIN", reason: `Jev: ${Math.round(slop * 100)}% AI; Ollama unavailable (${ollama.error})`, via: "jev" }
        : { ...ollama, via: "ollama" };
    }

    logResult(jev, result, post);
    return { ...result, slop };
  } catch (e) {
    return { error: e.message };
  }
}

window.detectAIContent = detectAIContent;
window.reloadDetectorSettings = loadSettings;
