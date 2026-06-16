// Runs the extension's detection prompt against a labeled dataset via Ollama.
// Usage: node eval/run.js --files human-linkedin.jsonl,ai-generated.jsonl \
//          [--model qwen3.5:9b] [--limit 100] [--concurrency 3]
// Labels: "human" | "ai". UNCERTAIN verdicts are reported separately.

const fs = require("fs");
const path = require("path");
const { DETECTION_SYSTEM_PROMPT } = require("../src/prompt.js");

const DATA_DIR = path.join(__dirname, "data");
const OLLAMA = process.env.OLLAMA_URL || "http://localhost:11434";
const MAX_TEXT = 2000;

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MODEL = getArg("model", "qwen3.5:9b");
const FILES = getArg("files", "human-linkedin.jsonl,ai-generated.jsonl").split(",");
const LIMIT = parseInt(getArg("limit", "0"), 10);
const CONCURRENCY = parseInt(getArg("concurrency", "3"), 10);
const REASONING = getArg("reasoning", "");
const TAG = getArg("tag", "");
const OUTPUT = getArg("output", "json"); // json | json-min | label | digit
const POLLUTE = args.includes("--pollute"); // wrap posts in author header + UI chrome

// Simulates the noise the new LinkedIn UI leaves around the body (author name +
// headline + connection degree + timestamp before, social actions + counts after).
// Bilingual on purpose — the target feed is French.
const POLLUTE_HEADERS = [
  "Jane Doe\nSenior Tech & Innovation Advisor | Former Dean EPITA\n• 1st\n2h • Edited\n",
  "Marc Dubois\nDirecteur Général chez Acme | Conférencier & Investisseur\n• 2e\n5 h • Modifié\n",
  "Priya Nair\nBuilding AI-driven operational systems that make humans faster\n• 3rd+\n1d\n",
  "Sophie Laurent\nDirectrice adjointe de la communication RMC BFM\n• 1er\n3 h\n",
];
const POLLUTE_FOOTERS = [
  "\n\nLike  Comment  Repost  Send\n342 reactions · 28 comments · 7 reposts",
  "\n\nJ'aime  Commenter  Republier  Envoyer\n1 204 réactions · 87 commentaires",
  "\n\nActivate to view larger image\nLike  Comment  Repost  Send\n56 reactions",
];
const pollute = (text, i) =>
  POLLUTE_HEADERS[i % POLLUTE_HEADERS.length] + text + POLLUTE_FOOTERS[i % POLLUTE_FOOTERS.length];

const OUTPUT_SPECS = {
  "json": null, // use the prompt's own output section
  "json-min": 'Respond with ONLY valid JSON, no other text:\n{"verdict": "<DEFINITELY_HUMAN|LIKELY_HUMAN|UNCERTAIN|LIKELY_AI|DEFINITELY_AI>"}',
  "label": "Respond with ONLY the verdict label and nothing else:\nDEFINITELY_HUMAN, LIKELY_HUMAN, UNCERTAIN, LIKELY_AI or DEFINITELY_AI",
  "digit": "Respond with ONLY a single digit and nothing else:\n1 = DEFINITELY_HUMAN, 2 = LIKELY_HUMAN, 3 = UNCERTAIN, 4 = LIKELY_AI, 5 = DEFINITELY_AI",
};
const DIGIT_VERDICTS = [, "DEFINITELY_HUMAN", "LIKELY_HUMAN", "UNCERTAIN", "LIKELY_AI", "DEFINITELY_AI"];
const SYSTEM_PROMPT = OUTPUT_SPECS[OUTPUT]
  ? DETECTION_SYSTEM_PROMPT.replace(/Respond with ONLY valid JSON[\s\S]*$/, OUTPUT_SPECS[OUTPUT])
  : DETECTION_SYSTEM_PROMPT;

async function classify(text) {
  const truncated = text.length > MAX_TEXT ? text.substring(0, MAX_TEXT) + "..." : text;
  // Mirrors detector.js: flag machine-typographic chars the LLM can't perceive
  const machineChars = truncated.match(/[\u2011\u202F]/g);
  const userContent = machineChars
    ? `${truncated}\n\n[scanner: contains ${machineChars.length}x typographic Unicode (non-breaking hyphen/narrow space) rarely typed by humans]`
    : truncated;
  const res = await fetch(`${OLLAMA}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      temperature: 0.1,
      max_tokens: 4096,
      ...(OUTPUT.startsWith("json") && { response_format: { type: "json_object" } }),
      ...(REASONING && { reasoning_effort: REASONING }),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const content = (await res.json()).choices?.[0]?.message?.content || "";
  if (OUTPUT === "digit") {
    const d = content.match(/[1-5]/);
    return { verdict: d ? DIGIT_VERDICTS[+d[0]] : "PARSE_ERROR" };
  }
  if (OUTPUT === "label") {
    const l = content.match(/DEFINITELY_HUMAN|LIKELY_HUMAN|UNCERTAIN|LIKELY_AI|DEFINITELY_AI/);
    return { verdict: l ? l[0] : "PARSE_ERROR" };
  }
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: "PARSE_ERROR" };
  try {
    return JSON.parse(match[0]);
  } catch {
    return { verdict: "PARSE_ERROR" };
  }
}

function loadDataset() {
  let items = [];
  for (const f of FILES) {
    const file = path.isAbsolute(f) ? f : path.join(DATA_DIR, f);
    items.push(...fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse));
  }
  if (!LIMIT) return items;
  // Balanced sample: LIMIT/2 per label, deterministic spread
  const byLabel = { human: [], ai: [] };
  items.forEach((i) => byLabel[i.label]?.push(i));
  const pick = (arr, n) => {
    const step = Math.max(1, Math.floor(arr.length / n));
    return arr.filter((_, idx) => idx % step === 0).slice(0, n);
  };
  return [...pick(byLabel.human, Math.ceil(LIMIT / 2)), ...pick(byLabel.ai, Math.floor(LIMIT / 2))];
}

const toBinary = (verdict) => {
  if (verdict === "DEFINITELY_AI" || verdict === "LIKELY_AI") return "ai";
  if (verdict === "DEFINITELY_HUMAN" || verdict === "LIKELY_HUMAN") return "human";
  return "uncertain";
};

async function main() {
  const items = loadDataset();
  console.log(`model=${MODEL} items=${items.length} (${items.filter((i) => i.label === "ai").length} ai / ${items.filter((i) => i.label === "human").length} human)\n`);

  const results = [];
  let next = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (next < items.length) {
      const idx = next;
      const item = items[next++];
      try {
        const { verdict, reason } = await classify(POLLUTE ? pollute(item.text, idx) : item.text);
        results.push({ ...item, verdict, reason, pred: toBinary(verdict) });
      } catch (e) {
        results.push({ ...item, verdict: "ERROR", pred: "uncertain", error: e.message });
      }
      process.stdout.write(`\r${results.length}/${items.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`  (${((Date.now() - t0) / results.length / 1000).toFixed(1)}s/post)\n`);

  const count = (label, pred) => results.filter((r) => r.label === label && r.pred === pred).length;
  const matrix = {
    "ai → ai (hit)": count("ai", "ai"),
    "ai → uncertain": count("ai", "uncertain"),
    "ai → human (miss)": count("ai", "human"),
    "human → human (hit)": count("human", "human"),
    "human → uncertain": count("human", "uncertain"),
    "human → ai (FALSE POSITIVE)": count("human", "ai"),
  };
  console.table(matrix);

  const decided = results.filter((r) => r.pred !== "uncertain");
  const correct = decided.filter((r) => r.pred === r.label).length;
  const humans = results.filter((r) => r.label === "human");
  console.log(`accuracy (decided): ${((correct / decided.length) * 100).toFixed(1)}% on ${decided.length}`);
  console.log(`strict accuracy (uncertain=wrong): ${((correct / results.length) * 100).toFixed(1)}%`);
  console.log(`false positive rate on humans: ${((count("human", "ai") / humans.length) * 100).toFixed(1)}%`);

  const bySource = {};
  results.forEach((r) => {
    const s = (bySource[r.source] ||= { n: 0, hit: 0 });
    s.n++;
    if (r.pred === r.label) s.hit++;
  });
  console.log("\nper source:");
  Object.entries(bySource).forEach(([s, { n, hit }]) =>
    console.log(`  ${s}: ${hit}/${n} (${((hit / n) * 100).toFixed(0)}%)`)
  );

  const ts = path.join(DATA_DIR, `results-${MODEL.replace(/[:/]/g, "_")}${TAG ? "-" + TAG : ""}.jsonl`);
  fs.writeFileSync(ts, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\ndetails: ${ts}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
