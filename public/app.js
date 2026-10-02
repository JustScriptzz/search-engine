const form = document.getElementById("form");
const q = document.getElementById("q");
const results = document.getElementById("results");
const meta = document.getElementById("meta");
const stats = document.getElementById("stats");

fetch("/api/stats").then((r) => r.json()).then((s) => {
  stats.textContent = `${s.docCount} docs · ${s.termCount} terms`;
}).catch(() => { stats.textContent = "no index yet — run crawl first"; });

async function run(query) {
  if (!query) return;
  meta.textContent = "Searching…";
  results.innerHTML = "";
  const res = await fetch(`/api/search?q=${encodeURIComponent(query)}&limit=10`);
  const data = await res.json();
  const tuned = data.countryCode && data.countryCode !== "XX" ? ` · tuned for ${data.country}` : "";
  meta.textContent = `${data.count} results in ${data.tookMs}ms for "${data.query}"${tuned}`;
  for (const h of data.hits) {
    const div = document.createElement("div");
    div.className = "hit";
    div.innerHTML = `<a class="title" href="${h.url}" target="_blank" rel="noopener"></a>
      <div class="url"></div><p class="snippet"></p><div class="score"></div>`;
    div.querySelector(".title").textContent = h.title;
    div.querySelector(".url").textContent = h.url;
    div.querySelector(".snippet").textContent = h.snippet;
    div.querySelector(".score").textContent = `score ${h.score} · ${h.wordCount} words`;
    results.appendChild(div);
  }
  if (data.hits.length === 0) results.innerHTML = "<p>No results. Crawl more pages first.</p>";
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const query = q.value.trim();
  history.replaceState(null, "", query ? `/?q=${encodeURIComponent(query)}` : "/");
  run(query);
});

const initial = new URLSearchParams(location.search).get("q");
if (initial) { q.value = initial; run(initial); }
