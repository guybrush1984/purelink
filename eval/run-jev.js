// Runs the extension's Jev detector (src/jev-prompt.js: 13 questions in one request,
// weighted score, verdict cuts) against a labeled dataset.
// Usage: TYPESAFE_API_KEY=... node eval/run-jev.js [--limit 240] [--pollute] [--tag x]
//          [--files human-linkedin-2021.jsonl,ai-paid-models-2.jsonl] [--concurrency 8]
// TYPESAFE_API_KEY calls api.typesafe.ai; otherwise OPENROUTER_API_KEY calls OpenRouter.
// --pollute wraps each post in LinkedIn chrome, as the new feed's innerText arrives.

const fs = require("fs");
const path = require("path");
const { JEV_QUESTIONS, JEV_CUTS, jevValues, jevScore, jevVerdict } = require("../src/jev-prompt.js");

const DATA_DIR = path.join(__dirname, "data");
const ROUTE = process.env.TYPESAFE_API_KEY
  ? { url: "https://api.typesafe.ai/v1/systemone", model: "jev-1.13.0", key: process.env.TYPESAFE_API_KEY }
  : { url: "https://openrouter.ai/api/alpha/decisions", model: "typesafe/jev-1.13", key: process.env.OPENROUTER_API_KEY };
const MAX_TEXT = 2000;

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const FILES = getArg("files", "human-linkedin-2021.jsonl,ai-paid-models-2.jsonl").split(",");
const LIMIT = parseInt(getArg("limit", "0"), 10);
const CONCURRENCY = parseInt(getArg("concurrency", "8"), 10);
const TAG = getArg("tag", "");
const POLLUTE = args.includes("--pollute");

// Simulates the chrome the new LinkedIn UI leaves around the body (see run.js).
const POLLUTE_HEADERS = [
  "Jane Doe\nSenior Tech & Innovation Advisor | Former Dean EPITA\n• 1st\n2h • Edited\n",
  "Marc Dubois\nDirecteur Général chez Acme | Conférencier & Investisseur\n• 2e\n5 h • Modifié\n",
  "Priya Nair\nBuilding AI-driven operational systems that make humans faster\n• 3rd+\n1d\n",
  "Sophie Laurent\nDirectrice adjointe de la communication RMC BFM\n• 1er\n3 h\n",
];
const POLLUTE_FOOTERS = [
  "\n… more\n\nLike  Comment  Repost  Send\n342 reactions · 28 comments · 7 reposts",
  "\n… plus\n\nJ'aime  Commenter  Republier  Envoyer\n1 204 réactions · 87 commentaires",
  "\n… more\n\nActivate to view larger image\nLike  Comment  Repost  Send\n56 reactions",
];
const pollute = (text, i) =>
  POLLUTE_HEADERS[i % POLLUTE_HEADERS.length] + text + POLLUTE_FOOTERS[i % POLLUTE_FOOTERS.length];

// Same cut as detector.js, including the dangling-surrogate strip Jev needs.
const truncate = (text) =>
  text.length > MAX_TEXT ? text.substring(0, MAX_TEXT).replace(/[\uD800-\uDBFF]$/, "") + "..." : text;

// Balanced pick mirrors run.js so --limit selects the same posts as its results files.
function loadDataset() {
  const items = [];
  for (const f of FILES) {
    const file = path.isAbsolute(f) ? f : path.join(DATA_DIR, f);
    items.push(...fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse));
  }
  if (!LIMIT) return items;
  const byLabel = { human: [], ai: [] };
  items.forEach((i) => byLabel[i.label]?.push(i));
  const pick = (arr, n) => {
    const step = Math.max(1, Math.floor(arr.length / n));
    return arr.filter((_, idx) => idx % step === 0).slice(0, n);
  };
  return [...pick(byLabel.human, Math.ceil(LIMIT / 2)), ...pick(byLabel.ai, Math.floor(LIMIT / 2))];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ask(post) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(ROUTE.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${ROUTE.key}` },
      body: JSON.stringify({ model: ROUTE.model, state: { post }, questions: JEV_QUESTIONS }),
    });
    if (res.ok) return res.json();
    if (!(res.status === 429 || res.status >= 500) || attempt >= 5) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await sleep(1000 * 2 ** attempt);
  }
}

async function score(text) {
  const t0 = Date.now();
  const { answers, usage, model } = await ask(truncate(text));
  const values = jevValues(answers);
  const s = jevScore(values);
  return { model, ms: Date.now() - t0, usage, values, score: s, verdict: jevVerdict(s) };
}

// Mann-Whitney AUC: chance a random AI post outscores a random human post.
const auc = (ai, human) => {
  let wins = 0;
  for (const a of ai) for (const h of human) wins += a > h ? 1 : a === h ? 0.5 : 0;
  return wins / (ai.length * human.length);
};

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + "%" : "n/a");
const VERDICTS = JEV_CUTS.map((c) => c.verdict);

async function main() {
  if (!ROUTE.key) throw new Error("Set TYPESAFE_API_KEY or OPENROUTER_API_KEY");
  const items = loadDataset();
  console.log(`${ROUTE.model} via ${new URL(ROUTE.url).host}  items=${items.length} (${items.filter((i) => i.label === "ai").length} ai / ${items.filter((i) => i.label === "human").length} human)${POLLUTE ? " POLLUTED" : ""}\n`);

  const results = [];
  let next = 0;
  const t0 = Date.now();
  const worker = async () => {
    while (next < items.length) {
      const idx = next++;
      const item = items[idx];
      try {
        results.push({ ...item, ...(await score(POLLUTE ? pollute(item.text, idx) : item.text)) });
      } catch (e) {
        results.push({ ...item, error: e.message });
      }
      process.stdout.write(`\r${results.length}/${items.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const ok = results.filter((r) => !r.error);
  const errors = results.filter((r) => r.error);
  const tokens = ok.reduce((s, r) => s + (r.usage?.input_tokens || 0), 0);
  const cost = ok.reduce((s, r) => s + (r.usage?.cost || 0), 0);
  const median = ok.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(ok.length / 2)];
  console.log(`\n\nanswered by ${ok[0]?.model}  ok=${ok.length} errors=${errors.length}  wall ${((Date.now() - t0) / 1000).toFixed(0)}s  median ${median}ms`);
  console.log(`${Math.round(tokens / ok.length)} tokens/post${cost ? `  cost $${cost.toFixed(5)} ($${(cost / ok.length).toFixed(7)}/post)` : ""}`);
  errors.slice(0, 3).forEach((r) => console.log(`  error: ${r.error}`));

  const ai = ok.filter((r) => r.label === "ai");
  const human = ok.filter((r) => r.label === "human");
  console.log(`\nseparation (AUC): score ${auc(ai.map((r) => r.score), human.map((r) => r.score)).toFixed(3)}   ai_written alone ${auc(ai.map((r) => r.values.ai_written), human.map((r) => r.values.ai_written)).toFixed(3)}`);

  const flagged = (rs, from) => rs.filter((r) => VERDICTS.indexOf(r.verdict) <= VERDICTS.indexOf(from)).length;
  // Humans by dataset, AI by writing style (naive, persona, humanized, polish, light)
  const group = (r) => (r.label === "ai" ? `AI, ${r.style || r.source.split("/").pop()}` : r.source);
  console.log(`\n${"source".padEnd(40)}     n  ${VERDICTS.map((v) => v.replace("_", " ").toLowerCase().padStart(16)).join("")}`);
  for (const s of [...new Set(ok.map(group))].sort()) {
    const rs = ok.filter((r) => group(r) === s);
    console.log(`${s.slice(0, 40).padEnd(40)} ${String(rs.length).padStart(5)}  ${VERDICTS.map((v) => pct(rs.filter((r) => r.verdict === v).length, rs.length).padStart(16)).join("")}`);
  }
  for (const [name, from] of [["Likely AI or AI", "LIKELY_AI"], ["Uncertain or above", "UNCERTAIN"]]) {
    console.log(`\n${name}: AI caught ${pct(flagged(ai, from), ai.length)}  humans flagged ${pct(flagged(human, from), human.length)}`);
  }

  const out = path.join(DATA_DIR, `results-jev-1.13${TAG ? "-" + TAG : ""}.jsonl`);
  fs.writeFileSync(out, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\ndetails: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
