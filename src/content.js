(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;
  // Classic desktop UI + Lite UI: semantic selectors
  const POST_SELECTOR = '.feed-shared-update-v2, [data-test-id="main-feed-activity-card"]';
  const TEXT_SELECTORS = ['[data-test-id="main-feed-activity-card__commentary"]', ".attributed-text-segment-list__content", ".feed-shared-text", ".feed-shared-update-v2__description", ".break-words"];
  // New RSC UI ("flagship-web"): only hashed class names. Posts are anonymous
  // UUID-keyed components, matched structurally; comments are keyed separately.
  const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
  const COMMENT_SELECTOR = '[componentkey^="replaceableComment"]';
  const MIN_POST_TEXT = 150;
  const MIN_TEXT = 50;
  const VISIBILITY = 0.3;
  const DEBOUNCE = 500;

  const VERDICT_CLASSES = ["ai-verdict-definitely-human", "ai-verdict-likely-human", "ai-verdict-uncertain", "ai-verdict-likely-ai", "ai-verdict-definitely-ai"];
  const BADGE_LABELS = {
    DEFINITELY_HUMAN: "Human",
    LIKELY_HUMAN: "Likely Human",
    UNCERTAIN: "Uncertain",
    LIKELY_AI: "Likely AI",
    DEFINITELY_AI: "AI",
  };

  let enabled = true;
  let processed = new WeakSet(); // classified — verdict shown
  let scheduled = new WeakSet(); // debounce timer armed
  let intersectionObs = null;
  let mutationObs = null;
  let debounceTimer = null;

  function findPosts() {
    const classic = document.querySelectorAll(POST_SELECTOR);
    if (classic.length) return [...classic];

    const candidates = [...document.querySelectorAll("main [componentkey]")].filter(
      (e) => UUID_KEY.test(e.getAttribute("componentkey")) && (e.innerText || "").length >= MIN_POST_TEXT
    );
    // One element per post: drop multi-post wrappers, keep outermost of same-key nests
    const key = (e) => e.getAttribute("componentkey");
    return candidates.filter(
      (e) =>
        !candidates.some((o) => o !== e && e.contains(o) && key(o) !== key(e)) &&
        !candidates.some((o) => o !== e && o.contains(e) && key(o) === key(e))
    );
  }

  function extractText(post) {
    for (const sel of TEXT_SELECTORS) {
      const el = post.querySelector(sel);
      if (el) return el.innerText.trim();
    }
    // Hashed-class UI: no body selector. Take the whole card, minus embedded
    // comments — other people's writing would skew the verdict.
    let text = post.innerText || "";
    post.querySelectorAll(COMMENT_SELECTOR).forEach((c) => {
      const ct = c.innerText || "";
      if (ct.length > 20) text = text.replace(ct, "");
    });
    return text.trim();
  }

  function markPending(post) {
    if (post.classList.contains("ai-pending") || post.classList.contains("ai-analyzed")) return;
    post.classList.add("ai-pending");
    const badge = document.createElement("div");
    badge.className = "ai-detected-badge ai-badge-pending";
    badge.textContent = "scanning…";
    post.appendChild(badge);
  }

  function clearPending(post) {
    post.classList.remove("ai-pending");
    post.querySelector(".ai-badge-pending")?.remove();
  }

  function observe(post) {
    if (processed.has(post)) return;
    markPending(post); // colour it now so the user knows analysis is coming
    intersectionObs?.observe(post);
  }

  async function processPost(post) {
    if (processed.has(post) || post.classList.contains("ai-analyzed")) return;
    processed.add(post);
    scheduled.delete(post);

    const text = extractText(post);
    if (text.length < MIN_TEXT) {
      clearPending(post);
      return;
    }

    const result = await window.detectAIContent(text);
    if (!result.verdict) {
      processed.delete(post); // detection failed — allow retry on re-hover/scroll
      return; // leave "scanning…" so the user knows it is still coming
    }

    clearPending(post);
    const slug = result.verdict.toLowerCase().replace(/_/g, "-");
    post.classList.add("ai-analyzed", "ai-verdict-" + slug);

    const badge = document.createElement("div");
    badge.className = "ai-detected-badge ai-badge-" + slug;
    badge.textContent = BADGE_LABELS[result.verdict] || result.verdict;
    if (result.reason) badge.title = result.reason;
    post.appendChild(badge);
  }

  function onIntersect(entries) {
    if (!enabled) return;
    for (const entry of entries) {
      const post = entry.target;
      if (entry.isIntersecting && !processed.has(post) && !scheduled.has(post)) {
        scheduled.add(post);
        setTimeout(() => scheduled.has(post) && processPost(post), DEBOUNCE);
      } else if (!entry.isIntersecting) {
        scheduled.delete(post);
      }
    }
  }

  // Hovering a not-yet-analyzed post jumps it ahead of the debounce queue
  function onHover(e) {
    if (!enabled) return;
    const post = e.target.closest?.(".ai-pending");
    if (post && !processed.has(post)) processPost(post);
  }

  function initIntersectionObs() {
    intersectionObs?.disconnect();
    intersectionObs = new IntersectionObserver(onIntersect, { threshold: VISIBILITY });
    findPosts().forEach(observe);
  }

  function observeNewPosts() {
    findPosts().forEach(observe);
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
    document.querySelectorAll(".ai-analyzed, .ai-pending").forEach((el) => {
      el.classList.remove("ai-analyzed", "ai-pending", ...VERDICT_CLASSES);
    });
    document.querySelectorAll(".ai-detected-badge").forEach((el) => el.remove());
  }

  function reset() {
    processed = new WeakSet();
    scheduled = new WeakSet();
    initIntersectionObs();
  }

  api.runtime.onMessage.addListener((msg, sender, respond) => {
    if (msg.type === "TOGGLE_ENABLED") {
      enabled = msg.enabled;
      enabled ? reset() : removeHighlights();
      respond({ success: true });
    }
    if (msg.type === "SETTINGS_UPDATED") {
      window.reloadDetectorSettings?.();
      removeHighlights();
      reset();
      respond({ success: true });
    }
    if (msg.type === "GET_STATUS") {
      respond({ enabled });
    }
    return true;
  });

  async function init() {
    const saved = await api.storage.local.get(["enabled"]);
    enabled = saved.enabled !== false;
    document.body.addEventListener("mouseover", onHover, { passive: true });
    setTimeout(() => {
      initMutationObs();
      initIntersectionObs();
    }, 1000);
  }

  document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", init) : init();
})();
