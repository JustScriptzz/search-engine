
import { CONFIG } from "./config.ts";
import { FAMOUS_SITES, type FamousSite } from "./famousSites.ts";

// The site data lives in its own leaf module: config.ts needs the allowlist and
// this module needs CONFIG, so keeping them together would make the two import
// each other in a cycle and blow up depending on which one loads first.
export { FAMOUS_SITES };
export type { FamousSite };

/** Hosts (and their subdomains) that get the site-card treatment. */
const FAMOUS_HOSTS = new Set<string>();

export function initFamousHosts(sites: FamousSite[] = FAMOUS_SITES): void {
  FAMOUS_HOSTS.clear();
  for (const site of sites) {
    try {
      FAMOUS_HOSTS.add(new URL(site.url).hostname.replace(/^www\./, "").toLowerCase());
    } catch {
      // ignore malformed seed
    }
  }
}

export function isFamousHost(hostname: string): boolean {
  if (FAMOUS_HOSTS.size === 0) initFamousHosts();
  const host = hostname.replace(/^www\./, "").toLowerCase();
  if (FAMOUS_HOSTS.has(host)) return true;
  for (const known of FAMOUS_HOSTS) {
    if (host.endsWith(`.${known}`)) return true;
  }
  return false;
}

/** Hosts we chose on purpose: the seed list plus the allowlist, including their
 *  subdomains. Anything else reached us through Common Crawl or certificate
 *  transparency, which is where the link-farm spam comes from.
 *  Built lazily: config.ts imports this module, so CONFIG is not ready yet at
 *  module-evaluation time. */
let trustedHosts: Set<string> | null = null;

function trustedHostSet(): Set<string> {
  if (trustedHosts) return trustedHosts;
  const set = new Set<string>();
  for (const u of CONFIG.seeds) {
    try {
      set.add(new URL(u).hostname.replace(/^www\./, "").toLowerCase());
    } catch {
      // ignore malformed seed
    }
  }
  trustedHosts = set;
  return set;
}

export function isTrustedHost(hostname: string): boolean {
  if (isFamousHost(hostname)) return true;
  const host = hostname.replace(/^www\./, "").toLowerCase();
  if (!host) return false;
  const set = trustedHostSet();
  if (set.has(host)) return true;
  for (const known of set) {
    if (host.endsWith(`.${known}`)) return true;
  }
  return false;
}

initFamousHosts();
