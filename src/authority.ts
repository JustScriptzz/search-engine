// Domain authority, computed from the crawl's own link graph.
//
// Two signals, both free (no external data):
//   - inlinks: how many indexed pages link to a host
//   - PageRank over the host graph, damped and iterated a few times
//
// Results are cached per index "version" (doc count + total terms), so the
// cost is paid once after a crawl and reused for every query.
import { CONFIG } from "./config.ts";
import type { InvertedIndex } from "./index/invertedIndex.ts";

export interface Authority {
  /** host -> 0..1 score, 1 = most linked-to. */
  score: Map<string, number>;
  /** host -> number of distinct indexed pages linking to it. */
  inlinks: Map<string, number>;
  hostCount: number;
}

let cache: { key: string; value: Authority } | null = null;

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function computeAuthority(index: InvertedIndex, opts: { iterations?: number; damp?: number } = {}): Authority {
  const stats = index.stats();
  const key = `${stats.docCount}:${stats.termCount}:${CONFIG.bm25.coordination}`;
  if (cache && cache.key === key) return cache.value;

  const iterations = opts.iterations ?? CONFIG.authority.iterations;
  const damp = opts.damp ?? CONFIG.authority.damping;

  // Host -> outgoing host set, and host -> inlink count.
  const out = new Map<string, Set<string>>();
  const inlinks = new Map<string, number>();
  const hosts = new Set<string>();

  for (const doc of index.docs.values()) {
    const host = hostnameOf(doc.url);
    if (!host) continue;
    hosts.add(host);
    if (!out.has(host)) out.set(host, new Set());
    for (const link of doc.outlinks ?? []) {
      const target = hostnameOf(link);
      if (!target || target === host) continue;
      out.get(host)!.add(target);
      hosts.add(target);
      inlinks.set(target, (inlinks.get(target) ?? 0) + 1);
    }
  }

  const nodes = [...hosts];
  const n = nodes.length;

  if (n === 0) {
    const empty: Authority = { score: new Map(), inlinks, hostCount: 0 };
    cache = { key, value: empty };
    return empty;
  }

  // Seed: inlink mass gives a sane starting vector.
  let rank = new Map<string, number>();
  let totalInlinks = 0;
  for (const h of nodes) {
    const v = 1 + (inlinks.get(h) ?? 0);
    rank.set(h, v);
    totalInlinks += v;
  }
  for (const h of nodes) rank.set(h, rank.get(h)! / totalInlinks);

  const outgoing = (host: string) => out.get(host) ?? new Set<string>();

  for (let i = 0; i < iterations; i++) {
    const next = new Map<string, number>();
    let dangling = 0;
    for (const h of nodes) {
      const links = outgoing(h);
      if (links.size === 0) dangling += rank.get(h) ?? 0;
    }
    for (const h of nodes) {
      let sum = 0;
      for (const [src, links] of out) {
        if (!links.has(h)) continue;
        const denom = outgoing(src).size;
        if (denom > 0) sum += (rank.get(src) ?? 0) / denom;
      }
      next.set(h, (1 - damp) / n + damp * (sum + dangling / n));
    }
    rank = next;
  }

  // Normalise to 0..1 with a mild curve so the top sites separate without
  // letting one giant host flatten everything else.
  const max = Math.max(...[...rank.values()], Number.EPSILON);
  const inlinkMax = Math.max(1, ...[...inlinks.values()]);
  const final = new Map<string, number>();
  for (const [h, v] of rank) {
    const pr = v / max;
    const linkPop = Math.sqrt((inlinks.get(h) ?? 0) / inlinkMax);
    final.set(h, Math.min(1, pr * 0.75 + linkPop * 0.25));
  }

  const value: Authority = { score: final, inlinks, hostCount: n };
  cache = { key, value };
  return value;
}

/** Multiplier applied to a result's score by its host's authority. */
export function authorityBoost(hostname: string, authority: Authority): number {
  const s = authority.score.get(hostname.replace(/^www\./, ""));
  if (s === undefined) return 1;
  return 1 + CONFIG.authority.weight * Math.sqrt(s);
}

/** Curated floor: a well-known root domain should never sink below its peers. */
export function isCuratedRoot(hostname: string, curatedHosts: Set<string>): boolean {
  const host = hostname.replace(/^www\./, "");
  return curatedHosts.has(host);
}

export function resetAuthorityCache(): void {
  cache = null;
}