(function () {
  "use strict";

  const POST_SELECTOR = ".feed-shared-update-v2";
  const TEXT_SELECTORS = [".feed-shared-text", ".break-words", ".feed-shared-update-v2__description", '[data-test-id="main-feed-activity-card__commentary"]'];
  const MIN_TEXT = 50;
  const VISIBILITY = 0.3;
  const DEBOUNCE = 500;

  const BADGE_LABELS = {
    DEFINITELY_HUMAN: "Human",
    LIKELY_HUMAN: "Likely Human",
    UNCERTAIN: "Uncertain",
    LIKELY_AI: "Likely AI",
    DEFINITELY_AI: "AI",
  };

  let enabled = true;
  let processed = new WeakSet();
  let pending = new WeakSet();
  let intersectionObs = null;
  let mutationObs = null;
  let debounceTimer = null;

  function extractText(post) {
    for (const sel of TEXT_SELECTORS) {
      const el = post.querySelector(sel);
      if (el) return el.innerText.trim();
    }
    return "";
  }

  async function processPost(post) {
    if (processed.has(post)) return;
    processed.add(post);
    pending.delete(post);

    const text = extractText(post);
    if (text.length < MIN_TEXT) return;

    const result = await window.detectAIContent(text);
    if (!result.verdict) return;

    const cls = "ai-verdict-" + result.verdict.toLowerCase().replace(/_/g, "-");
    post.classList.add("ai-analyzed", cls);

    const badge = document.createElement("div");
    badge.className = "ai-detected-badge ai-badge-" + result.verdict.toLowerCase().replace(/_/g, "-");
    badge.textContent = BADGE_LABELS[result.verdict] || result.verdict;
    if (result.reason) badge.title = result.reason;
    post.appendChild(badge);
  }

  function onIntersect(entries) {
    if (!enabled) return;
    for (const entry of entries) {
      const post = entry.target;
      if (entry.isIntersecting && !processed.has(post) && !pending.has(post)) {
        pending.add(post);
        setTimeout(() => pending.has(post) && processPost(post), DEBOUNCE);
      } else if (!entry.isIntersecting) {
        pending.delete(post);
      }
    }
  }

  function initIntersectionObs() {
    intersectionObs?.disconnect();
    intersectionObs = new IntersectionObserver(onIntersect, { threshold: VISIBILITY });
    document.querySelectorAll(POST_SELECTOR).forEach((p) => !processed.has(p) && intersectionObs.observe(p));
  }

  function observeNewPosts() {
    document.querySelectorAll(POST_SELECTOR).forEach((p) => !processed.has(p) && intersectionObs?.observe(p));
  }

  function initMutationObs() {
    mutationObs?.disconnect();
    mutationObs = new MutationObserver((muts) => {
      if (muts.some((m) => m.addedNodes.length)) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(observeNewPosts, 300);
      }
    });
    mutationObs.observe(document.body, { childList: true, subtree: true });
  }

  function removeHighlights() {
    document.querySelectorAll(".ai-analyzed").forEach((el) => {
      el.classList.remove("ai-analyzed", "ai-verdict-definitely-human", "ai-verdict-likely-human", "ai-verdict-uncertain", "ai-verdict-likely-ai", "ai-verdict-definitely-ai");
    });
    document.querySelectorAll(".ai-detected-badge").forEach((el) => el.remove());
  }

  function reset() {
    processed = new WeakSet();
    pending = new WeakSet();
    initIntersectionObs();
  }

  chrome.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type === "TOGGLE_ENABLED") {
      enabled = msg.enabled;
      enabled ? reset() : removeHighlights();
      respond({ success: true });
    }
    if (msg.type === "SETTINGS_UPDATED") {
      window.reloadDetectorSettings?.();
      reset();
      respond({ success: true });
    }
    if (msg.type === "GET_STATUS") {
      respond({ enabled });
    }
    return true;
  });

  async function init() {
    const saved = await chrome.storage.local.get(["enabled"]);
    enabled = saved.enabled !== false;
    setTimeout(() => {
      initMutationObs();
      initIntersectionObs();
    }, 1000);
  }

  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init();
})();
