// Generates AI LinkedIn posts with many OpenRouter models, for the eval set's "ai" half.
// Without --models it uses every free model and can run unattended for days: paced under the
// free-model limits, sleeps through the daily cap, rests models that fail, drops models that
// never work. With --models it can run paid models under a dollar budget.
// Usage: OPENROUTER_API_KEY=... nohup node eval/gen-openrouter-posts.js [--target 3000] \
//          [--rpm 12] [--concurrency 3] [--out ai-free-models.jsonl] [--plan] > gen.log 2>&1 &
//        a few hours instead of days: ... --hours 3 (stops at the deadline or the daily cap)
//        rewrites of real human posts (AI-polished drafts): ... --drafts human-linkedin-2021.jsonl
//          [--draft-count 180] gives styles "polish" and "light"; each draft is rewritten once per style
//        paid: ... --models anthropic/claude-sonnet-5,openai/gpt-5.6-luna --per-model 10 \
//          --budget 2 --no-reasoning --max-tokens 1200 --out ai-paid-models.jsonl
// --no-reasoning asks for reasoning effort "none" and stops a model after its first response
// if it reasoned anyway (billed as output). --budget stops on OpenRouter's reported cost.
// Output: one JSON line per post, same shape as ai-generated.jsonl plus model/style/topic.
// Stop any time (kill / Ctrl-C); re-running the same command picks up where it left off.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_DIR = path.join(__dirname, "data");
const API = "https://openrouter.ai/api/v1";
const KEY = process.env.OPENROUTER_API_KEY;

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const TARGET = parseInt(getArg("target", "3000"), 10);
const PER_MODEL = parseInt(getArg("per-model", "0"), 10); // overrides --target
const BUDGET = parseFloat(getArg("budget", "Infinity")); // USD, from each response's usage.cost
const MAX_TOKENS = parseInt(getArg("max-tokens", "4000"), 10); // free reasoning models need room
const NO_REASONING = args.includes("--no-reasoning");
const DRAFTS = getArg("drafts", ""); // human posts to rewrite instead of topics to write about
const DRAFT_COUNT = parseInt(getArg("draft-count", "180"), 10);
const DEADLINE = Date.now() + parseFloat(getArg("hours", "Infinity")) * 3600e3; // stop cleanly, never sleep past it
const RPM = parseFloat(getArg("rpm", "12")); // free tier allows ~20/min; stay well under
const CONCURRENCY = parseInt(getArg("concurrency", "3"), 10);
const ONLY = getArg("models", "");
const OUT = path.join(DATA_DIR, getArg("out", "ai-free-models.jsonl"));
const PLAN = args.includes("--plan");
const TIMEOUT_MS = 120000;
const MAX_FAILS = 6; // consecutive errors before a model is dropped
const MAX_REJECTS = 4; // consecutive unusable outputs before a model is dropped
const SKIP = /content-safety|guard|embed/i; // classifiers, not writers

// Same three styles as gen-ai-posts.js: naive slop, humanized (the hard case), persona.
const STYLES = {
  naive: (topic) => `Write an engaging LinkedIn post about: ${topic}`,
  humanized: (topic) =>
    `Write a LinkedIn post about: ${topic}\n\nMake it sound completely human and casual. Avoid AI cliches, avoid em-dashes, avoid bullet lists, avoid "it's not X it's Y" phrasing. Include a small imperfection or two. Do not use hashtags.`,
  persona: (topic) =>
    `You are a senior professional posting on LinkedIn. Write a post sharing a personal story or lesson related to: ${topic}\n\nWrite in first person with specific-sounding details.`,
};

// A person's own post, rewritten by AI: heavy polish, or a light edit that keeps their voice.
const REWRITE_STYLES = {
  polish: (draft) => `Improve this LinkedIn post. Make it more engaging and professional. Reply with only the rewritten post.\n\n${draft}`,
  light: (draft) => `Fix any grammar or typos in my LinkedIn post and tighten it slightly. Keep my voice and structure. Reply with only the rewritten post.\n\n${draft}`,
};

// Drafts spread across authors (round-robin over authors, fixed shuffle), 300-2000 chars.
function loadDrafts() {
  const rows = fs.readFileSync(path.join(DATA_DIR, DRAFTS), "utf8").trim().split("\n").map(JSON.parse)
    .filter((r) => r.text.length >= 300 && r.text.length <= 2000);
  const byAuthor = {};
  // k: hash of the text, a stable id that also gives a fixed pseudo-random order within each author
  rows.forEach((r) => (byAuthor[r.author] ||= []).push({ ...r, k: crypto.createHash("sha1").update(r.text).digest("hex").slice(0, 16) }));
  const queues = Object.values(byAuthor).map((q) => q.sort((a, b) => (a.k < b.k ? -1 : 1)));
  const picked = [];
  for (let round = 0; picked.length < DRAFT_COUNT && queues.some((q) => q.length > round); round++)
    for (const q of queues) if (q[round] && picked.length < DRAFT_COUNT) picked.push(q[round]);
  return picked;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().slice(5, 19).replace("T", " ");
const log = (msg) => console.log(`[${stamp()}] ${msg}`);

async function freeModels() {
  const res = await fetch(`${API}/models`);
  const { data } = await res.json();
  return data
    .filter((m) => m.id.endsWith(":free") && !SKIP.test(m.id))
    .filter((m) => (m.architecture?.output_modalities || ["text"]).includes("text"))
    .map((m) => m.id)
    .sort();
}

async function dailyQuota() {
  try {
    const res = await fetch(`${API}/key`, { headers: { Authorization: `Bearer ${KEY}` } });
    return (await res.json()).data?.free_model_daily_requests || null;
  } catch {
    return null;
  }
}

// Topics are seeded from real human posts so both halves of the eval cover the same subjects.
function loadTopics() {
  const human = fs.readFileSync(path.join(DATA_DIR, "human-linkedin.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  return human
    .map((h) => h.text.split("\n")[0].replace(/[^\x20-\x7E]/g, "").trim())
    .filter((t) => t.length > 20 && t.length < 200);
}

function loadDone() {
  if (!fs.existsSync(OUT)) return [];
  return fs.readFileSync(OUT, "utf8").split("\n").filter(Boolean).map(JSON.parse);
}

// Drops reasoning tags, a leading "Here's..." line, and the notes models append after a rewrite
// ("Key changes: ..."), which a person would not paste into LinkedIn.
function clean(text) {
  const t = (text || "").replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^(Here['’]s|Sure|Certainly)[^\n]*\n+/i, "");
  if (!DRAFTS) return t.trim();
  return t
    .replace(/^\s*---+\s*\n+/, "")
    .replace(/^\*{0,2}(improved|revised|polished|edited) (version|post)\*{0,2}:?\*{0,2}\s*\n+/i, "")
    .replace(/\n+(---+\s*\n+)?\**(key changes|what i changed|changes made|notes?|why this works)\b[\s\S]*$/i, "")
    .replace(/\n---+\s*$/, "")
    .trim();
}

// Why an output is unusable, or null when it is a post.
function reject(text, finish) {
  if (text.length < 200) return `too short (${text.length} chars, finish=${finish})`;
  if (/^(I['’]m sorry|I am sorry|I can(no|['’])t|As an AI)/i.test(text)) return "refusal";
  if (/<\/?think>/.test(text)) return "unclosed reasoning";
  return null;
}

async function generate(model, prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.9,
        max_tokens: MAX_TOKENS,
        reasoning: NO_REASONING ? { effort: "none" } : { exclude: true },
      }),
    });
    const body = await res.json().catch(() => ({}));
    return { status: res.status, headers: res.headers, body };
  } catch (e) {
    return { status: 0, error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  if (!KEY) throw new Error("Set OPENROUTER_API_KEY");
  const models = ONLY ? ONLY.split(",") : await freeModels();
  const topics = DRAFTS ? [] : loadTopics();
  const drafts = DRAFTS ? loadDrafts() : [];
  if (DRAFTS) Object.keys(STYLES).forEach((k) => delete STYLES[k]), Object.assign(STYLES, REWRITE_STYLES);
  const done = loadDone();
  const styles = Object.keys(STYLES);
  const quota = PER_MODEL || Math.ceil((DRAFTS ? drafts.length * styles.length : TARGET) / models.length);

  // One state per model: posts written per style, failure streaks, cooldown, drop reason.
  const state = Object.fromEntries(models.map((m) => [m, { count: Object.fromEntries(styles.map((s) => [s, 0])), fails: 0, busy: 0, rejects: 0, until: 0, dead: null, checked: !NO_REASONING, inflight: 0 }]));
  for (const d of done) if (state[d.model]?.count[d.style] !== undefined) state[d.model].count[d.style]++;
  const used = new Set(done.map((d) => (DRAFTS ? `${d.style}|${d.draft_key}` : `${d.model}|${d.topic}`)));
  const posts = (m) => styles.reduce((n, s) => n + state[m].count[s], 0);
  const total = () => models.reduce((n, m) => n + Math.min(posts(m), quota), 0);
  const goal = models.length * quota;
  let spent = 0;

  const daily = await dailyQuota();
  log(`${models.length} models, ${quota} posts each (styles balanced), goal ${goal}; already have ${total()}`);
  log(`pace ${RPM}/min, ${CONCURRENCY} in flight, max_tokens ${MAX_TOKENS}, reasoning ${NO_REASONING ? "off" : "hidden"}, budget ${BUDGET === Infinity ? "none" : "$" + BUDGET}`);
  log(`free-model quota today: ${daily ? `${daily.remaining}/${daily.limit}` : "unknown"}; output ${OUT}`);
  if (PLAN) return models.forEach((m) => log(`  ${m.padEnd(52)} ${posts(m)}/${quota}  ${styles.map((s) => `${s} ${state[m].count[s]}`).join("  ")}`));

  let stopping = false;
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { stopping = true; log(`${sig}: finishing requests in flight, then stopping`); });

  let nextSlot = 0; // global pacer: one request start every 60/RPM seconds
  let pausedUntil = 0; // set by OpenRouter's own 429s (per-minute or daily cap)
  let rr = 0;
  let requests = 0;

  // Next model and style with work left, round-robin, skipping resting and dropped models.
  const pick = () => {
    for (let i = 0; i < models.length; i++) {
      const m = models[(rr + i) % models.length];
      const st = state[m];
      if (st.dead || st.until > Date.now()) continue;
      if (posts(m) + st.inflight >= quota) continue;
      if (!st.checked && st.inflight) continue; // first answer must prove it did not reason
      const style = styles.reduce((a, b) => (st.count[b] < st.count[a] ? b : a)); // keep styles balanced
      rr = (rr + i + 1) % models.length;
      return { model: m, style };
    }
    return null;
  };
  // Rewrite mode: each draft gets one rewrite per style, from whichever model is free.
  const draftFor = (style) => drafts.find((d) => !used.has(`${style}|${d.k}`));
  const topicFor = (model, style) => {
    let k = (model.length * 7919 + style.length * 104729 + state[model].count[style] * 15485863) % topics.length;
    while (used.has(`${model}|${topics[k]}`)) k = (k + 1) % topics.length;
    return topics[k];
  };
  // Errors count toward dropping a model; a busy provider only rests it, since popular free
  // models are rate-limited upstream all the time and recover.
  const rest = (m, why, busy) => {
    const st = state[m];
    const streak = busy ? ++st.busy : ++st.fails;
    if (!busy && st.fails >= MAX_FAILS) return (st.dead = why), log(`drop ${m}: ${why} (${st.fails} in a row)`);
    const ms = Math.min(30 * 60e3, 60e3 * 2 ** (streak - 1));
    st.until = Date.now() + ms;
    log(`rest ${m} ${Math.round(ms / 1000)}s: ${why}`);
  };

  const worker = async () => {
    while (!stopping) {
      const wait = Math.max(pausedUntil, nextSlot) - Date.now();
      if (wait > 0) {
        await sleep(Math.min(wait, 5000));
        continue;
      }
      if (Date.now() >= DEADLINE) {
        if (!stopping) log(`--hours deadline reached; stopping`);
        stopping = true;
        continue;
      }
      if (spent >= BUDGET) {
        if (!stopping) log(`budget reached: $${spent.toFixed(4)} of $${BUDGET}; stopping`);
        stopping = true;
        continue;
      }
      const job = pick();
      if (!job) {
        if (models.every((m) => state[m].dead || posts(m) >= quota)) return;
        await sleep(5000); // everything left is resting
        continue;
      }
      nextSlot = Date.now() + 60000 / RPM;
      const { model, style } = job;
      const draft = DRAFTS ? draftFor(style) : null;
      if (DRAFTS && !draft) {
        state[model].dead = "no drafts left for this style";
        continue;
      }
      const topic = DRAFTS ? null : topicFor(model, style);
      used.add(DRAFTS ? `${style}|${draft.k}` : `${model}|${topic}`);
      const t0 = Date.now();
      const st = state[model];
      st.inflight++;
      const r = await generate(model, STYLES[style](DRAFTS ? draft.text : topic));
      st.inflight--;
      requests++;
      const secs = ((Date.now() - t0) / 1000).toFixed(1);

      if (r.status === 200 && !r.body.choices?.length) {
        rest(model, `200 without a post: ${(r.body.error?.message || "empty body").slice(0, 120)}`);
        continue;
      }
      const cost = r.body?.usage?.cost || 0;
      const reasoned = r.body?.usage?.completion_tokens_details?.reasoning_tokens || 0;
      spent += cost;
      if (r.status === 200) st.checked = true;
      if (NO_REASONING && reasoned > 0 && !st.dead) {
        st.dead = `reasoned despite effort "none" (${reasoned} reasoning tokens, $${cost.toFixed(4)})`;
        log(`drop ${model} after this response: ${st.dead}`);
      }
      if (r.status === 200) {
        const choice = r.body.choices[0];
        const text = clean(choice?.message?.content);
        const why = reject(text, choice?.finish_reason);
        if (why) {
          st.rejects++;
          log(`skip ${model}/${style}: ${why} (${secs}s)`);
          if (st.rejects >= MAX_REJECTS) (st.dead = `unusable output: ${why}`), log(`drop ${model}: ${MAX_REJECTS} unusable outputs in a row`);
          continue;
        }
        st.fails = 0;
        st.busy = 0;
        st.rejects = 0;
        st.count[style]++;
        const origin = DRAFTS ? { draft_key: draft.k, author: draft.author, draft_source: draft.source } : { topic };
        fs.appendFileSync(OUT, JSON.stringify({ text, label: "ai", source: `or:${model}/${style}`, model, style, ...origin, finish: choice?.finish_reason, cost, out_tokens: r.body.usage?.completion_tokens }) + "\n");
        log(`ok   ${model}/${style} ${text.length} chars ${secs}s $${cost.toFixed(5)}  [${total()}/${goal}, $${spent.toFixed(4)} spent]`);
        continue;
      }

      const err = r.body?.error || {};
      const msg = `${r.status} ${(err.message || r.error || "").slice(0, 120)}`;
      if (r.status === 429) {
        const remaining = r.headers.get("x-ratelimit-remaining");
        const reset = parseInt(r.headers.get("x-ratelimit-reset") || "0", 10);
        const retry = parseInt(r.headers.get("retry-after") || "0", 10);
        if (err.metadata?.provider_code || /provider|upstream/i.test(err.message || "")) {
          rest(model, "provider busy (429 upstream)", true);
        } else if (remaining === "0" && /day/i.test(err.message || "")) {
          pausedUntil = (reset || Date.now() + 3600e3) + 60e3;
          if (pausedUntil > DEADLINE) {
            log(`daily free-model cap reached; resets after the --hours deadline, so stopping`);
            stopping = true;
            continue;
          }
          log(`daily free-model cap reached; sleeping until ${new Date(pausedUntil).toISOString()}`);
        } else {
          pausedUntil = Date.now() + (retry ? retry * 1000 : 60e3);
          log(`OpenRouter rate limit (${msg}); pausing ${Math.round((pausedUntil - Date.now()) / 1000)}s`);
        }
        continue;
      }
      if (r.status === 401 || r.status === 402) {
        log(`${msg}; stopping (key rejected, out of credits, or over the key's spending limit)`);
        stopping = true;
        continue;
      }
      // The same request can never succeed: no endpoint, agent-only, or mandatory reasoning.
      if (r.status === 400 || r.status === 403 || r.status === 404) {
        state[model].dead = msg;
        log(`drop ${model}: ${msg}`);
        continue;
      }
      rest(model, msg);
    }
  };

  // Heartbeat: progress, quota, and which models are resting or dropped.
  const beat = setInterval(async () => {
    const q = await dailyQuota();
    const dead = models.filter((m) => state[m].dead);
    const resting = models.filter((m) => !state[m].dead && state[m].until > Date.now());
    log(`status ${total()}/${goal} posts, ${requests} requests; quota ${q ? `${q.remaining}/${q.limit}` : "?"}; resting ${resting.length}, dropped ${dead.length}`);
  }, 10 * 60e3);

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  clearInterval(beat);
  log(`done: ${total()}/${goal} posts from ${requests} requests, $${spent.toFixed(4)} spent`);
  for (const m of models) log(`  ${m.padEnd(52)} ${styles.map((s) => `${s} ${state[m].count[s]}`).join("  ")}${state[m].dead ? `  DROPPED: ${state[m].dead}` : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
