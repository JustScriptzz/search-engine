const form = document.getElementById("form");
const q = document.getElementById("q");
const results = document.getElementById("results");
const meta = document.getElementById("meta");
const stats = document.getElementById("stats");
const country = document.getElementById("country");

fetch("/api/stats").then((r) => r.json()).then((s) => {
  stats.textContent = `${s.docCount} docs · ${s.termCount} terms indexed`;
}).catch(() => { stats.textContent = "index offline"; });

function esc(s) {
  return s.replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}

function highlight(text, query) {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9à-ÿ]+/i).filter((t) => t.length > 1))];
  let out = esc(text);
  for (const t of terms) {
    out = out.replace(new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"), "<mark>$1</mark>");
  }
  return out;
}

async function run(query) {
  if (!query) return;
  meta.textContent = "Searching…";
  results.innerHTML = "";
  country.hidden = true;
  let data;
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=10`);
    data = await res.json();
  } catch {
    meta.textContent = "Search failed — server unreachable.";
    return;
  }
  if (data.countryCode && data.countryCode !== "XX") {
    country.textContent = `tuned for ${data.country}`;
    country.hidden = false;
  }
  meta.textContent = `${data.count} result${data.count === 1 ? "" : "s"} in ${data.tookMs}ms`;
  if (data.hits.length === 0) {
    results.innerHTML = `<div class="empty">No results for “${esc(query)}”. Try fewer or different words.</div>`;
    return;
  }
  for (const h of data.hits) {
    const div = document.createElement("div");
    div.className = "hit";
    div.innerHTML = `<a class="title" href="${esc(h.url)}" target="_blank" rel="noopener"></a>
      <div class="url"></div><p class="snippet"></p><div class="score"></div>`;
    div.querySelector(".title").textContent = h.title;
    div.querySelector(".url").textContent = h.url;
    div.querySelector(".snippet").innerHTML = highlight(h.snippet, query);
    div.querySelector(".score").textContent = `score ${h.score} · ${h.wordCount} words`;
    results.appendChild(div);
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const query = q.value.trim();
  history.replaceState(null, "", query ? `/?q=${encodeURIComponent(query)}` : "/");
  run(query);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && document.activeElement !== q) { e.preventDefault(); q.focus(); }
});

const initial = new URLSearchParams(location.search).get("q");
if (initial) { q.value = initial; run(initial); }
