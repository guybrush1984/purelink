// Fact-check pipeline. Runs in the background worker: it holds the API key and
// needs cross-origin access to ollama.com. Emits a trace event for every step
// so the panel can show what it is doing, not just what it concluded.
//
// Retrieval behaviour it works around is documented in RETRIEVAL-NOTES.md:
// web_fetch fails SILENTLY (HTTP 200, empty content), hard-blocks on some
// publishers, flakes transiently on others, and does not follow lnkd.in.
(() => {
  const api = typeof browser !== "undefined" ? browser : chrome;
  const CLOUD = "https://ollama.com";
  const EVIDENCE_PER_CLAIM = 3;
  const EVIDENCE_CHARS = 2500; // search content runs 1.5-11K chars; cap the spend
  const FETCH_ATTEMPTS = 2; // one retry: flakes recover, hard blocks never do

  const load = async () => {
    const s = await api.storage.local.get(["ollamaUrl", "model", "ollamaApiKey"]);
    return {
      url: s.ollamaUrl || "http://localhost:11434",
      model: s.model || "gemma4:31b-cloud",
      key: s.ollamaApiKey || "",
    };
  };

  async function llm(cfg, system, user, maxTokens) {
    const res = await fetch(`${cfg.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await self.ollamaAuthHeaders(cfg.url)) },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "system", content: system }, { role: "user", content: user }],
        temperature: 0.1,
        max_tokens: maxTokens || 2048,
        response_format: { type: "json_object" },
      }),
    });
    if (res.status === 401) throw new Error("Ollama API key missing or rejected");
    if (!res.ok) throw new Error(`model ${res.status}`);
    const raw = (await res.json()).choices?.[0]?.message?.content || "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("model returned no JSON");
    return JSON.parse(match[0]);
  }

  async function cloud(cfg, path, body) {
    if (!cfg.key) throw new Error("No Ollama API key — set one in the extension popup");
    const res = await fetch(CLOUD + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify(body),
    });
    if (res.status === 401) throw new Error("Ollama API key rejected (401)");
    if (!res.ok) throw new Error(`${path} ${res.status}`);
    return res.json();
  }

  // Returns {url, content, status}. status is what the panel shows.
  async function webFetch(cfg, url, emit, ci, depth) {
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
      emit({ k: "source", ci, url, status: attempt === 1 ? "fetching" : "retrying" });
      let data;
      try {
        data = await cloud(cfg, "/api/web_fetch", { url });
      } catch (e) {
        emit({ k: "source", ci, url, status: "error", note: e.message });
        return { url, content: "", status: "error" };
      }
      const content = data.content || "";

      // LinkedIn's shortener returns its interstitial, with the real target in links
      if (content && /not on LinkedIn|unable to verify it for safety/i.test(content)) {
        const target = (data.links || []).find((l) => !/^https?:\/\/[^/]*linkedin\.com/i.test(l));
        if (target && (depth || 0) < 2) {
          emit({ k: "source", ci, url, status: "resolved", note: target });
          return webFetch(cfg, target, emit, ci, (depth || 0) + 1);
        }
        emit({ k: "source", ci, url, status: "blocked", note: "shortener, no target" });
        return { url, content: "", status: "blocked" };
      }

      if (content.length) {
        emit({ k: "source", ci, url, status: "ok", note: `${content.length} chars` });
        return { url, content, status: "ok" };
      }
    }
    // 200 with empty body — paywall or bot-wall. Never treat as "source says no".
    emit({ k: "source", ci, url, status: "blocked", note: "empty after retry" });
    return { url, content: "", status: "blocked" };
  }

  async function runFactCheck(text, postUrls, emit) {
    const cfg = await load();

    emit({ k: "stage", stage: "extract", status: "start" });
    const ext = await llm(cfg, self.CLAIM_EXTRACTION_SYSTEM_PROMPT, text, 2048);
    const claims = (ext.claims || []).slice(0, 5);
    emit({ k: "claims", claims, rejected: ext.rejected || [] });

    if (!claims.length) {
      emit({ k: "done", summary: "No checkable claims in this post." });
      return;
    }

    for (let ci = 0; ci < claims.length; ci++) {
      const claim = claims[ci];
      const evidence = [];

      // The author's own cited source is the highest-value check: if it does not
      // support the claim, that is a misrepresentation, not just a missing source.
      if (claim.source_state === "cited_in_post" && postUrls.length) {
        for (const u of postUrls.slice(0, 2)) {
          const r = await webFetch(cfg, u, emit, ci, 0);
          if (r.content) evidence.push({ url: r.url, cited: true, content: r.content.slice(0, EVIDENCE_CHARS) });
        }
      }

      emit({ k: "stage", stage: "search", status: "start", ci, query: claim.query });
      let results = [];
      try {
        const s = await cloud(cfg, "/api/web_search", { query: claim.query, max_results: 5 });
        results = s.results || [];
      } catch (e) {
        emit({ k: "stage", stage: "search", status: "error", ci, note: e.message });
      }
      emit({ k: "results", ci, results: results.map((r) => ({ url: r.url, title: r.title, chars: (r.content || "").length })) });

      // Search content is an independent extraction from web_fetch and survives
      // paywalls that block fetch, so it is the primary evidence, not a fallback.
      for (const r of results.slice(0, EVIDENCE_PER_CLAIM)) {
        if (r.content) evidence.push({ url: r.url, cited: false, content: r.content.slice(0, EVIDENCE_CHARS) });
      }

      if (!evidence.length) {
        emit({ k: "verdict", ci, verdict: "UNVERIFIABLE", reason: "no evidence retrieved", citation_url: null, quote: null });
        continue;
      }

      emit({ k: "stage", stage: "verdict", status: "start", ci, note: `${evidence.length} excerpts` });
      const user = [
        `CLAIM (${claim.type}): ${claim.text}`,
        `ENTITY: ${claim.entity}`,
        "",
        "EVIDENCE:",
        ...evidence.map((e, i) => `[${i + 1}] ${e.url}${e.cited ? "  (cited by the post's author)" : ""}\n${e.content}`),
      ].join("\n");
      try {
        const v = await llm(cfg, self.CLAIM_VERIFICATION_SYSTEM_PROMPT, user, 512);
        emit({ k: "verdict", ci, ...v });
      } catch (e) {
        emit({ k: "verdict", ci, verdict: "UNVERIFIABLE", reason: `verifier failed: ${e.message}`, citation_url: null, quote: null });
      }
    }

    emit({ k: "done" });
  }

  self.runFactCheck = runFactCheck;
})();
