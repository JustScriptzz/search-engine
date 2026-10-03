import { describe, expect, test } from "bun:test";
import { parseHtml } from "./crawler/parser.ts";
import { rejectDoc } from "./quality.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";

// A YouTube watch page is a link farm: the body text is nav, all the useful
// content is in og:title / og:description. Searching the video's title must
// still find it, which is what media cards are for.
const watchPage = `<html><head>
  <title>Rick Astley - Never Gonna Give You Up (Official Video) - YouTube</title>
  <meta property="og:type" content="video.other">
  <meta property="og:video" content="https://www.youtube.com/embed/dQw4w9WgXcQ">
  <meta property="og:image" content="https://i.ytimg.com/vi/dQw4w9WgXcQ/maxresdefault.jpg">
  <meta property="og:description" content="The official video for Rick Astley's 1987 hit Never Gonna Give You Up.">
</head><body>
  ${'<a href="/watch">About Press Copyright Contact us Creators Advertise Developers Terms Privacy</a> '.repeat(20)}
</body></html>`;

describe("media cards", () => {
  test("parser exposes description and media type", () => {
    const p = parseHtml(watchPage, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(p.media.type).toBe("video");
    expect(p.description).toContain("Never Gonna Give You Up");
    expect(p.title).toContain("Never Gonna Give You Up");
  });

  test("a link-farm video page survives the quality gate as a media card", () => {
    const p = parseHtml(watchPage, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    const card = {
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      text: `${p.title}. ${p.description}`,
      wordCount: 20,
      linkDensity: 0.95,
      mediaCard: true,
    };
    expect(rejectDoc(card)).toEqual({});
    // without the mediaCard flag the same page is (correctly) rejected
    expect(rejectDoc({ ...card, mediaCard: false }).lowQuality).toBe(true);
  });

  test("the video title is searchable", () => {
    const idx = new InvertedIndex();
    const p = parseHtml(watchPage, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    idx.addDocument({
      id: "vid",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: p.title,
      // title is repeated the way the crawler's media card does it
      text: `${p.title}. ${p.title}. ${p.description}. video youtube.com`,
      lang: "en",
      linkDensity: 0.95,
      mediaCard: true,
      media: p.media,
      outlinks: [],
      fetchedAt: new Date().toISOString(),
      contentHash: "v1",
      wordCount: 40,
    });
    const hits = idx.search("never gonna give you up", 5);
    expect(hits[0].id).toBe("vid");
  });
});
