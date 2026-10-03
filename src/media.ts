// Media classification from page metadata.
//
// A text index can't rank images, but every page advertises what it is:
// OpenGraph/Twitter cards, video providers, and shorts-specific URL shapes. We
// harvest that at crawl time so search can filter and display verticals without
// scraping anyone's video API.
import { CONFIG } from "./config.ts";

export type Vertical = "text" | "image" | "video" | "short";

export interface MediaInfo {
  type: Vertical;
  image?: string; // thumbnail / og:image
  videoUrl?: string; // direct media or watch page
  provider?: string; // youtube, vimeo, tiktok…
  duration?: number; // seconds
  width?: number;
  height?: number;
  shortPath?: string; // e.g. /shorts/abc
}

const SHORT_PATH = /\/(?:shorts|reels|reel|tiktok|clips?)\//i;
const SHORT_HOSTS = ["tiktok.com", "instagram.com", "snapchat.com", "reels.facebook.com"];
const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|bmp)(\?|$)/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m3u8)(\?|$)/i;

/** Content of a <meta> tag by property/name/itemprop.
 *
 *  Quote handling matters: content="Rick Astley's 1987 hit" must not be cut at
 *  the apostrophe, so each quoting style is matched on its own. The property may
 *  appear before or after the content attribute. */
export function metaContent(html: string, prop: string): string {
  const attr = `(?:property|name|itemprop)=["']${prop}["']`;
  const re = new RegExp(
    `<meta[^>]*${attr}[^>]*content="([^"]*)"` +
      `|<meta[^>]*${attr}[^>]*content='([^']*)'` +
      `|<meta[^>]*content="([^"]*)"[^>]*${attr}` +
      `|<meta[^>]*content='([^']*)'[^>]*${attr}`,
    "i",
  );
  const m = re.exec(html);
  return (m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4] ?? "").trim();
}

function meta(html: string, prop: string): string | undefined {
  return metaContent(html, prop) || undefined;
}

/** Best-effort "HH:MM:SS" / "MM:SS" -> seconds. */
export function parseDuration(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  if (/^\d+$/.test(raw)) return Number(raw);
  const parts = raw.split(":").map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n))) return undefined;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export function formatDuration(seconds: number | undefined): string | undefined {
  if (!seconds || seconds <= 0) return undefined;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function classify(html: string, url: string): MediaInfo {
  const info: MediaInfo = { type: "text" };
  const ogType = (meta(html, "og:type") ?? "").toLowerCase();
  const ogImage = meta(html, "og:image") ?? meta(html, "twitter:image");
  const ogVideo = meta(html, "og:video") ?? meta(html, "og:video:url") ?? meta(html, "twitter:player");
  const duration = parseDuration(meta(html, "og:video:duration") ?? meta(html, "video:duration") ?? meta(html, "duration"));
  const width = Number(meta(html, "og:video:width") ?? meta(html, "og:image:width") ?? "") || undefined;
  const height = Number(meta(html, "og:video:height") ?? meta(html, "og:image:height") ?? "") || undefined;

  if (ogImage) info.image = absolute(ogImage, url);
  if (ogVideo) info.videoUrl = absolute(ogVideo, url);
  if (duration) info.duration = duration;
  if (width) info.width = width;
  if (height) info.height = height;

  let host = "";
  let path = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
    path = new URL(url).pathname;
  } catch {
    return info;
  }

  // Short-form: URL shape is the signal (shorts/reels/tiktok paths).
  const shortMatch = SHORT_PATH.exec(path);
  if (shortMatch || SHORT_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
    info.type = "short";
    info.shortPath = shortMatch?.[0];
    info.provider = host.split(".").slice(-2).join(".");
    if (!info.videoUrl) info.videoUrl = url;
    return info;
  }

  // Video: explicit metadata, a known provider, or a media file extension.
  const isVideoProvider = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|wistia\.(com|net)|ted\.com)$/i.test(host);
  if (ogType.includes("video") || ogType.includes("music") || (isVideoProvider && !IMAGE_EXT.test(path)) || VIDEO_EXT.test(path)) {
    info.type = "video";
    info.provider = info.provider ?? host.split(".").slice(-2).join(".");
    info.videoUrl ??= url;
    return info;
  }

  // Image: explicit metadata, an image file, or a bare photo permalink.
  if (ogType.startsWith("image") || ogType === "photo" || IMAGE_EXT.test(path) || /\/(photo|photos|image|images)\//i.test(path)) {
    info.type = "image";
    info.videoUrl ??= url;
    return info;
  }

  return info;
}

function absolute(candidate: string, base: string): string {
  try {
    return new URL(candidate, base).toString();
  } catch {
    return candidate;
  }
}

export const VERTICALS: Vertical[] = ["text", "image", "video", "short"];

/** Bump applied when the query names a vertical, so typed intent ranks right. */
export function verticalBoost(docType: Vertical, wanted: Vertical | null): number {
  if (!wanted || wanted === "text") return 1;
  if (docType === wanted) return CONFIG.verticals.boost;
  // Video pages often carry an image too: don't hide them entirely.
  if (wanted === "image" && docType === "video") return 1 / CONFIG.verticals.penalty;
  if (wanted === "video" && docType === "short") return 1 / CONFIG.verticals.penalty;
  return 1 / CONFIG.verticals.penalty;
}

/** "v0.3" from "0.3.4" — the short version string shown in the corner. */
export function shortVersion(version: string): string {
  const parts = version.split(".").filter((p) => /^\d+$/.test(p));
  if (parts.length === 0) return `v${version}`;
  return `v${parts[0]}.${parts[1] ?? "0"}`;
}