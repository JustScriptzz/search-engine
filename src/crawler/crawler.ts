import { Frontier } from "./frontier.ts";
import { fetchHtml } from "./fetcher.ts";
import { normalizeUrl, parseHtml } from "./parser.ts";
import { isAllowed } from "./robots.ts";
import { isAllowedLanguage } from "../lang.ts";
import { isFamousHost, FAMOUS_SITES } from "../famous.ts";
import { isJunkUrl, isLowQualityText } from "../quality.ts";
import { CONFIG } from "../config.ts";
import { InvertedIndex } from "../index/invertedIndex.ts";
import { normalizeText } from "../index/tokenizer.ts";
import type { CrawledDoc } from "../types.ts";

const FAMOUS_SITE_URLS = FAMOUS_SITES.map((s) => s.url);
const FAMOUS_SEED_SET = new Set(FAMOUS_SITE_URLS.map((u) => normalizeUrl(u) ?? u));

/** True only for an allowlisted site's own canonical URL. */
function isFamousSeedUrl(url: string): boolean {
  return FAMOUS_SEED_SET.has(url);
}

export interface CrawlOptions {
  maxPages?: number;
  concurrency?: number;
  sameHostOnly?: boolean;
  politenessMs?: number;
  /** Set false to keep non-Latin pages (debugging). */
  filterLanguage?: boolean;
  /** Max pages per host; 0 disables the cap. */
  maxPagesPerHost?: number;
}

export interface CrawlResult {
  crawled: number;
  errors: number;
  skippedLanguage: number;
  skippedRobots: number;
}

/** Fetch allowlisted site roots first, slowly and with a generous timeout.
 *  A wide crawl starves them otherwise (timeouts under concurrency), which is
 *  exactly why "google" used to return nothing but pages mentioning Google. */
export async function bootstrapFamousSites(
  index: InvertedIndex,
  opts: { limit?: number; onPage?: (doc: CrawledDoc, n: number) => void } = {},
): Promise<{ fetched: number; failed: number }> {
  const wanted = FAMOUS_SITE_URLS.filter((u) => {
    try {
      // exact host only: profile.google.com must not satisfy google.com
      return !index.hasExactHost(new URL(u).hostname);
    } catch {
      return false;
    }
  }).slice(0, opts.limit ?? 40);

  if (wanted.length === 0) return { fetched: 0, failed: 0 };

  let fetched = 0;
  let failed = 0;
  for (const url of wanted) {
    const norm = normalizeUrl(url) ?? url;
    if (index.hasExactHost(safeHost(norm))) continue;
    if (!(await isAllowed(norm))) {
      failed++;
      continue;
    }
    const html = await fetchHtml(norm, { timeoutMs: CONFIG.crawl.timeoutMs }, 2);
    if (!html) {
      // Big sites (Google included) throttle datacenter IPs. Still record a
      // stub entry so the site resolves by name; it carries no page content.
      const site = FAMOUS_SITES.find((s) => (normalizeUrl(s.url) ?? s.url) === norm);
      const stub: CrawledDoc = {
        id: hash(norm),
        url: norm,
        title: site?.name ?? safeHost(norm),
        text: `${site?.name ?? safeHost(norm)} — ${safeHost(norm)}. Listed in the MiniSearch allowlist; the page itself was not fetched (blocked or throttled).`,
        lang: "",
        siteCard: true,
        stub: true,
        outlinks: [],
        fetchedAt: new Date().toISOString(),
        contentHash: hash(`stub:${norm}`),
        wordCount: 12,
      };
      if (index.addDocument(stub)) fetched++;
      failed++;
      continue;
    }
    const parsed = parseHtml(html, norm);
    const words = parsed.text.split(/\s+/).filter(Boolean).length;
    const thin =
      isLowQualityText(parsed.text) ||
      parsed.text.length < CONFIG.crawl.minTextChars ||
      words < 30 ||
      parsed.linkDensity > CONFIG.quality.maxLinkDensity;
    const text = thin ? siteCardText(parsed, norm) : parsed.text;
    if (!thin && !isAllowedLanguage(parsed.text)) {
      failed++;
      continue;
    }
    const doc: CrawledDoc = {
      id: hash(norm),
      url: norm,
      title: parsed.title || safeHost(norm),
      text,
      lang: parsed.lang,
      linkDensity: parsed.linkDensity,
      media: parsed.media,
      siteCard: thin,
      outlinks: [],
      fetchedAt: new Date().toISOString(),
      contentHash: hash(normalizeText(text)),
      wordCount: text.split(/\s+/).length,
    };
    if (index.addDocument(doc)) {
      fetched++;
      opts.onPage?.(doc, fetched);
    }
  }
  return { fetched, failed };
}

export async function crawl(
  seeds: string[],
  index: InvertedIndex,
  opts: CrawlOptions = {},
  onPage?: (doc: CrawledDoc, count: number) => void,
): Promise<CrawlResult> {
  const maxPages = opts.maxPages ?? CONFIG.crawl.maxPages;
  const concurrency = opts.concurrency ?? CONFIG.crawl.concurrency;
  const filterLanguage = opts.filterLanguage ?? true;

  const frontier = new Frontier(seeds, opts.politenessMs ?? CONFIG.crawl.politenessMs);
  const seedHosts = new Set(
    seeds.map((s) => {
      try {
        return new URL(s).host;
      } catch {
        return "";
      }
    }),
  );
  // Explicit seeds are curated intent: they are fetched whatever the per-host
  // cap says. Otherwise the first seed on a host (its link-heavy homepage) burns
  // the whole quota and the specific pages we actually wanted are dropped
  // before anyone asks — which is how youtube.com/watch?v=... went missing.
  const seedUrlSet = new Set(seeds.map((s) => normalizeUrl(s) ?? s));

  let crawled = 0;
  let errors = 0;
  let skippedLanguage = 0;
  let skippedRobots = 0;
  let active = 0;
  let done = false;
  // Without a per-host cap the frontier gets monopolised by whichever seed
  // links the most, and later seeds never get fetched at all.
  const perHost = opts.maxPagesPerHost ?? CONFIG.crawl.maxPagesPerHost;
  const hostCounts = new Map<string, number>();

  return new Promise((resolve) => {
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(watchdog);
      resolve({ crawled, errors, skippedLanguage, skippedRobots });
    };
    const maybeFinish = () => {
      if (crawled + errors >= maxPages) return finish();
      if (frontier.pendingCount === 0 && active === 0) finish();
    };

    const worker = async () => {
      while (!done) {
        if (crawled + errors >= maxPages) break;
        const url = frontier.popReady();
        if (!url) {
          if (active === 0 && frontier.pendingCount === 0) break;
          await sleep(150);
          continue;
        }
        const host = safeHost(url);
        const isSeed = seedUrlSet.has(normalizeUrl(url) ?? url);
        if (!isSeed && perHost > 0 && (hostCounts.get(host) ?? 0) >= perHost) {
          // Already had our share of this host; drop it from the frontier.
          continue;
        }
        hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
        active++;
        try {
          const norm = normalizeUrl(url) ?? url;
          if (!(await isAllowed(norm))) {
            skippedRobots++;
            continue;
          }
          const html = await fetchHtml(norm);
          if (!html) {
            errors++;
            continue;
          }
          const parsed = parseHtml(html, norm);
          // Cards are only minted for an allowlisted site's canonical URL, never for
          // arbitrary pages on a famous host (account./investor./skills. etc.).
          const cardable = isFamousSeedUrl(norm);
          const words = parsed.text.split(/\s+/).filter(Boolean).length;
          // Link-heavy pages (homepages, section indexes) are "thin" for search
          // purposes: on a famous host we still keep them as a site card, on
          // anything else they are dropped.
          const thin =
            isLowQualityText(parsed.text) ||
            parsed.text.length < CONFIG.crawl.minTextChars ||
            words < 30 ||
            parsed.linkDensity > CONFIG.quality.maxLinkDensity;
          // A video/image page IS its metadata: title + description + thumbnail.
          // These stay indexable even when the body is a link farm, which is
          // why searching a video's title can now actually find it.
          const mediaCard = thin && parsed.media.type !== "text" && (parsed.title.length > 0 || parsed.description.length > 0);
          if (thin && !cardable && !mediaCard) {
            errors++;
            continue;
          }
          if (filterLanguage && !mediaCard && !isAllowedLanguage(parsed.text)) {
            skippedLanguage++;
            continue;
          }
          const doc: CrawledDoc = {
            id: hash(norm),
            url: norm,
            title: parsed.title,
            text: mediaCard ? mediaCardText(parsed, norm) : thin ? siteCardText(parsed, norm) : parsed.text,
            lang: parsed.lang,
            linkDensity: parsed.linkDensity,
            siteCard: thin,
            mediaCard,
            media: parsed.media,
            outlinks: parsed.links,
            fetchedAt: new Date().toISOString(),
            contentHash: hash(normalizeText(parsed.text)),
            wordCount: parsed.text.split(/\s+/).length,
          };
          if (index.addDocument(doc)) {
            crawled++;
            onPage?.(doc, crawled);
          }
          let links = parsed.links.filter((l) => !isJunkUrl(l));
          if (opts.sameHostOnly) {
            links = links.filter((l) => {
              try {
                return seedHosts.has(new URL(l).host);
              } catch {
                return false;
              }
            });
          }
          frontier.pushMany(links, Math.max(maxPages, crawled) * CONFIG.crawl.maxOutlinksQueued);
        } catch {
          errors++;
        } finally {
          active--;
          maybeFinish();
        }
      }
      maybeFinish();
    };

    const workers = Array.from({ length: concurrency }, () => worker());
    Promise.all(workers).then(finish);
    const watchdog = setInterval(() => {
      if (done || (active === 0 && frontier.pendingCount === 0)) finish();
    }, 500);
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Drop social/video/ad and account-wall links before they enter the frontier. */
export { isJunkUrl };

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function pathDepth(url: string): number {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).length;
  } catch {
    return 99;
  }
}

/** Title + first real sentences of a homepage, so it is searchable at all. */
function siteCardText(parsed: { title: string; text: string }, url: string): string {
  const sentences = parsed.text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 40 && s.length < 220);
  const body = sentences.slice(0, 4).join(" ");
  const host = safeHost(url);
  return `${parsed.title} — ${host}. ${body}`.trim();
}

/** Video/image record: the page's own title and description, repeated so the
 *  title terms carry weight, plus the provider name. */
function mediaCardText(
  parsed: { title: string; description: string; media: { provider?: string; type: string } },
  url: string,
): string {
  const provider = parsed.media.provider ?? safeHost(url);
  return [parsed.title, parsed.title, parsed.description, `${parsed.media.type} ${provider}`]
    .filter(Boolean)
    .join(". ")
    .trim();
}

function hash(s: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(s);
  return h.digest("hex").slice(0, 16);
}