# Hosting MiniSearch after the VPS

The app is now portable. One container image runs on any host that runs Docker,
and nothing in it depends on Pterodactyl.

```bash
docker build -t minisearch .
docker run -p 3000:3000 \
  -v minisearch-data:/data \
  -e SERVER_INDEX_PATH=/data/index.json \
  -e EMBEDDING_API_KEY=nvapi-… \
  -e COGITO_API_KEY=cog-live-… \
  minisearch
```

Two settings matter more than anything else:

| Variable | Why |
| --- | --- |
| `SERVER_INDEX_PATH` | Point it at a **mounted volume**. Without persistent storage the index is lost on every restart. |
| `AUTO_FILL=0` | Don't crawl during boot. Deploy platforms have start timeouts; fill deliberately instead. |

`PORT` and `HOST` are read automatically. `GET /healthz` is the health check
(cheap, no network, no index reads).

**TLS:** on every platform below, HTTPS is terminated for you and you get a
certificate automatically. So `tls-cert.sh` and `fullchain.pem` are only needed
when you run the image yourself on a bare machine.

---

## The constraint that actually decides this

The deleted VPS had **1 GB of RAM**, and that — not disk — was the limit:

```
67 KB of RAM per document  →  4,000–8,500 documents  →  ~160 MB of index
```

With the typed-array postings (8 bytes per posting pair, down from a Map entry)
a document costs about 23 KB. So on **2 GB you get ~25,000 documents**, and on
**4 GB you can actually fill the 500 MB budget** we set. Moving off the 1 GB VPS
is the thing that makes that number reachable.

Budget for **2 GB minimum, 4 GB if you want the full corpus.**

---

## Options, ranked

| Platform | RAM | Disk | Cost | Verdict |
| --- | --- | --- | --- | --- |
| **Fly.io** | up to 8 GB | Fly Volumes, per GB | ~$5–15/mo | Best fit. Real volumes, long-lived, fast machines, TLS included. |
| **Railway** | 512 MB–8 GB | Volume | ~$5–20/mo | Easiest: connect the GitHub repo, set a volume, done. |
| **Hetzner Cloud** | 2–4 GB for ~€4/mo | 40–80 GB included | ~€4.5/mo | Cheapest real server, and it's a VPS again. EU/US/US-Singapore. |
| **Oracle Cloud Always Free** | 1 GB ARM (4 OCPU) | 200 GB block | **Free** | Genuinely free, but a credit card and famously hard to provision. |
| **Render** | 512 MB–4 GB | Disk (paid only) | $7–25/mo | Fine, but the free tier has no disk and sleeps. |
| **Cloud Run + GCS** | up to 4 GB | GCS bucket | ~$5–15/mo | Good, but the index must be fetched from object storage on each cold start. |

All of them will run it: Bun is a normal binary, there is no build step, and the
image is ~150 MB.

---

## Fly.io, in full

```bash
fly launch --no-deploy --name minisearch --region lhr
fly volumes create minisearch_data --size 5       # 5 GB, more than enough
fly secrets set EMBEDDING_API_KEY=nvapi-… COGITO_API_KEY=cog-live-…
fly deploy
fly ips allocate                                 # gives you a public address
```

`fly.toml` is generated with the volume and the health check already wired.
Fly issues a TLS certificate for the assigned hostname, so the app needs none.

## Railway, in full

Push the repo, add a **volume** mounted at `/data`, set:

```
SERVER_INDEX_PATH=/data/index.json
AUTO_FILL=0
EMBEDDING_API_KEY=…
COGITO_API_KEY=…
```

Railway assigns `PORT` automatically and terminates TLS at `*.railway.app`.

---

## Two things that will bite you

**1. The index must be rebuilt once.** The new typed-array format is written on
the next save. A fresh container starts with an empty `/data`, so either fill it
once:

```bash
fly ssh console -a minisearch
# inside:
bun src/cli.ts fill --budget-mb 500 --max-minutes 30
```

…or copy the old `index.json` in (it upgrades itself on load).

**2. Do not let it crawl at boot.** `AUTO_FILL=0` is set in the Dockerfile on
purpose. A 25-minute fill during a rolling deploy will get the release killed and
look like a crash.

---

## If you want to keep the domain

Your DuckDNS name pointed at the old VPS's IP, so it now points nowhere. Two
options:

- Point `minisearch.duckdns.org` at the platform's IP (works on Fly and Hetzner).
- Or use the hostname the platform gives you (`minisearch.fly.dev`) and set
  `DUCKTNS_DOMAIN` if you keep the certificate approach.

If the hostname changes, the trust lists don't care — they are domain-based, not
hostname-based.