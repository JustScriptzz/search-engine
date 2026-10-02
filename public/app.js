/* MiniSearch single-page frontend: ?q= URLs, skeleton, real API + mock fallback. */

const MOCK = [
  {
    url: "https://example.com/search-guide",
    title: "Example Search Guide - Learn How Search Works",
    snippet:
      "Search engines crawl the web, build an inverted index of every word, and rank matching documents with algorithms like BM25. This guide walks through crawling, indexing, and ranking step by step.",
    wordCount: 1200,
  },
  {
    url: "https://developer.mozilla.org/en-US/docs/Web",
    title: "MDN Web Docs - Search Result Example",
    snippet:
      "MDN Web Docs is the reference for open web standards: HTML, CSS, and JavaScript. Each page is indexed by its headings, code samples, and browser compatibility tables for fast lookup.",
    wordCount: 3400,
  },
  {
    url: "https://www.bbc.com/news/world",
    title: "BBC News - World Service Example Story",
    snippet:
      "Breaking news, analysis, and features from correspondents around the world. Coverage spans politics, science, culture, and technology with live reporting updated around the clock.",
    wordCount: 800,
  },
];

const form = document.getElementById("form");
const q = document.getElementById("q");
const box = document.getElementById("results");
const meta = document.getElementById("meta");
const stats = document.getElementById("stats");
const footStats = document.getElementById("foot-stats");
const country = document.getElementById("country");
const hero = document.getElementById("hero");

fetch("/api/stats").then((r) => r.json()).then((s) => {
  const t = `${s.docCount} docs · ${s.termCount} terms`;
  stats.textContent = t;
  footStats.textContent = t;
}).catch(() => { stats.textContent = "index offline"; });

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
}

function highlight(text, query) {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9à-ÿ]+/i).filter((t) => t.length > 1))];
  let out = esc(text);
  for (const t of terms) {
    out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
  }
  return out;
}

function row(h, i, query) {
  const el = document.createElement("article");
  el.className = "row";
  el.innerHTML = `<div class="num"></div><div><a class="title" target="_blank" rel="noopener"></a><br><span class="domain"></span><p class="snippet"></p><div class="foot"></div></div>`;
  el.querySelector(".num").textContent = String(i + 1).padStart(2, "0");
  const a = el.querySelector(".title");
  a.href = h.url;
  a.textContent = h.title;
  el.querySelector(".domain").textContent = domainOf(h.url);
  el.querySelector(".snippet").innerHTML = highlight(h.snippet, query);
  el.querySelector(".foot").textContent = `score ${h.score ?? "—"} · ${(h.wordCount ?? 0).toLocaleString()} words`;
  return el;
}

function skeleton() {
  box.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const s = document.createElement("div");
    s.className = "skelrow";
    s.innerHTML = `<div class="a"></div><div class="b"></div><div class="c"></div>`;
    box.appendChild(s);
  }
}

async function run(query, push = true) {
  hero.classList.toggle("compact", true);
  if (push) history.replaceState(null, "", query ? `/?q=${encodeURIComponent(query)}` : "/");
  if (!query) {
    hero.classList.toggle("compact", false);
    meta.textContent = "";
    box.innerHTML = "";
    country.hidden = true;
    return;
  }
  meta.textContent = "Searching…";
  country.hidden = true;
  skeleton();
  let hits, label, cc = "XX", cname = "";
  try {
    if (new URLSearchParams(location.search).get("mock") === "1") throw 0;
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=10`);
    if (!res.ok) throw 0;
    const data = await res.json();
    hits = data.hits;
    cc = data.countryCode || "XX";
    cname = data.country || "";
    label = `${data.count} result${data.count === 1 ? "" : "s"} in ${data.tookMs}ms`;
  } catch {
    hits = MOCK;
    label = `${MOCK.length} results (mock data — API unreachable)`;
  }
  if (cc !== "XX") {
    country.textContent = `tuned for ${cname}`;
    country.hidden = false;
  }
  meta.textContent = label;
  box.innerHTML = "";
  if (hits.length === 0) {
    box.innerHTML = `<div class="empty">Nothing for “${esc(query)}”. Try fewer or different words.</div>`;
    return;
  }
  hits.forEach((h, i) => box.appendChild(row(h, i, query)));
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  run(q.value.trim());
});

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== q) { e.preventDefault(); q.focus(); }
});

const initial = new URLSearchParams(location.search).get("q") || "";
q.value = initial;
run(initial, false);
