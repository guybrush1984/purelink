const api = typeof browser !== "undefined" ? browser : chrome;
const MAX_TEXT = 2000;
const HEAD_TEXT = 1500;
const TAIL_TEXT = 500;
const LOG_MAX = 2000;

// A long post keeps its ending: the call to action lives there, and cutting it
// hid most engagement bait. Jev rejects invalid Unicode, and LinkedIn's 𝗯𝗼𝗹𝗱
// letters are surrogate pairs that a plain cut can split.
const truncate = (text) =>
  text.length > MAX_TEXT
    ? text.substring(0, HEAD_TEXT).replace(/[\uD800-\uDBFF]$/, "") +
      " […] " +
      text.slice(-TAIL_TEXT).replace(/^[\uDC00-\uDFFF]/, "")
    : text;

// Scores only, never post text: enough to see the verdict mix of your feed and
// to re-fit the cut-offs. Chained so concurrent posts don't drop entries.
let logChain = Promise.resolve();
function logResult(result, post) {
  const answers = Object.fromEntries(Object.entries(result.values).map(([q, v]) => [q, Math.round(v * 100) / 100]));
  const entry = { t: Date.now(), s: Math.round(result.score * 1000) / 1000, v: result.verdict, b: result.bait.flagged ? result.bait.kind : null, a: answers, n: post.length };
  logChain = logChain
    .then(async () => {
      const { jevLog = [] } = await api.storage.local.get(["jevLog"]);
      jevLog.push(entry);
      await api.storage.local.set({ jevLog: jevLog.slice(-LOG_MAX) });
    })
    .catch(() => {});
}

// One Jev request per post, AI and clickbait questions together; the verdict comes
// from the weighted score (jev-prompt.js). No key → { noKey }, so the badge can say so.
async function detectAIContent(text) {
  const post = truncate(text);
  try {
    const questions = { ...window.JEV_QUESTIONS, ...window.JEV_BAIT_QUESTIONS };
    const res = await api.runtime.sendMessage({ type: "JEV_REQUEST", state: { post }, questions });
    if (res.error) return { error: res.error, noKey: !!res.noKey };
    const values = window.jevValues(res.data.answers);
    const score = window.jevScore(values);
    const result = { verdict: window.jevVerdict(score), score, values, bait: window.jevBait(values) };
    logResult(result, post);
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

window.detectAIContent = detectAIContent;
