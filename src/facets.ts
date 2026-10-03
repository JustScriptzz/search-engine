// Domain facets for the result chips.
//
// Counting documents alone put link-farm spam first: whec.com had 4 pages in the
// results, so it led the chips, even though those pages are demoted hard during
// ranking. The chips therefore described the corpus rather than the ranking, and
// read as "this index is made of junk".
//
// Facets now carry the same trust weight the ranking applies, so a curated site
// with three results outranks a discovered one with five. The number shown is
// still a document count (what people expect); it is only the *order* that
// changes, and ties break on trust.

export interface FacetItem {
  domain: string;
  /** Multiplier from the trust tier: curated > 1, discovered < 1. */
  trust: number;
}

export interface Facet {
  domain: string;
  count: number;
}

export function facetCounts(items: FacetItem[], top = 10): Facet[] {
  const counts = new Map<string, { n: number; weight: number }>();
  for (const it of items) {
    if (!it.domain) continue;
    const entry = counts.get(it.domain) ?? { n: 0, weight: 0 };
    entry.n += 1;
    entry.weight += it.trust;
    counts.set(it.domain, entry);
  }
  return [...counts.entries()]
    // Rank on *average* trust, so the tier decides and the document count only
    // breaks ties inside a tier. Summing instead let a link farm win on volume:
    // four discovered pages (4 × 0.3) exactly tied one curated page (1 × 1.2).
    .sort((a, b) => {
      const ta = a[1].weight / a[1].n;
      const tb = b[1].weight / b[1].n;
      return tb - ta || b[1].n - a[1].n || a[0].localeCompare(b[0]);
    })
    .slice(0, top)
    .map(([domain, e]) => ({ domain, count: e.n }));
}