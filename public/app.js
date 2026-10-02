/* MiniSearch UI: keyword search + MiniSearch AI chat (SSE tool-calling agent). */
(() => {
  const $ = (sel) => document.querySelector(sel);

  const state = {
    mode: "search",
    history: [],
    countryCode: "XX",
    country: "",
    busy: false,
  };

  // ---------------------------------------------------------------- helpers
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const domainOf = (url) => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return url;
    }
  };

  function mark(text, query) {
    const terms = [...new Set(String(query).toLowerCase().split(/[^a-z0-9à-ÿ]+/i).filter((t) => t.length > 1))];
    let out = esc(text);
    for (const t of terms) {
      out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
    }
    return out;
  }

  /** Tiny safe markdown -> HTML for agent answers (links, code, lists, bold). */
  function md(src) {
    const blocks = [];
    let html = esc(src)
      .replace(/```([\s\S]*?)```/g, (_, code) => {
        blocks.push(`<pre><code>${code.trim()}</code></pre>`);
        return `\u0000B${blocks.length - 1}\u0000`;
      })
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");

    html = html
      .split(/\n{2,}/)
      .map((block) => {
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*[-*]\s+/.test(l)))
          return `<ul>${lines.map((l) => `<li>${mdInline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
        if (lines.every((l) => /^\s*\d+\.\s+/.test(l)))
          return `<ol>${lines.map((l) => `<li>${mdInline(l.replace(/^\s*\d+\.\s+/, ""))}</li>`).join("")}</ol>`;
        if (/^\u0000B\d+\u0000$/.test(block.trim())) return block.trim();
        return `<p>${lines.map(mdInline).join("<br>")}</p>`;
      })
      .join("");

    return html.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
  }

  function mdInline(s) {
    return s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  // ---------------------------------------------------------------- stats
  async function loadStats() {
    try {
      const s = await (await fetch("/api/stats")).json();
      const t = `${s.docCount.toLocaleString()} docs · ${s.termCount.toLocaleString()} terms`;
      $("#stats").textContent = t;
      $("#foot-stats").textContent = `${s.name} ${s.version} · ${t}`;
      const hint = $("#ai-hint");
      if (hint && s.ai) {
        hint.textContent = s.ai.configured
          ? `${s.ai.provider} · ${s.ai.model} · tools: search_index, read_page, index_stats`
          : `${s.ai.provider} · no API key — answers fall back to raw index results`;
      }
    } catch {
      $("#stats").textContent = "index offline";
    }
  }

  // ---------------------------------------------------------------- search
  const results = $("#results");
  const meta = $("#meta");

  function skeletons(n = 3) {
    results.innerHTML = "";
    for (let i = 0; i < n; i++) {
      const d = document.createElement("div");
      d.className = "skel";
      d.innerHTML = `<div class="s1"></div><div class="s2"></div><div class="s3"></div>`;
      results.appendChild(d);
    }
  }

  function resultCard(h, i, query) {
    const el = document.createElement("article");
    el.className = "card";
    el.innerHTML = `<div class="rank"></div><div><h2><a target="_blank" rel="noopener"></a></h2><div class="srcurl"></div><p></p><div class="score"></div></div>`;
    el.querySelector(".rank").textContent = String(i + 1).padStart(2, "0");
    const a = el.querySelector("h2 a");
    a.href = h.url;
    a.textContent = h.title;
    el.querySelector(".srcurl").textContent = domainOf(h.url);
    el.querySelector("p").innerHTML = mark(h.snippet, query);
    el.querySelector(".score").textContent = `score ${h.score ?? "—"} · ${(h.wordCount ?? 0).toLocaleString()} words`;
    return el;
  }

  async function runSearch(query) {
    if (!query) return;
    $("#intro").classList.add("hidden");
    meta.textContent = "Searching the index…";
    skeletons();
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=10`);
      const data = await res.json();
      state.countryCode = data.countryCode || "XX";
      state.country = data.country || "";
      const chip = $("#country");
      if (state.countryCode !== "XX") {
        chip.textContent = `tuned for ${state.country}`;
        chip.hidden = false;
      } else chip.hidden = true;

      meta.textContent = `${data.count} result${data.count === 1 ? "" : "s"} · ${data.tookMs}ms`;
      results.innerHTML = "";
      if (!data.hits.length) {
        results.innerHTML = `<div class="empty">Nothing indexed for “${esc(query)}”.<br />Try fewer words, or ask <code>MiniSearch AI</code>.</div>`;
        return;
      }
      data.hits.forEach((h, i) => results.appendChild(resultCard(h, i, query)));
    } catch {
      meta.textContent = "Search failed — is the server up?";
      results.innerHTML = "";
    }
  }

  // ---------------------------------------------------------------- AI chat
  const thread = $("#thread");
  const askForm = $("#ask");
  const askInput = $("#ask-q");

  function bubble(kind, who) {
    const el = document.createElement("div");
    el.className = `msg ${kind}`;
    el.innerHTML = `<div class="who"></div><div class="body"></div>`;
    el.querySelector(".who").textContent = who;
    return el;
  }

  const TOOL_LABELS = {
    search_index: (a) => `search_index “${a.query ?? ""}”`,
    read_page: (a) => `read_page ${domainOf(String(a.url ?? ""))}`,
    index_stats: () => "index_stats",
  };

  async function ask(question) {
    if (state.busy || !question) return;
    state.busy = true;
    askForm.querySelector("button").disabled = true;

    const userMsg = bubble("user", "you");
    userMsg.querySelector(".body").textContent = question;
    thread.appendChild(userMsg);

    const botMsg = bubble("bot", window.CONFIG_NAME || "MiniSearch AI");
    const body = botMsg.querySelector(".body");
    body.innerHTML = `<div class="tools"></div><span class="thinking"><i></i><i></i><i></i></span>`;
    const tools = botMsg.querySelector(".tools");
    thread.appendChild(botMsg);
    botMsg.scrollIntoView({ block: "nearest", behavior: "smooth" });

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: question, history: state.history, country: state.countryCode }),
      });
      if (!res.ok || !res.body) throw new Error(`chat HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";
      let toolCount = 0;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith("data:")) continue;
          let ev;
          try {
            ev = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          if (ev.type === "tool") {
            toolCount++;
            const label = (TOOL_LABELS[ev.name] ?? ((a) => ev.name))(ev.args ?? {});
            const chip = document.createElement("span");
            chip.className = "tool";
            chip.textContent = `→ ${label}`;
            tools.appendChild(chip);
            body.querySelector(".thinking")?.remove();
          } else if (ev.type === "status") {
            let t = body.querySelector(".thinking");
            if (!t) {
              t = document.createElement("span");
              t.className = "thinking";
              t.innerHTML = "<i></i><i></i><i></i>";
              body.appendChild(t);
            }
          } else if (ev.type === "answer") {
            answer = ev.text;
          } else if (ev.type === "error") {
            const p = document.createElement("p");
            p.className = "err";
            p.textContent = `Agent error: ${ev.message}`;
            body.appendChild(p);
          }
        }
      }
      body.querySelector(".thinking")?.remove();
      if (answer) body.insertAdjacentHTML("beforeend", md(answer));
      if (!answer && !body.querySelector(".err")) body.textContent = "No answer returned.";
      state.history.push({ role: "user", content: question }, { role: "assistant", content: answer });
      state.history = state.history.slice(-8);
    } catch (err) {
      body.innerHTML = `<p class="err">Chat failed: ${esc(err.message)}</p>`;
    } finally {
      state.busy = false;
      askForm.querySelector("button").disabled = false;
      botMsg.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  // ---------------------------------------------------------------- wiring
  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll(".mode").forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    });
    $("#search-view").hidden = mode !== "search";
    $("#ai-view").hidden = mode !== "ai";
    $("#intro").classList.toggle("hidden", mode === "ai" || Boolean($("#q").value));
    if (mode === "ai") askInput.focus();
  }

  document.querySelectorAll(".mode").forEach((b) => b.addEventListener("click", () => setMode(b.dataset.mode)));

  $("#q").addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const query = $("#q").value.trim();
    if (!query) return;
    history.replaceState(null, "", `/?q=${encodeURIComponent(query)}`);
    setMode("search");
    runSearch(query);
  });

  askForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = askInput.value.trim();
    if (!q) return;
    askInput.value = "";
    askInput.style.height = "auto";
    ask(q);
  });

  askInput.addEventListener("input", () => {
    askInput.style.height = "auto";
    askInput.style.height = Math.min(askInput.scrollHeight, 160) + "px";
  });

  askInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      askForm.requestSubmit();
    }
  });

  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
    if (e.key === "/" && !typing) {
      e.preventDefault();
      $("#q").focus();
    }
    if (e.key === "Escape") document.activeElement?.blur();
  });

  // ---------------------------------------------------------------- boot
  loadStats();
  const initial = new URLSearchParams(location.search).get("q") || "";
  if (initial) {
    $("#q").value = initial;
    $("#intro").classList.add("hidden");
    runSearch(initial);
  }
})();