import { Frontier } from "./frontier.ts";
import { fetchHtml } from "./fetcher.ts";
import { normalizeUrl, parseHtml } from "./parser.ts";
import { isAllowed } from "./robots.ts";
import { InvertedIndex } from "../index/invertedIndex.ts";
import { normalizeText } from "../index/tokenizer.ts";
import type { CrawledDoc } from "../types.ts";

export interface CrawlOptions {
  maxPages: number;
  concurrency: number;
  sameHostOnly?: boolean;
  politenessMs?: number;
}

export async function crawl(
  seeds: string[],
  index: InvertedIndex,
  opts: CrawlOptions,
  onPage?: (doc: CrawledDoc, count: number) => void,
): Promise<{ crawled: number; errors: number }> {
  const frontier = new Frontier(seeds, opts.politenessMs ?? 800);
  const seedHosts = new Set(seeds.map((s) => { try { return new URL(s).host; } catch { return ""; } }));
  let crawled = 0;
  let errors = 0;
  let active = 0;
  let done = false;

  return new Promise((resolve) => {
    const maybeFinish = () => {
      if ((done || crawled + errors >= opts.maxPages || (frontier.pendingCount === 0 && active === 0))) {
        if (!done) {
          done = true;
          resolve({ crawled, errors });
        }
      }
    };

    const worker = async () => {
      while (!done) {
        if (crawled + errors >= opts.maxPages) break;
        const url = frontier.popReady();
        if (!url) {
          if (active === 0 && frontier.pendingCount === 0) break;
          await sleep(150);
          continue;
        }
        active++;
        try {
          const norm = normalizeUrl(url) ?? url;
          if (!(await isAllowed(norm))) continue;
          const html = await fetchHtml(norm);
          if (!html) {
            errors++;
            continue;
          }
          const parsed = parseHtml(html, norm);
          if (parsed.text.length < 100) {
            errors++;
            continue;
          }
          const doc: CrawledDoc = {
            id: await hashUrl(norm),
            url: norm,
            title: parsed.title,
            text: parsed.text,
            outlinks: parsed.links,
            fetchedAt: new Date().toISOString(),
            contentHash: await hashText(normalizeText(parsed.text)),
            wordCount: parsed.text.split(/\s+/).length,
          };
          const added = index.addDocument(doc);
          if (added) {
            crawled++;
            onPage?.(doc, crawled);
          }
          // enqueue outlinks
          let links = parsed.links;
          if (opts.sameHostOnly) {
            links = links.filter((l) => {
              try { return seedHosts.has(new URL(l).host); } catch { return false; }
            });
          }
          frontier.pushMany(links, opts.maxPages * 10);
        } catch {
          errors++;
        } finally {
          active--;
          maybeFinish();
        }
      }
      maybeFinish();
    };

    const workers = Array.from({ length: opts.concurrency }, () => worker());
    Promise.all(workers).then(() => maybeFinish());
    // safety: if queue stalls, finish when no progress
    const watchdog = setInterval(() => {
      if (done) clearInterval(watchdog);
      else maybeFinish();
    }, 500);
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function hashUrl(s: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(s);
  return h.digest("hex").slice(0, 16);
}

async function hashText(s: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  h.update(s.slice(0, 8000));
  return h.digest("hex").slice(0, 16);
}
