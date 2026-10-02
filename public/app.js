/* Shared vanilla JS for the Google-clone frontend.
   Homepage: Enter -> /results.html?q=...
   Results:  read ?q=, skeleton, fetch real /api/search, fall back to mock. */

// ---------- mock data (used if the API is unreachable, or ?mock=1) ----------
const MOCK = [
  {
    url: "https://example.com/search-guide",
    title: "Example Search Guide - Learn How Search Works",
    snippet:
      "Search engines crawl the web, build an inverted index of every word, and rank matching documents with algorithms like BM25. This guide walks through crawling, indexing, and ranking step by step.",
  },
  {
    url: "https://developer.mozilla.org/en-US/docs/Web",
    title: "MDN Web Docs - Search Result Example",
    snippet:
      "MDN Web Docs is the reference for open web standards: HTML, CSS, and JavaScript. Each page is indexed by its headings, code samples, and browser compatibility tables for fast lookup.",
  },
  {
    url: "https://www.bbc.com/news/world",
    title: "BBC News - World Service Example Story",
    snippet:
      "Breaking news, analysis, and features from correspondents around the world. Coverage spans politics, science, culture, and technology with live reporting updated around the clock.",
  },
];

function crest(host) {
  const ch = (host || "?").charAt(0).toUpperCase();
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="26" height="26">` +
    `<rect width="26" height="26" rx="13" fill="#303134"/>` +
    `<text x="13" y="18" font-size="14" text-anchor="middle" fill="#e8eaed" font-family="Arial">${ch}</text></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

function crumbOf(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, "").split("/").filter(Boolean).slice(0, 2).join(" › ");
    return `${u.hostname}${path ? " › " + path : ""}`;
  } catch {
    return url;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function card(h) {
  const host = (() => { try { return new URL(h.url).hostname; } catch { return h.url; } })();
  const el = document.createElement("div");
  el.className = "card";
  el.innerHTML = `<div class="crumb"></div><h3></h3><p></p>`;
  const img = document.createElement("img");
  img.className = "fav";
  img.alt = "";
  img.src = crest(host);
  el.querySelector(".crumb").append(img, document.createTextNode(crumbOf(h.url)));
  const a = document.createElement("a");
  a.href = h.url;
  a.textContent = h.title;
  el.querySelector("h3").appendChild(a);
  el.querySelector("p").textContent = h.snippet;
  return el;
}

function skeleton(box) {
  box.innerHTML = "";
  for (let i = 0; i < 3; i++) {
    const s = document.createElement("div");
    s.className = "skel";
    s.innerHTML = `<div class="l1"></div><div class="l2"></div><div class="l3"></div><div class="l4"></div>`;
    box.appendChild(s);
  }
}

async function realSearch(query) {
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=10`);
  if (!res.ok) throw new Error("api " + res.status);
  const data = await res.json();
  return { hits: data.hits, meta: `About ${data.count} results (${(data.tookMs / 1000).toFixed(2)} seconds)` };
}

// ---------- homepage ----------
const homeForm = document.getElementById("home-form");
if (homeForm) {
  const input = document.getElementById("home-q");
  homeForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (query) location.href = `/results.html?q=${encodeURIComponent(query)}`;
  });
  const lucky = document.getElementById("lucky");
  if (lucky) lucky.addEventListener("click", () => {
    const query = input.value.trim();
    if (query) location.href = `/results.html?q=${encodeURIComponent(query)}`;
  });
}

// ---------- results page ----------
const rForm = document.getElementById("r-form");
if (rForm) {
  const params = new URLSearchParams(location.search);
  const query = params.get("q") || "";
  const input = document.getElementById("r-q");
  const box = document.getElementById("r-results");
  const meta = document.getElementById("r-meta");
  input.value = query;
  document.title = query ? `${query} - Google Search` : "Google Search";

  rForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const next = input.value.trim();
    if (next && next !== query) location.href = `/results.html?q=${encodeURIComponent(next)}`;
  });

  (async () => {
    if (!query) {
      meta.textContent = "";
      box.innerHTML = `<p class="empty">Type a query above and press Enter.</p>`;
      return;
    }
    skeleton(box); // dark loading state while the async fetch runs
    let hits, label;
    try {
      if (new URLSearchParams(location.search).get("mock") === "1") throw 0;
      ({ hits, meta: label } = await realSearch(query));
    } catch {
      hits = MOCK; // offline fallback: 3 mock JSON objects mapped into the DOM
      label = `About ${MOCK.length} results (mock data — API unreachable)`;
    }
    box.innerHTML = "";
    for (const h of hits) box.appendChild(card(h));
    meta.textContent = label;
  })();
}
