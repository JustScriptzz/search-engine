/* MiniSearch front end — keyword search + MiniSearch AI drawer.
   Vanilla JS, no build step, no third-party requests. */
(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);
  const el = {
    form: $("#omni"), q: $("#q"), clear: $("#clear"), theme: $("#theme"),
    stats: $("#stats"), foot: $("#foot-stats"), geo: $("#geo-note"),
    filters: $("#filters"), facets: $("#facets"),
    empty: $("#empty"), suggest: $("#suggest"),
    wrap: $("#results-wrap"), meta: $("#meta"), results: $("#results"), more: $("#more"),
    drawer: $("#drawer"), scrim: $("#scrim"), open: $("#ai-open"), close: $("#ai-close"),
    sub: $("#ai-sub"), thread: $("#thread"), ask: $("#ask"), askQ: $("#ask-q"),
  };

  const LS = {
    get: (k) => { try { return JSON.parse(localStorage.getItem(k) ?? "null"); } catch { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  const SUGGESTIONS = [
    "search engine ranking", "web standards", "developer tools",
    "space exploration", "world news", "climate", "html elements",
  ];

  const state = { hits: [], sel: -1, domain: "", limit: 10, country: "XX", history: [], busy: false, deep: true };

  /* ---------------------------------------------------------- utilities */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const domainOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } };

  function mark(text, query) {
    const terms = [...new Set(String(query).toLowerCase().split(/[^a-z0-9à-ÿ]+/i).filter((t) => t.length > 1))];
    let out = esc(text);
    for (const t of terms) {
      out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
    }
    return out;
  }

  /** Small safe markdown subset for agent replies. */
  function md(src) {
    const pre = [];
    let s = esc(src)
      .replace(/```([\s\S]*?)```/g, (_, c) => { pre.push(`<pre><code>${c.trim()}</code></pre>`); return `\u0000${pre.length - 1}\u0000`; })
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.split(/\n{2,}/).map((block) => {
      const lines = block.split("\n");
      if (/^\u0000\d+\u0000$/.test(block.trim())) return block.trim();
      if (lines.every((l) => /^\s*[-*]\s+/.test(l)))
        return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
      if (lines.every((l) => /^\s*\d+\.\s+/.test(l)))
        return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+\.\s+/, ""))}</li>`).join("")}</ol>`;
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    }).join("");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => pre[Number(i)]);
  }
  const inline = (s) => s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener">$1</a>');

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  /* ---------------------------------------------------------- theme */
  function initTheme() {
    const saved = LS.get("ms.theme");
    const prefersLight = matchMedia("(prefers-color-scheme: light)").matches;
    document.documentElement.dataset.theme = saved ?? (prefersLight ? "light" : "dark");
    el.theme.addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      LS.set("ms.theme", next);
    });
  }

  /* ---------------------------------------------------------- stats */
  async function loadStats() {
    try {
      const s = await (await fetch("/api/stats")).json();
      const t = `${s.docCount.toLocaleString()} docs`;
      el.stats.textContent = t;
      el.foot.textContent = `${s.name} ${s.version} · ${t} · ${s.termCount.toLocaleString()} terms`;
      el.sub.textContent = s.ai
        ? (s.ai.ready
            ? "reads this index, then answers with sources"
            : "offline · answering from raw index results")
        : "agent: offline";
    } catch {
      el.stats.textContent = "offline";
      el.sub.textContent = "agent: server unreachable";
    }
  }

  /* ---------------------------------------------------------- search */
  function skeletons(n = 4) {
    el.results.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const li = document.createElement("li");
      li.className = "skel";
      li.innerHTML = `<div class="sk sk-ico"></div><div><div class="sk s1"></div><div class="sk s2"></div><div class="sk s3"></div></div>`;
      el.results.appendChild(li);
    }
  }

  function resultNode(h, i, query) {
    const li = document.createElement("li");
    li.className = "result";
    li.dataset.index = String(i);
    const d = domainOf(h.url);
    li.innerHTML = `<div class="fav" aria-hidden="true"></div>
      <div>
        <h3><a class="r-title" target="_blank" rel="noopener"></a></h3>
        <a class="r-url" target="_blank" rel="noopener"></a>
        <p class="r-snip"></p>
        <div class="r-meta"><span class="tag rank"></span><span class="tag"></span></div>
      </div>`;
    li.querySelector(".fav").textContent = (d[0] ?? "?");
    const a = li.querySelector(".r-title");
    a.href = h.url; a.textContent = h.title;
    const u = li.querySelector(".r-url");
    u.href = h.url; u.textContent = d;
    li.querySelector(".r-snip").innerHTML = mark(h.snippet, query);
    const tags = li.querySelectorAll(".tag");
    const coverage = h.queryTerms ? ` · ${h.matchedTerms ?? 0}/${h.queryTerms} terms` : "";
    tags[0].textContent = `#${i + 1} · score ${h.score ?? "—"}${coverage}`;
    tags[1].textContent = `${(h.wordCount ?? 0).toLocaleString("en-US")} words`;
    li.addEventListener("mouseenter", () => select(i));
    return li;
  }

  function select(i) {
    state.sel = i;
    el.results.querySelectorAll(".result").forEach((n) => n.classList.toggle("sel", Number(n.dataset.index) === i));
  }

  function renderFacets(facets, active) {
    el.facets.innerHTML = "";
    for (const f of facets) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pill" + (f.domain === active ? " on" : "");
      b.dataset.domain = f.domain;
      b.innerHTML = `${esc(f.domain)}<span class="n">${f.count}</span>`;
      b.addEventListener("click", () => {
        state.domain = state.domain === f.domain ? "" : f.domain;
        el.facets.querySelectorAll(".pill").forEach((p) => p.classList.toggle("on", p.dataset.domain === state.domain));
        run(el.q.value.trim(), { reset: false });
      });
      el.facets.appendChild(b);
    }
  }

  async function run(query, { reset = true } = {}) {
    const q = query || el.q.value.trim();
    if (!q) {
      el.clear.hidden = true;
      el.filters.hidden = true;
      el.wrap.hidden = true;
      el.empty.hidden = false;
      el.results.innerHTML = "";
      return;
    }
    el.clear.hidden = false;
    el.empty.hidden = true;
    el.wrap.hidden = false;
    el.meta.textContent = "Searching the index…";
    skeletons();
    if (reset) { state.hits = []; state.sel = -1; }
    el.more.hidden = true;

    const params = new URLSearchParams({ q, limit: String(state.limit), deep: state.deep ? "1" : "0" });
    if (state.domain) params.set("domain", state.domain);
    try {
      const res = await fetch(`/api/search?${params}`);
      const data = await res.json();
      if (state.countryCode && state.countryCode !== "XX") {
        el.geo.textContent = ` · ${state.country}`;
      } else el.geo.textContent = "";
      state.country = data.country ?? state.country;
      const deepNote = $("#deep-note");
      if (deepNote && data.deep) {
        const passes = data.deep.passes.length;
        const extra = data.deep.expandedTerms.length;
        deepNote.innerHTML =
          passes > 1
            ? ` · deep search ${passes} passes${extra ? ` (+${extra} terms)` : ""}`
            : "";
        deepNote.title = data.deep.passes.map((p) => `${p.label}: "${p.query}" → ${p.results}`).join("\n");
      }
      el.meta.textContent =
        `${data.count} result${data.count === 1 ? "" : "s"}${data.domain ? ` on ${data.domain}` : ""} in ${data.tookMs}ms` +
        (data.total > data.count ? ` · ${data.total} matched` : "");
      loadOverview(q);
      el.results.innerHTML = "";
      state.hits = data.hits;
      if (data.note) {
        const note = document.createElement("li");
        note.className = "result note-row";
        note.innerHTML = `<div></div><div><p class="r-snip"></p></div>`;
        note.querySelector(".r-snip").textContent = data.note;
        el.results.appendChild(note);
      }
      if (!data.hits.length) {
        const li = document.createElement("li");
        li.className = "result";
        li.innerHTML = `<div></div><div><h3 class="r-title">Nothing indexed for “${esc(q)}”</h3><p class="r-snip">Try fewer words, clear the domain filter, or ask MiniSearch AI.</p></div>`;
        el.results.appendChild(li);
      } else {
        data.hits.forEach((h, i) => el.results.appendChild(resultNode(h, i, q)));
        select(0);
      }
      el.more.hidden = data.hits.length < state.limit || data.count >= state.total;
      el.filters.hidden = !data.facets?.length;
      renderFacets(data.facets ?? [], state.domain);
      pushHistory(q);
    } catch {
      el.meta.textContent = "Search failed — server unreachable.";
      el.results.innerHTML = "";
    }
  }

  function pushHistory(q) {
    const recent = (LS.get("ms.recent") ?? []).filter((x) => x !== q);
    recent.unshift(q);
    LS.set("ms.recent", recent.slice(0, 8));
  }

  /* ---------------------------------------------------------- keyboard */
  function onKey(e) {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
    if (e.key === "/" && !typing && !el.drawer.classList.contains("open")) { e.preventDefault(); el.q.focus(); el.q.select(); }
    if (e.key === "Escape") {
      if (el.drawer.classList.contains("open")) return toggleDrawer(false);
      if (document.activeElement === el.q) { el.q.value = ""; run(""); }
      else document.activeElement?.blur();
    }
    if (!el.wrap.hidden && !typing) {
      if (e.key === "ArrowDown" || e.key === "j") { e.preventDefault(); select(Math.min(state.sel + 1, state.hits.length - 1)); }
      if (e.key === "ArrowUp" || e.key === "k") { e.preventDefault(); select(Math.max(state.sel - 1, 0)); }
      if (e.key === "Enter" && state.sel >= 0 && state.hits[state.sel]) {
        e.preventDefault();
        window.open(state.hits[state.sel].url, "_blank", "noopener");
      }
    }
  }

  /* ---------------------------------------------------------- AI overview */
  const ov = $("#overview");
  const ovBody = $("#overview-body");
  const ovSources = $("#overview-sources");
  let ovSeq = 0;

  /** Fire-and-forget: the answer panel streams in after the results do. */
  async function loadOverview(query) {
    const seq = ++ovSeq;
    ov.hidden = false;
    ovBody.innerHTML = `<span class="thinking"><i></i><i></i><i></i></span>`;
    ovSources.innerHTML = "";
    try {
      const res = await fetch(`/api/overview?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error("overview failed");
      const data = await res.json();
      if (seq !== ovSeq) return; // a newer query already won
      ovBody.innerHTML = md(data.text || "");
      const seenDomains = new Set();
      ovSources.innerHTML = (data.sources ?? [])
        .filter((s) => {
          const d = domainOf(s.url);
          if (seenDomains.has(d)) return false;
          seenDomains.add(d);
          return true;
        })
        .slice(0, 6)
        .map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(domainOf(s.url))}</a>`)
        .join("");
    } catch {
      if (seq !== ovSeq) return;
      ov.hidden = true;
    }
  }

  /* ---------------------------------------------------------- AI drawer */
  function toggleDrawer(open) {
    el.drawer.classList.toggle("open", open);
    el.drawer.setAttribute("aria-hidden", String(!open));
    el.scrim.hidden = !open;
    if (open) setTimeout(() => el.askQ.focus(), 240);
  }

  function bubble(kind, who) {
    const d = document.createElement("div");
    d.className = `msg ${kind}`;
    d.innerHTML = `<div class="msg-head">${who ? `<span class="dot"></span>${esc(who)}` : ""}</div><div class="body"></div>`;
    el.thread.appendChild(d);
    d.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return d.querySelector(".body");
  }

  const TOOL_LABELS = {
    search_index: (a) => `search_index “${a.query ?? ""}”`,
    read_page: (a) => `read_page ${domainOf(String(a.url ?? ""))}`,
    index_stats: () => "index_stats",
  };

  async function ask(question) {
    if (state.busy || !question.trim()) return;
    state.busy = true;
    const send = el.ask.querySelector("button");
    send.disabled = true;

    bubble("user", "").textContent = question;
    const body = bubble("bot", "MiniSearch AI");
    body.innerHTML = `<div class="tools"></div><span class="thinking"><i></i><i></i><i></i></span>`;
    const tools = body.querySelector(".tools");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: question, history: state.history, country: state.country }),
      });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "", answer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const f of frames) {
          const line = f.trim();
          if (!line.startsWith("data:")) continue;
          let ev; try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; }
          if (ev.type === "tool") {
            const chip = document.createElement("span");
            chip.className = "tool";
            chip.textContent = `→ ${(TOOL_LABELS[ev.name] ?? ((a) => ev.name))(ev.args ?? {})}`;
            tools.appendChild(chip);
            body.querySelector(".thinking")?.remove();
          } else if (ev.type === "status") {
            if (!body.querySelector(".thinking")) {
              const t = document.createElement("span");
              t.className = "thinking"; t.innerHTML = "<i></i><i></i><i></i>";
              body.appendChild(t);
            }
          } else if (ev.type === "answer") {
            answer = ev.text;
          } else if (ev.type === "error") {
            const p = document.createElement("p");
            p.className = "err"; p.textContent = ev.message;
            body.appendChild(p);
          }
        }
      }
      body.querySelector(".thinking")?.remove();
      body.insertAdjacentHTML("beforeend", answer ? md(answer) : "<p>No answer returned.</p>");
      state.history.push({ role: "user", content: question }, { role: "assistant", content: answer });
      state.history = state.history.slice(-8);
    } catch (err) {
      body.innerHTML = `<p class="err">Chat failed: ${esc(err.message)}</p>`;
    } finally {
      state.busy = false;
      send.disabled = false;
    }
  }

  /* ---------------------------------------------------------- boot */
  function renderSuggestions() {
    const recent = LS.get("ms.recent") ?? [];
    const items = [...new Set([...recent.slice(0, 3), ...SUGGESTIONS])].slice(0, 9);
    for (const s of items) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pill";
      b.textContent = s;
      b.addEventListener("click", () => { el.q.value = s; run(s); });
      el.suggest.appendChild(b);
    }
  }

  initTheme();
  renderSuggestions();
  loadStats();

  el.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = el.q.value.trim();
    if (!q) return;
    history.replaceState(null, "", `/?q=${encodeURIComponent(q)}${state.domain ? `&domain=${state.domain}` : ""}`);
    run(q);
  });
  el.q.addEventListener("input", debounce(() => { el.clear.hidden = !el.q.value; }, 120));
  el.clear.addEventListener("click", () => { el.q.value = ""; el.q.focus(); run(""); history.replaceState(null, "", "/"); });
  el.more.addEventListener("click", () => { state.limit += 10; run(); });
  document.addEventListener("keydown", onKey);

  el.open.addEventListener("click", () => toggleDrawer(true));
  el.close.addEventListener("click", () => toggleDrawer(false));
  el.scrim.addEventListener("click", () => toggleDrawer(false));
  el.thread.addEventListener("click", (e) => {
    const chip = e.target.closest(".chip-btn");
    if (chip) ask(chip.dataset.q);
  });
  el.ask.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = el.askQ.value.trim();
    if (!q) return;
    el.askQ.value = "";
    el.askQ.style.height = "auto";
    ask(q);
  });
  el.askQ.addEventListener("input", () => {
    el.askQ.style.height = "auto";
    el.askQ.style.height = Math.min(el.askQ.scrollHeight, 150) + "px";
  });
  el.askQ.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); el.ask.requestSubmit(); }
  });

  const params = new URLSearchParams(location.search);
  const initial = params.get("q") ?? "";
  const initialDomain = params.get("domain") ?? "";
  if (initialDomain) state.domain = initialDomain.toLowerCase();
  if (initial) { el.q.value = initial; el.clear.hidden = false; run(initial, { reset: true }); }
})();