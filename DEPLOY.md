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

Measured on the real corpus (510 documents, 22.4 MB heap): **~45 KB of RAM
per document**, of which the postings are ~11 bytes a pair including array
growth headroom (8 bytes of data). The crawler keeps 60% of the container for
the index, minus roughly 80 MB for the server itself:

```
1 GB (old VPS)  →  ~12,000 documents  →  ~230 MB of index
2 GB            →  ~26,000 documents  →  ~500 MB of index ✓
```

The earlier "~23 KB per document" figure in the previous version of this guide
was wrong — it came from synthetic pages with far fewer unique terms than real
ones, and the "~150 MB image" next to it was never built. Both corrected
2026-10-06 against measurements. Budget **2 GB minimum**.

---

## Options, ranked

All prices below were checked on 2026-10-06 against the providers' own pricing
pages and current third-party roundups. Where sources disagree (notably Fly.io's
free tier), that is noted rather than smoothed over.

| Platform | What you get | Real cost for this app | Verdict |
| --- | --- | --- | --- |
| **Fly.io** | shared-cpu-1x 1 GB ≈ **$5.92/mo** continuous; 2 GB ≈ **$15.56/mo**; volumes **$0.15/GB**; dedicated IPv4 **$2/mo** | ~$8/mo for 1 GB + 5 GB volume + IP; ~$18/mo for 2 GB | Best fit. Real volumes, TLS included. Note: extra-RAM pricing rose 20% on Oct 1 2026, and sources disagree on whether any free tier remains for new accounts. |
| **Railway** | Hobby **$5/mo** incl. $5 usage credit; usage billed **$10/GB RAM/mo** | 2 GB continuous ≈ $20 usage − $5 credit + $5 plan ≈ **$20/mo** | Easiest: connect the GitHub repo, set a volume, done. |
| **Hetzner Cloud** | CX23: 2 vCPU / **4 GB** / 40 GB at **€3.99/mo**; CX33: 4 vCPU / 8 GB at **€6.49/mo**; CPX22 (2 vCPU / 4 GB) €7.99/mo | **€3.99/mo** for 4 GB | Cheapest real server by far. EU-only on the cheap plans. A VPS again, in a different place. |
| **Oracle Cloud Always Free** | 2 OCPU / **12 GB** ARM (halved June 2026), 200 GB block, 10 TB egress | **Free** | Genuinely free and the specs fit, but: card required, regions frequently report "out of capacity", and Oracle cut the limits once already. |
| **Render** | Starter $7 (512 MB) / Standard **$25** (2 GB); disks **$0.25/GB**, paid tiers only | ~$26/mo for 2 GB + 5 GB disk | Works, but the free tier **cannot attach a disk and sleeps** — so there is no free path here at all. |

Dropped from the earlier version of this table: Cloud Run (I had no verified
numbers) and the old Hetzner/Oracle figures, which were wrong.

The image itself is small (the `oven/bun:1.4.2-alpine` base is ~40 MB, so the
final image is roughly 60–80 MB), and every platform above runs it: Bun is a
normal binary and there is no build step. Note the Dockerfile has not been
build-tested — there is no Docker on this machine — so expect the first build
on the host to surface something; the `USER` line is written defensively for
exactly that reason.

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

---

## Evaluated and rejected: Cloudflare Workers (2026-10-06)

Checked against Cloudflare's own limits page, not from memory. A Worker cannot
host this app, on either plan:

| Limit (verified) | What the app needs | Result |
| --- | --- | --- |
| 128 MB memory per isolate, both plans | ~45 KB/doc measured → 128 MB holds ~2,800 docs, and the isolate also runs the server | Only a tenth of the current corpus fits |
| 10 ms CPU per request on Free (Paid: 30 s default, 5 min max) | a search over the current index takes ~100–900 ms of CPU | Free tier dies on nearly every query |
| No filesystem | `index.json` lives on disk; the code uses `Bun.file`, `node:fs`, `Bun.serve` | Porting means replacing the runtime, not deploying to it |
| 50 subrequests per request on Free | a fill round fetches hundreds of pages | Crawling cannot run there at any plan |

Cloudflare **Containers** was checked too and also rejected: all disk is
ephemeral ("when a Container instance goes to sleep, the next time it is
started, it will have a fresh disk"), snapshots are still "coming soon", and a
1 GB instance running 24/7 costs roughly $24/mo ($5 base + ~$12.50 CPU + ~$6.25
memory at published rates) — six times Hetzner for a box that forgets the index
every time it sleeps.

The one Cloudflare product that would make sense is Workers Static Assets for
the `public/` frontend, with the API staying where the index lives. Marginal
gain for added moving parts; not done.