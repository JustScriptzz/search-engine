import { describe, expect, test } from "bun:test";
import { classify, formatDuration, parseDuration, shortVersion, verticalBoost } from "./media.ts";
import { CONFIG } from "./config.ts";

const page = (head: string, url = "https://x.test/a") => `<html><head>${head}</head><body><p>Some prose.</p></body></html>`;

describe("media classification", () => {
  test("detects video from og metadata", () => {
    const info = classify(
      page(`<meta property="og:type" content="video.other"><meta property="og:video" content="https://x.test/v.mp4"><meta property="og:video:duration" content="125">`),
      "https://x.test/watch",
    );
    expect(info.type).toBe("video");
    expect(info.videoUrl).toContain("v.mp4");
    expect(info.duration).toBe(125);
  });

  test("detects shorts from the URL shape", () => {
    expect(classify(page(""), "https://www.youtube.com/shorts/abc123").type).toBe("short");
    expect(classify(page(""), "https://www.tiktok.com/@user/video/1").type).toBe("short");
  });

  test("detects images", () => {
    expect(classify(page(`<meta property="og:type" content="image">`), "https://x.test/p").type).toBe("image");
    expect(classify(page(""), "https://x.test/photo/cat.jpg").type).toBe("image");
  });

  test("plain articles stay text", () => {
    expect(classify(page(`<meta property="og:type" content="article">`), "https://x.test/post").type).toBe("text");
  });

  test("thumbnail urls are made absolute", () => {
    const info = classify(page(`<meta property="og:image" content="/static/thumb.jpg">`), "https://x.test/post");
    expect(info.image).toBe("https://x.test/static/thumb.jpg");
  });

  test("duration parsing and formatting", () => {
    expect(parseDuration("12:34")).toBe(754);
    expect(parseDuration("1:02:03")).toBe(3723);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration(undefined)).toBeUndefined();
    expect(formatDuration(754)).toBe("12:34");
    expect(formatDuration(3723)).toBe("1:02:03");
    expect(formatDuration(undefined)).toBeUndefined();
  });

  test("vertical boost promotes matches and demotes the rest", () => {
    expect(verticalBoost("video", "video")).toBe(CONFIG.verticals.boost);
    expect(verticalBoost("text", "video")).toBeLessThan(1);
    expect(verticalBoost("text", null)).toBe(1);
    // a video page carrying an image still belongs in video results
    expect(verticalBoost("video", "image")).toBeGreaterThan(0);
  });

  test("short version reads 0.3.4 as v0.3", () => {
    expect(shortVersion("0.3.4")).toBe("v0.3");
    expect(shortVersion("1.2.0")).toBe("v1.2");
    expect(shortVersion("2.0.0")).toBe("v2.0");
  });
});