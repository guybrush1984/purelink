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
  // Anything this extension injects into a post card. innerText would otherwise
  // feed our own UI back to the model — see DOM-NOTES.md.
  const OWN_UI = ".ai-detected-badge, .ai-jev-panel, .ai-fc-btn, .ai-fc-panel, .ai-fc-pin, .ai-fc-card";
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
    // Hashed-class UI: no body selector. Take the whole card, minus our own UI
    // and minus embedded comments — neither is the author's writing.
    // innerText skips display:none, so hide our nodes rather than string-strip
    // them: verdict labels are "Human", "AI", "Uncertain" — real words in posts.
    const ours = [...post.querySelectorAll(OWN_UI)];
    ours.forEach((b) => (b.style.display = "none"));
    let text = post.innerText || "";
    ours.forEach((b) => (b.style.display = ""));
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

  const el = (cls, text, tag) => {
    const n = document.createElement(tag || "div");
    n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  const VERDICT_SLUG = { SUPPORTED: "supported", CONTRADICTED: "contradicted", UNVERIFIABLE: "unverifiable" };
  const GLYPH = { supported: "✓", contradicted: "✗", unverifiable: "?" };

  // LinkedIn wraps outbound links; the ?url= param decodes to the real target
  // with no network call. See DOM-NOTES.md.
  function extractSourceUrls(post) {
    const urls = new Set();
    post.querySelectorAll('a[href*="/safety/go"]').forEach((a) => {
      try {
        const u = new URL(a.href).searchParams.get("url");
        if (u) urls.add(u);
      } catch (_) {}
    });
    return [...urls];
  }

  function addFactCheckBtn(post) {
    if (post.querySelector(":scope > .ai-fc-btn")) return;
    const btn = el("ai-fc-btn", "Fact-check", "button");
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startFactCheck(post, btn);
    });
    post.appendChild(btn);
  }

  // The model normalises typography when it quotes a claim back, so a curly
  // apostrophe in the post becomes a straight one in the claim and indexOf
  // misses. Every mapping here is 1:1, so the index map stays aligned.
  const fold = (c) =>
    "\u2018\u2019\u02BC".includes(c) ? "'" : "\u201C\u201D".includes(c) ? '"' : "\u2013\u2014".includes(c) ? "-" : c;

  // The model quotes claims from innerText, which inserts newlines between
  // blocks that the DOM does not contain. So flatten the post's text nodes to
  // single-spaced text, keeping an index back to (node, offset) to locate a
  // quote no matter how many elements it spans.
  function textMap(post) {
    const walker = document.createTreeWalker(post, NodeFilter.SHOW_TEXT);
    const nodes = [];
    const map = [];
    let flat = "";
    let node;
    while ((node = walker.nextNode())) {
      if (node.parentElement?.closest(OWN_UI)) continue;
      const idx = nodes.push(node) - 1;
      const value = node.nodeValue;
      for (let o = 0; o < value.length; o++) {
        const space = /\s/.test(value[o]);
        if (space && (!flat || flat.endsWith(" "))) continue;
        flat += space ? " " : fold(value[o]);
        map.push({ idx, o });
      }
    }
    return { nodes, flat, map };
  }

  // Wraps the claim where it sits in the post. Returns every <mark> it made:
  // the caller recolours them once a verdict lands, and pins to the last one.
  function highlightClaim(post, claimText, slug) {
    const full = [...claimText].map(fold).join("").replace(/\s+/g, " ").trim();
    for (const needle of [full, full.slice(0, 60)]) {
      if (needle.length < 15) continue;
      const { nodes, flat, map } = textMap(post);
      const at = flat.indexOf(needle);
      if (at < 0) continue;
      const first = map[at];
      const last = map[at + needle.length - 1];
      const marks = [];
      // Highest node index first: wrapping splits text nodes, and going
      // backwards keeps the offsets we already computed valid.
      for (let i = last.idx; i >= first.idx; i--) {
        const node = nodes[i];
        const from = i === first.idx ? first.o : 0;
        const to = i === last.idx ? last.o + 1 : node.nodeValue.length;
        if (to <= from) continue;
        const range = document.createRange();
        range.setStart(node, from);
        range.setEnd(node, to);
        const mark = el("ai-fc-mark ai-fc-mark-" + slug, undefined, "mark");
        range.surroundContents(mark);
        marks.unshift(mark);
      }
      if (marks.length) return marks;
    }
    return null;
  }

  function recolour(marks, slug) {
    marks.forEach((m) => (m.className = "ai-fc-mark ai-fc-mark-" + slug));
  }

  // Posts are CSS-clamped to a few lines, so annotations in the clipped region
  // would be invisible. Clicking Fact-check is the consent to expand — see
  // DOM-NOTES.md on why nothing is auto-clicked during passive scanning.
  function expandPost(post) {
    post.querySelectorAll("button").forEach((b) => {
      if (/^[….\s]*(more|plus|voir plus)$/i.test((b.innerText || "").trim())) b.click();
    });
  }

  function unwrap(mark) {
    const parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (_) {
      return "source";
    }
  }

  function annotate(mark, e) {
    const slug = VERDICT_SLUG[e.verdict] || "unverifiable";
    const label = e.citation_url ? hostOf(e.citation_url) : "no source";
    const pin = el("ai-fc-pin ai-fc-pin-" + slug, `${GLYPH[slug]} ${label}`, "span");
    pin.title = e.reason || e.verdict;

    const card = el("ai-fc-card ai-fc-card-" + slug, undefined, "span");
    card.hidden = true;
    card.appendChild(el("ai-fc-cv", e.verdict, "span"));
    card.appendChild(el("ai-fc-creason", e.reason || "", "span"));
    if (e.quote) card.appendChild(el("ai-fc-cquote", "“" + e.quote + "”"));
    if (e.citation_url) {
      const a = el("ai-fc-ccite", e.citation_url, "a");
      a.href = e.citation_url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.addEventListener("click", (ev) => ev.stopPropagation());
      card.appendChild(a);
    }

    pin.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      card.hidden = !card.hidden;
    });

    mark.after(pin);
    pin.after(card);
  }

  function startFactCheck(post, btn) {
    post.querySelectorAll(".ai-fc-panel, .ai-fc-pin, .ai-fc-card").forEach((n) => n.remove());
    post.querySelectorAll(".ai-fc-mark").forEach(unwrap);
    expandPost(post);

    const panel = el("ai-fc-panel");
    const bar = el("ai-fc-bar");
    const status = el("ai-fc-status", "reading the post…", "span");
    const toggle = el("ai-fc-toggle", "trace", "button");
    const close = el("ai-fc-close", "×", "button");
    const list = el("ai-fc-list");
    list.hidden = true;
    bar.append(el("ai-fc-title", "Fact-check", "span"), status, toggle, close);
    panel.append(bar, list);
    post.appendChild(panel);
    btn.disabled = true;

    toggle.addEventListener("click", () => (list.hidden = !list.hidden));
    close.addEventListener("click", () => {
      post.querySelectorAll(".ai-fc-pin, .ai-fc-card").forEach((n) => n.remove());
      post.querySelectorAll(".ai-fc-mark").forEach(unwrap);
      panel.remove();
      btn.disabled = false;
    });

    const rows = [];
    const marksFor = [];
    const pinFor = [];
    const line = (ci, text, cls) => {
      if (rows[ci]) rows[ci].appendChild(el("ai-fc-line " + (cls || ""), text));
    };

    const port = api.runtime.connect({ name: "factcheck" });

    port.onMessage.addListener((e) => {
      if (e.k === "claims") {
        status.textContent = `${e.claims.length} checkable · ${e.rejected.length} rejected`;
        e.claims.forEach((c, i) => {
          const row = el("ai-fc-row");
          row.appendChild(el("ai-fc-rowhead", `${i + 1}. [${c.type}/${c.source_state}] ${c.text}`));
          const trace = el("ai-fc-trace");
          row.appendChild(trace);
          list.appendChild(row);
          rows[i] = trace;

          // Paint the claim immediately. Verifying all of them takes a minute
          // or more, and an untouched post the whole time reads as broken.
          const marks = highlightClaim(post, c.text, "pending");
          if (!marks) {
            trace.appendChild(el("ai-fc-line ai-fc-bad", "could not locate this claim in the post"));
            return;
          }
          marksFor[i] = marks;
          const pin = el("ai-fc-pin ai-fc-pin-pending", "checking…", "span");
          marks[marks.length - 1].after(pin);
          pinFor[i] = pin;
        });
        // Why something was dropped is the first question anyone asks of a
        // gate, so show the sentence and its reason code, not just a count.
        if (e.rejected.length) {
          const box = el("ai-fc-row ai-fc-rejects");
          box.appendChild(el("ai-fc-rejhead", `${e.rejected.length} rejected — not checkable`));
          e.rejected.forEach((r) => {
            const line = el("ai-fc-rej");
            line.appendChild(el("ai-fc-code", r.code, "span"));
            line.appendChild(el("ai-fc-rejtext", r.text, "span"));
            box.appendChild(line);
          });
          list.appendChild(box);
        }
      }
      if (e.k === "stage" && e.stage === "search") {
        line(e.ci, e.status === "error" ? `search failed: ${e.note}` : `search: ${e.query}`, e.status === "error" ? "ai-fc-bad" : "");
      }
      if (e.k === "results") e.results.forEach((r) => line(e.ci, `• ${r.url} (${r.chars})`, "ai-fc-url"));
      if (e.k === "source") {
        const bad = e.status === "blocked" || e.status === "error";
        line(e.ci, `fetch ${e.url} → ${e.status}${e.note ? " (" + e.note + ")" : ""}`, bad ? "ai-fc-bad" : "ai-fc-url");
      }
      if (e.k === "stage" && e.stage === "verdict") line(e.ci, `judging — ${e.note}`);
      if (e.k === "verdict") {
        const marks = marksFor[e.ci];
        if (!marks) {
          line(e.ci, `${e.verdict} — ${e.reason || ""}`, "ai-fc-bad");
          return;
        }
        recolour(marks, VERDICT_SLUG[e.verdict] || "unverifiable");
        pinFor[e.ci]?.remove();
        annotate(marks[marks.length - 1], e);
      }
      if (e.k === "done") {
        panel.dataset.done = "1";
        status.textContent = e.summary || "done";
        btn.disabled = false;
      }
      if (e.k === "error") {
        panel.dataset.done = "1";
        status.textContent = "error: " + e.message;
        status.classList.add("ai-fc-bad");
        btn.disabled = false;
      }
    });

    port.onDisconnect.addListener(() => {
      if (!panel.dataset.done) status.textContent = "background worker disconnected";
      btn.disabled = false;
    });

    port.postMessage({ type: "RUN", text: extractText(post), urls: extractSourceUrls(post) });
  }

  function observe(post) {
    if (processed.has(post)) return;
    markPending(post); // colour it now so the user knows analysis is coming
    addFactCheckBtn(post);
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
    if (result.noKey) {
      clearPending(post);
      post.classList.add("ai-analyzed"); // positions the badge; settings changes clear it
      const badge = el("ai-detected-badge ai-badge-nokey", "Add a Jev key");
      badge.title = "Paste an OpenRouter or TypeSafe API key in the extension popup";
      post.appendChild(badge);
      return;
    }
    if (!result.verdict) {
      processed.delete(post); // detection failed — allow retry on re-hover/scroll
      return; // leave "scanning…" so the user knows it is still coming
    }

    clearPending(post);
    const slug = result.verdict.toLowerCase().replace(/_/g, "-");
    post.classList.add("ai-analyzed", "ai-verdict-" + slug);

    const badge = el("ai-detected-badge ai-badge-" + slug, BADGE_LABELS[result.verdict] || result.verdict);
    badge.title = "Click for Jev's answers";
    if (result.bait.flagged) {
      const chip = el("ai-bait-chip", "Bait", "span");
      chip.title = `Clickbait: ${result.bait.kind} (${Math.round(result.bait.score * 100)}%)`;
      badge.append(chip);
    }
    // Slop meter: the weighted AI score as a bar along the badge's bottom edge
    const meter = el("ai-slop-meter", undefined, "span");
    meter.append(el("ai-slop-fill", undefined, "span"));
    meter.firstChild.style.width = Math.round(result.score * 100) + "%";
    badge.append(meter);
    badge.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = post.querySelector(":scope > .ai-jev-panel");
      open ? open.remove() : post.appendChild(jevPanel(result));
    });
    post.appendChild(badge);
  }

  // One question: its answer as a bar, and which way it pushed this post.
  function jevRow(q, v, label, dir, strong) {
    const scale = q === "personal_stake" ? 3 : 1;
    const row = el("ai-jev-row");
    row.title = (window.JEV_QUESTIONS[q] || window.JEV_BAIT_QUESTIONS[q]).instructions;
    const bar = el("ai-jev-bar", undefined, "span");
    bar.append(el("ai-jev-fill", undefined, "span"));
    bar.firstChild.style.width = Math.round((v / scale) * 100) + "%";
    row.append(
      el("ai-jev-label", label, "span"),
      bar,
      el("ai-jev-val", scale === 1 ? Math.round(v * 100) + "%" : `${v.toFixed(1)}/3`, "span"),
      el(`ai-jev-push ai-jev-push-${dir}${strong ? " ai-jev-push-strong" : ""}`, { none: "·", ai: "▲ AI", human: "▼ human", bait: "▲ bait" }[dir], "span")
    );
    return row;
  }

  // Every question's answer, sorted by how far it moved this post's score from
  // a typical human post's: the top rows are why the post got its verdict.
  function jevPanel(result) {
    const panel = el("ai-jev-panel");
    panel.addEventListener("click", (e) => e.stopPropagation());
    const pctl = window.jevHumanPercentile(result.score);
    panel.append(
      el("ai-jev-head", `AI score ${result.score.toFixed(2)} · ${BADGE_LABELS[result.verdict]}`),
      el("ai-jev-sub", `More AI-like than ${pctl >= 99.5 ? Math.min(pctl, 99.9).toFixed(1) : Math.round(pctl)}% of human LinkedIn posts`)
    );
    const bait = result.bait;
    panel.append(
      el("ai-jev-bait" + (bait.flagged ? " ai-jev-bait-on" : ""), bait.flagged ? `Clickbait: ${bait.kind}` : "No clickbait")
    );
    Object.keys(window.JEV_BAIT_LABELS)
      .sort((a, b) => result.values[b] - result.values[a])
      .forEach((q) => panel.append(jevRow(q, result.values[q], window.JEV_BAIT_LABELS[q], result.values[q] >= window.JEV_BAIT_CUT ? "bait" : "none")));
    panel.append(el("ai-jev-sep", "Written by AI?"));
    const pushes = window.jevPushes(result.values);
    Object.keys(pushes)
      .sort((a, b) => Math.abs(pushes[b]) - Math.abs(pushes[a]))
      .forEach((q) => {
        const p = pushes[q];
        panel.append(jevRow(q, result.values[q], window.JEV_LABELS[q], Math.abs(p) < 0.1 ? "none" : p > 0 ? "ai" : "human", Math.abs(p) >= 0.5));
      });
    return panel;
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
    document.querySelectorAll(".ai-fc-mark").forEach(unwrap);
    document.querySelectorAll(".ai-detected-badge, .ai-jev-panel, .ai-fc-btn, .ai-fc-panel, .ai-fc-pin, .ai-fc-card").forEach((n) => n.remove());
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
