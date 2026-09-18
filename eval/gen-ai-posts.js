// Generates AI LinkedIn posts via Ollama for the eval set's "ai" half.
// Topics are seeded from real human posts so both halves cover the same subjects.
// Usage: node eval/gen-ai-posts.js [--models qwen3.5:9b,deepseek-v3.2:cloud] [--count 120]
// Output: eval/data/ai-generated.jsonl

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const OLLAMA = process.env.OLLAMA_URL || "http://localhost:11434";

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const MODELS = getArg("models", "qwen3.5:9b").split(",");
const COUNT = parseInt(getArg("count", "120"), 10);

// Style variants: naive slop, humanized (the hard case), and persona-driven
const STYLES = [
  {
    key: "naive",
    prompt: (topic) => `Write an engaging LinkedIn post about: ${topic}`,
  },
  {
    key: "humanized",
    prompt: (topic) =>
      `Write a LinkedIn post about: ${topic}\n\nMake it sound completely human and casual. Avoid AI cliches, avoid em-dashes, avoid bullet lists, avoid "it's not X it's Y" phrasing. Include a small imperfection or two. Do not use hashtags.`,
  },
  {
    key: "persona",
    prompt: (topic) =>
      `You are a senior professional posting on LinkedIn. Write a post sharing a personal story or lesson related to: ${topic}\n\nWrite in first person with specific-sounding details.`,
  },
];

// Model spec "or:vendor/model" routes to OpenRouter (needs OPENROUTER_API_KEY),
// anything else to Ollama (cloud tags like gemma4:31b-cloud run on ollama.com).
async function generate(model, prompt) {
  const openrouter = model.startsWith("or:");
  const url = openrouter
    ? "https://openrouter.ai/api/v1/chat/completions"
    : `${OLLAMA}/v1/chat/completions`;
  const headers = { "Content-Type": "application/json" };
  if (openrouter) headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: openrouter ? model.slice(3) : model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.9,
      max_tokens: 2048,
    }),
  });
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "")
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^(Here['']s|Sure|Certainly)[^\n]*\n+/i, "")
    .trim();
}

async function main() {
  const humanFile = path.join(DATA_DIR, "human-linkedin.jsonl");
  if (!fs.existsSync(humanFile)) {
    console.error("Run eval/fetch-data.js first (needs human posts for topic seeds)");
    process.exit(1);
  }
  const human = fs.readFileSync(humanFile, "utf8").trim().split("\n").map(JSON.parse);

  // Topic = first sentence/line of a human post, stripped of fancy unicode
  const topics = human
    .map((h) => h.text.split("\n")[0].replace(/[^\x20-\x7E]/g, "").trim())
    .filter((t) => t.length > 20 && t.length < 200);

  const outFile = path.join(DATA_DIR, "ai-generated.jsonl");
  const out = fs.createWriteStream(outFile, { flags: "w" });
  let done = 0;

  for (let i = 0; done < COUNT; i++) {
    const topic = topics[(i * 7919) % topics.length];
    const style = STYLES[i % STYLES.length];
    const model = MODELS[i % MODELS.length];
    try {
      const text = await generate(model, style.prompt(topic));
      if (text.length < 200) continue;
      out.write(JSON.stringify({ text, label: "ai", source: `${model}/${style.key}` }) + "\n");
      done++;
      process.stdout.write(`\rgenerated ${done}/${COUNT}`);
    } catch (e) {
      console.error(`\n${e.message}`);
      if (e.message.includes("HTTP 4")) MODELS.splice(MODELS.indexOf(model), 1);
      if (!MODELS.length) process.exit(1);
    }
  }
  out.end();
  console.log(`\nwrote ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
