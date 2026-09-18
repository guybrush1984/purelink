// Runs the extension's Jev slop meter (src/jev-prompt.js) against a labeled dataset and
// replays the routing: Jev decides below JEV_LOW / from JEV_HIGH, the band between goes to
// Ollama. The Ollama verdicts come from a run.js results file on the same posts (--baseline).
// Usage: OPENROUTER_API_KEY=... node eval/run-jev.js [--limit 240] [--pollute] [--tag x]
//          [--files human-linkedin.jsonl,ai-generated.jsonl] [--concurrency 8]
//          [--baseline results-gemma4_31b-cloud-polluted-v43.jsonl] [--low 0.51] [--high 0.65]
// With --pollute, pair it with the polluted baseline: the live feed looks like that.

const fs = require("fs");
const path = require("path");
const { JEV_QUESTIONS, JEV_LOW, JEV_HIGH } = require("../src/jev-prompt.js");

const DATA_DIR = path.join(__dirname, "data");
const URL = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "typesafe/jev-1.13";
const MAX_TEXT = 2000;

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const FILES = getArg("files", "human-linkedin.jsonl,ai-generated.jsonl").split(",");
const LIMIT = parseInt(getArg("limit", "0"), 10);
const CONCURRENCY = parseInt(getArg("concurrency", "8"), 10);
const TAG = getArg("tag", "");
const POLLUTE = args.includes("--pollute");
const BASELINE = getArg("baseline", POLLUTE ? "results-gemma4_31b-cloud-polluted-v43.jsonl" : "results-gemma4_31b-cloud-clean-v43.jsonl");
const LOW = parseFloat(getArg("low", JEV_LOW));
const HIGH = parseFloat(getArg("high", JEV_HIGH));

// Simulates the chrome the new LinkedIn UI leaves around the body (see run.js).
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
    const res = await fetch(URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
      body: JSON.stringify({ model: MODEL, state: { post }, questions: JEV_QUESTIONS }),
    });
    if (res.ok) return res.json();
    if (!(res.status === 429 || res.status >= 500) || attempt >= 5) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    await sleep(1000 * 2 ** attempt);
  }
}

async function score(text) {
  const t0 = Date.now();
  const { answers, usage, model } = await ask(truncate(text));
  return { model, ms: Date.now() - t0, usage, p: answers.ai_written.noul, author: answers.author.probabilities };
}

// Mann-Whitney AUC: chance a random AI post outscores a random human post.
const auc = (ai, human) => {
  let wins = 0;
  for (const a of ai) for (const h of human) wins += a > h ? 1 : a === h ? 0.5 : 0;
  return wins / (ai.length * human.length);
};

const pct = (n, d) => (d ? ((n / d) * 100).toFixed(1) + "%" : "n/a");

const toBinary = (verdict) => {
  if (verdict === "DEFINITELY_AI" || verdict === "LIKELY_AI") return "ai";
  if (verdict === "DEFINITELY_HUMAN" || verdict === "LIKELY_HUMAN") return "human";
  return "uncertain";
};

function loadBaseline() {
  const file = path.join(DATA_DIR, BASELINE);
  if (!fs.existsSync(file)) return new Map();
  return new Map(fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse).map((r) => [r.text, r]));
}

function row(name, rows, pred) {
  const n = (label, p) => rows.filter((r) => r.label === label && pred(r) === p).length;
  const ai = rows.filter((r) => r.label === "ai").length;
  const human = rows.length - ai;
  console.log(
    `  ${name.padEnd(22)} AI caught ${String(n("ai", "ai")).padStart(4)}/${ai}  missed ${String(n("ai", "human")).padStart(3)}  uncertain ${String(n("ai", "uncertain")).padStart(3)}  |  ` +
      `humans flagged ${String(n("human", "ai")).padStart(4)}/${human} (${pct(n("human", "ai"), human)})  uncertain ${String(n("human", "uncertain")).padStart(3)}`
  );
}

async function main() {
  if (!process.env.OPENROUTER_API_KEY) throw new Error("Set OPENROUTER_API_KEY");
  const items = loadDataset();
  console.log(`model=${MODEL} items=${items.length} (${items.filter((i) => i.label === "ai").length} ai / ${items.filter((i) => i.label === "human").length} human)${POLLUTE ? " POLLUTED" : ""}  cut-offs <${LOW} human / ≥${HIGH} AI\n`);

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
  console.log(`${Math.round(tokens / ok.length)} tokens/post  cost $${cost.toFixed(5)} ($${(cost / ok.length).toFixed(7)}/post)`);
  errors.slice(0, 3).forEach((r) => console.log(`  error: ${r.error}`));

  const ai = ok.filter((r) => r.label === "ai");
  const human = ok.filter((r) => r.label === "human");
  console.log(`\nseparation (AUC): ai_written ${auc(ai.map((r) => r.p), human.map((r) => r.p)).toFixed(3)}   author=ai ${auc(ai.map((r) => r.author.ai), human.map((r) => r.author.ai)).toFixed(3)}`);

  const jevPred = (r) => (r.p < LOW ? "human" : r.p >= HIGH ? "ai" : "uncertain");
  const band = ok.filter((r) => jevPred(r) === "uncertain").length;
  console.log(`\n== routing: ${pct(band, ok.length)} of posts go to Ollama (${band}/${ok.length}) ==`);
  row("Jev alone (band = ?)", ok, jevPred);

  const baseline = loadBaseline();
  if (ok.every((r) => baseline.has(r.text))) {
    const base = (r) => toBinary(baseline.get(r.text).verdict);
    console.log(`\n== end to end, Ollama verdicts from ${BASELINE} ==`);
    row("Ollama alone", ok, base);
    row("Jev → Ollama", ok, (r) => (jevPred(r) === "uncertain" ? base(r) : jevPred(r)));
  } else {
    console.log(`\n(no end-to-end: ${BASELINE} does not cover these posts; use --limit 240)`);
  }

  console.log("\nper source (Jev alone: right / to Ollama / wrong):");
  for (const s of [...new Set(ok.map((r) => r.source))]) {
    const rs = ok.filter((r) => r.source === s);
    const k = (f) => rs.filter(f).length;
    console.log(`  ${s.padEnd(38)} n=${String(rs.length).padStart(4)}  ${pct(k((r) => jevPred(r) === r.label), rs.length).padStart(6)} ${pct(k((r) => jevPred(r) === "uncertain"), rs.length).padStart(6)} ${pct(k((r) => jevPred(r) !== r.label && jevPred(r) !== "uncertain"), rs.length).padStart(6)}`);
  }

  const out = path.join(DATA_DIR, `results-jev-1.13${TAG ? "-" + TAG : ""}.jsonl`);
  fs.writeFileSync(out, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\ndetails: ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
