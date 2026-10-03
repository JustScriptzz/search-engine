// IP -> country resolution used to tune result ranking. Fail-open: a lookup
// failure never blocks a search, it just means no boost.
import { CONFIG } from "./config.ts";

export interface GeoInfo {
  country: string;
  countryCode: string; // ISO-2, "XX" when unknown
  fromCache: boolean;
}

const cache = new Map<string, { info: GeoInfo; at: number }>();

export function getClientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0].trim();
    if (first) return first;
  }
  return req.headers.get("x-real-ip")?.trim() || "local";
}

export function isLocalIp(ip: string): boolean {
  return (
    ip === "local" ||
    ip === "::1" ||
    ip.startsWith("127.") ||
    ip.startsWith("10.") ||
    ip.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
  );
}

export async function lookupCountry(ip: string, timeoutMs = CONFIG.geo.timeoutMs): Promise<GeoInfo> {
  if (isLocalIp(ip)) return unknown();
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < CONFIG.geo.cacheTtlMs) return { ...hit.info, fromCache: true };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `${CONFIG.geo.endpoint}/${encodeURIComponent(ip)}?fields=status,country,countryCode`,
      { signal: ctrl.signal },
    );
    if (!res.ok) return unknown();
    const data = (await res.json()) as { status?: string; country?: string; countryCode?: string };
    if (data.status !== "success" || !data.countryCode) return unknown();
    const info: GeoInfo = {
      country: data.country ?? data.countryCode,
      countryCode: data.countryCode,
      fromCache: false,
    };
    cache.set(ip, { info, at: Date.now() });
    if (cache.size > CONFIG.geo.maxCacheEntries) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
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

// Country -> home TLDs that get the ranking boost.
const TLD_PREFS: Record<string, string[]> = {
  US: ["us", "com"], GB: ["uk", "co.uk"], CA: ["ca"], AU: ["au"], NZ: ["nz"],
  DE: ["de"], AT: ["at"], CH: ["ch"], FR: ["fr"], BE: ["be"], NL: ["nl"],
  IT: ["it"], ES: ["es"], PT: ["pt"], IE: ["ie"], SE: ["se"], NO: ["no"],
  DK: ["dk"], FI: ["fi"], PL: ["pl"], CZ: ["cz"], GR: ["gr"], TR: ["tr"],
  BR: ["br"], MX: ["mx"], AR: ["ar"], CL: ["cl"], CO: ["co"],
  IN: ["in"], SG: ["sg"], MY: ["my"], ID: ["id"], PH: ["ph"], VN: ["vn"],
  JP: ["jp"], KR: ["kr"], CN: ["cn"], TW: ["tw"], HK: ["hk"],
  ZA: ["za"], NG: ["ng"], KE: ["ke"], GH: ["gh"], EG: ["eg"], MA: ["ma"],
  TN: ["tn"], DZ: ["dz"], SA: ["sa"], AE: ["ae"], QA: ["qa"], IL: ["il"],
};

// Country -> languages a local reader is most likely to want. A page served in
// that language is boosted even when it lives on a .com domain, which is how
// most publishers operate.
const COUNTRY_LANGS: Record<string, string[]> = {
  IT: ["it", "en"], DE: ["de", "en"], AT: ["de", "en"], CH: ["de", "fr", "it", "en"],
  FR: ["fr", "en"], BE: ["fr", "nl", "en"], NL: ["nl", "en"], ES: ["es", "en"],
  MX: ["es", "en"], AR: ["es", "en"], CL: ["es", "en"], CO: ["es", "en"],
  PT: ["pt", "en"], BR: ["pt", "en"], PL: ["pl", "en"], CZ: ["cs", "en"],
  SE: ["sv", "en"], NO: ["no", "en"], DK: ["da", "en"], FI: ["fi", "en"],
  GR: ["el", "en"], TR: ["tr", "en"], JP: ["ja", "en"], KR: ["ko", "en"],
  CN: ["zh", "en"], IN: ["en", "hi"], US: ["en"], GB: ["en", "cy"],
  CA: ["en", "fr"], AU: ["en"], NZ: ["en"], IE: ["en", "ga"], ZA: ["en"],
  NG: ["en"], KE: ["en", "sw"], IN2: [], EG: ["ar", "en"], SA: ["ar", "en"],
  AE: ["ar", "en"], IL: ["he", "en"], QA: ["ar", "en"],
};

export function languagesForCountry(countryCode: string): string[] {
  return COUNTRY_LANGS[countryCode] ?? [];
}

/** Boost a document written in the visitor's language, whatever its domain.
 *  Primary language gets the full boost, secondary (usually English) half. */
export function languageBoost(docLang: string, countryCode: string): number {
  const wanted = languagesForCountry(countryCode);
  if (wanted.length === 0) return 1;
  const lang = (docLang ?? "").toLowerCase().split("-")[0];
  if (!lang) return 1;
  if (lang === wanted[0]) return CONFIG.geo.langBoost;
  if (wanted.slice(1).includes(lang)) return 1 + (CONFIG.geo.langBoost - 1) / 2;
  return 1;
}

export function tldOf(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    const parts = host.split(".");
    if (parts.length < 2) return "";
    const last2 = parts.slice(-2).join(".");
    if (last2.startsWith("co.")) return last2;
    return parts[parts.length - 1];
  } catch {
    return "";
  }
}

/** Multiplier for a result URL serving this visitor's country. */
export function countryBoost(url: string, countryCode: string): number {
  const prefs = TLD_PREFS[countryCode];
  if (!prefs) return 1;
  return prefs.includes(tldOf(url)) ? CONFIG.geo.boost : 1;
}