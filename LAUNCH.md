# Publishing MiniSearch on Discord

A runbook for announcing MiniSearch in your Discord server (and beyond), in the
order that actually matters: fix what's broken, gather assets, then post.

---

## 1. Pre-flight — fix these before a single stranger sees it

People judge in about ten seconds. Three things currently cost you that window.

### 1.1 Turn on HTTPS (blocking)

Your live server reports `build: cf83a1c`. The TLS work is `11a2a52`, so nobody
can see it yet — and an `http://` link inside a Discord embed is the fastest way
to lose clicks.

```bash
# restart the panel (pulls 11a2a52), then in the Files tab add to .env:
DUCKTNS_TOKEN=<your duckdns token>
ACME_EMAIL=you@example.com

bash tls-cert.sh check     # verify what is on disk
bash tls-cert.sh           # issue via DNS-01 and install
bash tls-cert.sh cron      # daily renewal
```

Then restart once more so the server loads the certificate. Confirm:

```
GET /api/stats  →  "tls": { "enabled": true, "notAfter": "…", "issuer": "…" }
```

### 1.2 Failed thumbnails leave an empty box (visible, cheap fix)

When a thumbnail 404s or is blocked, `public/app.js` removes the `<img>` but
leaves the `has-thumb` class on the card, so the 118px grid column stays reserved
and you see a dark empty rectangle at the start of the row. It shows up in the
desktop screenshot below.

```js
// public/app.js — the thumb error handler
thumb.addEventListener("error", () => {
  thumb.remove();
  li.classList.remove("has-thumb"); // <- add this line
});
```

### 1.3 The domain facets lead with junk

The facet chips count documents, not trust, so `whec.com`, `blog.alexewerlof.com`
and `alicegg.tech` appear first even though those pages are demoted in ranking.
It reads as "this index is made of link farms", which is half-true.

Cheapest option: weight the facet count by the same trust multiplier used for
ranking, so curated domains lead. Alternative: crop screenshots below the facet
row. I'd fix the facet count — it's ~3 lines in `runSearch` and `apiv1.ts`.

### 1.4 Know your real numbers before you write anything

From `/api/stats` right now: **934 documents, 78,442 terms, 934-doc corpus**.
Lead with the pipeline, not the size. "A search engine I built end to end on a
1 GB VPS" is a strong, true claim. "Searches the web" is not yet true, and one
person asking "how big is your index?" should not be able to catch you out.

---

## 2. Assets

| Asset | Where it is | Notes |
| --- | --- | --- |
| Desktop screenshot | `.openchamber/screenshots/minisearch-search-desktop-*.jpg` | Shows AI overview + #1 video result |
| Mobile screenshot | `.openchamber/screenshots/minisearch-mobile-*.jpg` | Proves it works on a phone |
| API docs screenshot | `/api.html` in the browser | Shows the public API |
| 30–45s screen recording | Record on your phone | Search → switch to Videos tab → open AI panel |
| Server line | from `GET /api/stats` | e.g. `MiniSearch 0.3.1 · 934 docs · 78.442 terms` |

**Pick the demo query carefully.** `never gonna give you up` is ideal: the right
answer is #1 with 4/4 terms matched, it demonstrates exact-phrase ranking, and the
Videos tab shows the media classification working. Avoid queries where your thin
corpus shows its weakness as the first impression.

---

## 3. Where to post

**Your own server first.** Post in `#announcements`, then a `#showcase` channel
if you have one, and pin it. Announcing to your own community first means the
first replies are friendly, which sets the tone for everyone who arrives later.

**Then, only where self-promotion is allowed.** Read the rules before posting.
Good fits: `r/programming`, `r/webdev`, `r/selfhosted`, `r/opensource`,
Hacker News (`Show HN:`), Lobsters. Most ban drive-by link drops — write the
post so it stands up even if nobody clicks.

**Timing:** Tuesday–Thursday, roughly 16:00–20:00 in your audience's timezone. Not
3am on a Sunday.

---

## 4. The post

### 4a. Full announcement (your server)

```
**MiniSearch — a search engine I built end to end** 🔎

Tiny search engine running on a 1 GB VPS: it crawls the web itself, builds a
BM25 index, and answers with citations. No Google, no Bing, no third-party search
API — the whole pipeline is in the repo.

**Try it:** https://minisearch.duckdns.org:6036
**Code:** https://github.com/JustScriptzz/search-engine
**API:** https://minisearch.duckdns.org:6036/api.html (open, no key, 60 req/min)

What's actually working:
• crawler with robots.txt, per-host politeness and a junk-URL filter
• BM25 + title/phrase matching, trust tiers, geo and language boosts
• vertical search — images, videos and shorts, classified from page metadata
• AI overview above the results, and an agent that reads pages and cites them
• public JSON API, self-describing at /api/v1
• 934 documents indexed on 1 GB of RAM right now

Honest limitations: the index is small (934 docs), big providers rate-limit
datacenters, so coverage is uneven. It knows a lot about the sites I seeded and
almost nothing about the rest of the web. That's the next thing I'm working on.

I'd love feedback on two things:
1. does the ranking put the right page at #1 for the queries you actually care about?
2. what should I seed next — which sites are worth crawling?

(yes, search for "never gonna give you up")
```

### 4b. Short version (for a busier channel)

```
🔎 **MiniSearch** — my own search engine, live on a 1 GB VPS.

It crawls, indexes with BM25, and shows an AI answer with sources. Open JSON API,
no key. 934 docs so far — small, but it's mine end to end.

https://minisearch.duckdns.org:6036  ·  github.com/JustScriptzz/search-engine

Try "never gonna give you up". Then tell me what it should have found instead.
```

### 4c. Show HN / subreddit style

Title: `Show HN: MiniSearch – a search engine (crawler + BM25 index + AI answers) on a 1 GB VPS`

Lead with the constraint, because it's the interesting part: it fits in 1 GB of
RAM and ~1 GB of disk. Mention the public API early — developers will try that
first. Be explicit that the corpus is small and honest about why.

---

## 5. Discord craft

- **One message, not five.** Link last so the read ends on the call to action.
- **Use an embed** for the visual block: title, one-line description, colour
  `#c9f24d` (your accent), the desktop screenshot as the image, site as the URL
  link. Put the longer text in the message body beneath it.
- **Ask a specific question.** "What should I seed next?" gets replies; "thoughts?"
  gets nothing. Specific questions are also the best feedback you can get.
- **Pin it** and leave it up. A launch post people scroll past in a week is wasted.
- **Seed two reactions** (🔥 and 🧠) from your own alt/account only if that's normal
  in your server — otherwise let it be organic.
- **Put the phone screenshot in the second message**, not the first. Mobile proof is
  a reply-level detail; the first message should land the idea.

---

## 6. After posting

| When | Do |
| --- | --- |
| Same day | Reply to every question, even short ones. Ask follow-ups. |
| Day 2 | Post a short thread: "what people asked" + the two best bug reports you got. |
| Week 1 | Post what you changed because of the feedback. This is what makes people come back. |
| Ongoing | Watch `/api/v1/stats` for doc growth; note which queries people try. |

The questions people ask are the roadmap. If five people ask "does it search
Italian sites?", that's your next commit.

---

## 7. Replies you will get, with honest answers

**"Why not just use Google?"**
Google indexes ~100 billion pages; mine has 934. The point isn't parity — it's
that the whole pipeline is inspectable, runs in 1 GB, and I can change how it
ranks. I'd use both.

**"Is it open source?"**
Yes: https://github.com/JustScriptzz/search-engine — Bun + TypeScript, zero
runtime dependencies, 127 tests.

**"How does the ranking work?"**
BM25 (k1=1.2, b=0.75) with the title weighted in, an exact-phrase boost, a
coordination factor so a page matching all query terms beats one matching two,
PageRank-ish authority from the crawl's own link graph, country and language
boosts, and a trust tier that demotes anything found by Common Crawl over
anything I seeded on purpose.

**"Can I use it in my project?"**
Yes: `GET /api/v1/search?q=…&limit=…&type=…&country=…`, JSON, CORS open,
60 req/min per IP, no key. It describes itself at `/api/v1`.

**"Why doesn't [site] show up?"**
Almost always coverage, not a bug: either the site refused the crawler
(datacenter IPs get rate-limited) or it isn't in the index yet. Ask
`/api/doctor` — it lists exactly which hosts are reachable and which are indexed.

---

## 8. Do not

- Do not claim coverage you don't have. One caught exaggeration costs more trust
  than the launch gains.
- Do not open with the API docs. People want to see the thing; the API is for
  developers who come back for the second visit.
- Do not argue that your engine beats Google. Say what's true and move on.
- Do not post and disappear. The first 24 hours of replies is the whole launch.
- Do not delete criticism. Answer it in public.

---

## 9. Copy-paste checklist

- [ ] HTTPS live, `/api/stats` shows `tls.enabled: true`
- [ ] Thumbnail layout hole fixed
- [ ] Facet chips lead with curated domains
- [ ] Screenshots re-taken after the fixes
- [ ] Demo query returns the right answer at #1
- [ ] `/api/stats` numbers copied into the post, accurate
- [ ] Links work in a private window (no session assumptions)
- [ ] Post in `#announcements`, embed built, pinned
- [ ] Two specific questions at the end
- [ ] Calendar reminder for the day-2 thread