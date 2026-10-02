// Minimal IP -> country tuning. Lookup via ip-api.com free endpoint with
// in-memory cache; fail-open to "unknown" so search never blocks on geo.
export interface GeoInfo {
  country: string; // e.g. "Germany" (or "Unknown"/"Local")
  countryCode: string; // ISO-2, e.g. "DE" ("XX" when unknown)
  fromCache: boolean;
}

const cache = new Map<string, { info: GeoInfo; at: number }>();
const TTL_MS = 6 * 60 * 60 * 1000;

export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0].trim();
    if (first) return first;
  }
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  return "local";
}

function isLocalIp(ip: string): boolean {
  return (
    ip === "local" || ip === "::1" || ip === "::ffff:127.0.0.1" ||
    ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

export async function lookupCountry(ip: string, timeoutMs = 700): Promise<GeoInfo> {
  if (isLocalIp(ip)) return { country: "Local", countryCode: "XX", fromCache: false };
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < TTL_MS) return { ...hit.info, fromCache: true };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode`, {
      signal: ctrl.signal,
    });
    if (!res.ok) return unknown();
    const data = (await res.json()) as { status?: string; country?: string; countryCode?: string };
    if (data.status !== "success" || !data.countryCode) return unknown();
    const info: GeoInfo = { country: data.country ?? data.countryCode, countryCode: data.countryCode, fromCache: false };
    cache.set(ip, { info, at: Date.now() });
    if (cache.size > 5000) cache.delete(cache.keys().next().value!);
    return info;
  } catch {
    return unknown();
  } finally {
    clearTimeout(t);
  }
}

function unknown(): GeoInfo {
  return { country: "Unknown", countryCode: "XX", fromCache: false };
}

// Country -> home TLDs that get a ranking boost (user's country first).
const TLD_PREFS: Record<string, string[]> = {
  DE: ["de"], FR: ["fr"], IT: ["it"], ES: ["es"], US: ["us", "com"],
  GB: ["uk", "co.uk"], CA: ["ca"], BR: ["br"], IN: ["in"], JP: ["jp"],
  NL: ["nl"], SE: ["se"], PL: ["pl"], AR: ["ar"], MX: ["mx"],
  ZA: ["za"], NG: ["ng"], EG: ["eg"], TR: ["tr"], RU: ["ru"],
  UA: ["ua"], KR: ["kr"], CN: ["cn"], AU: ["au"], CH: ["ch"], AT: ["at"],
  BE: ["be"], PT: ["pt"], GR: ["gr"], IL: ["il"], SA: ["sa"], AE: ["ae"],
  QA: ["qa"], TN: ["tn"], MA: ["ma"], DZ: ["dz"], KE: ["ke"], GH: ["gh"],
};

export function tldOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split(".");
    if (parts.length < 2) return "";
    const last2 = parts.slice(-2).join(".");
    if (last2.startsWith("co.")) return last2; // co.uk, co.za, ...
    return parts[parts.length - 1];
  } catch {
    return "";
  }
}

/** Score multiplier for a result URL given the visitor's country. */
export function countryBoost(url: string, countryCode: string): number {
  const prefs = TLD_PREFS[countryCode];
  if (!prefs) return 1;
  return prefs.includes(tldOf(url)) ? 1.35 : 1;
}
