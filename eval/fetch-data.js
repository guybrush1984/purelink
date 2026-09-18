// Downloads evaluation data via the HuggingFace datasets-server API (no auth, no deps).
// Output: eval/data/human-linkedin.jsonl, eval/data/proxy-aigtbench.jsonl
// Each line: {"text": "...", "label": "human"|"ai", "source": "..."}

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const ROWS_API = "https://datasets-server.huggingface.co/rows";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchRows(dataset, config, split, offset, length) {
  const url = `${ROWS_API}?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=${length}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return (await res.json()).rows.map((r) => r.row);
    if (res.status === 429 && attempt < 5) {
      await sleep(15000 * (attempt + 1));
      continue;
    }
    throw new Error(`${dataset} offset=${offset}: HTTP ${res.status}`);
  }
}

async function fetchAll(dataset, config, split, total) {
  const rows = [];
  for (let offset = 0; offset < total; offset += 100) {
    rows.push(...(await fetchRows(dataset, config, split, offset, Math.min(100, total - offset))));
    process.stdout.write(`\r${dataset}: ${rows.length} rows`);
  }
  console.log();
  return rows;
}

// Preserve paragraph structure — it is itself a detection signal
const clean = (t) => (t || "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
const writeJsonl = (file, items) =>
  fs.writeFileSync(path.join(DATA_DIR, file), items.map((i) => JSON.stringify(i)).join("\n") + "\n");

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Human LinkedIn posts (real authors; caveat: recent posts could be AI-assisted)
  if (!fs.existsSync(path.join(DATA_DIR, "human-linkedin.jsonl"))) {
    const brian = await fetchAll("BrianClone/linkedin_posts", "default", "train", 1035);
    const shayan = await fetchAll("ShayanShamsi/prompt_to_linkedin_post", "default", "train", 447);

    const human = [
      ...brian.map((r) => ({ text: clean(r.text || r.post || r.content), label: "human", source: "BrianClone/linkedin_posts" })),
      ...shayan.map((r) => ({ text: clean(r.output), label: "human", source: "ShayanShamsi/prompt_to_linkedin_post" })),
    ].filter((r) => r.text.length >= 200 && r.text.length <= 4000);
    writeJsonl("human-linkedin.jsonl", human);
    console.log(`human-linkedin.jsonl: ${human.length} posts`);
  }

  // AIGTBench proxy: Medium/Quora prose, mixed human + modern-model AI
  const bench = await fetchAll("tarryzhang/AIGTBench", "default", "test", 3000);
  const proxy = bench
    .filter((r) => r.text && r.text.length >= 200 && r.text.length <= 4000)
    .map((r) => ({
      text: clean(r.text),
      label: r.label === 1 ? "ai" : "human",
      source: `AIGTBench/${r.social_media_platform || "?"}/${r.model || "human"}`,
    }));
  writeJsonl("proxy-aigtbench.jsonl", proxy);
  const aiCount = proxy.filter((r) => r.label === "ai").length;
  console.log(`proxy-aigtbench.jsonl: ${proxy.length} rows (${aiCount} ai / ${proxy.length - aiCount} human)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
