import { Frontier } from "./frontier.ts";
import { fetchHtml } from "./fetcher.ts";
import { normalizeUrl, parseHtml } from "./parser.ts";
import { isAllowed } from "./robots.ts";
import { isAllowedLanguage } from "../lang.ts";
import { isJunkUrl, isLowQualityText } from "../quality.ts";
import { CONFIG } from "../config.ts";
import { InvertedIndex } from "../index/invertedIndex.ts";
import { normalizeText } from "../index/tokenizer.ts";
import type { CrawledDoc } from "../types.ts";

export interface CrawlOptions {
  maxPages?: number;
  concurrency?: number;
  sameHostOnly?: boolean;
  politenessMs?: number;
  /** Set false to keep non-Latin pages (debugging). */
  filterLanguage?: boolean;
}

export interface CrawlResult {
  crawled: number;
  errors: number;
  skippedLanguage: number;
  skippedRobots: number;
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

  let crawled = 0;
  let errors = 0;
  let skippedLanguage = 0;
  let skippedRobots = 0;
  let active = 0;
  let done = false;

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
          if (isLowQualityText(parsed.text) || parsed.text.length < CONFIG.crawl.minTextChars) {
            errors++;
            continue;
          }
          if (filterLanguage && !isAllowedLanguage(parsed.text)) {
            skippedLanguage++;
            continue;
          }
          const doc: CrawledDoc = {
            id: hash(norm),
            url: norm,
            title: parsed.title,
            text: parsed.text,
            lang: parsed.lang,
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

function hash(s: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(s);
  return h.digest("hex").slice(0, 16);
}