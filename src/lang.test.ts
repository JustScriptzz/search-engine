import { describe, expect, test } from "bun:test";
import { isAllowedLanguage, scriptProfile } from "./lang.ts";

describe("lang", () => {
  test("keeps English/Latin pages", () => {
    expect(isAllowedLanguage("Search engines crawl the web and build an inverted index")).toBe(true);
  });

  test("blocks Arabic, Cyrillic and CJK pages", () => {
    expect(isAllowedLanguage("محرك بحث ويكيبيديا")).toBe(false);
    expect(isAllowedLanguage("Поисковая система Википедия")).toBe(false);
    expect(isAllowedLanguage("搜索引擎 维基百科 中文页面")).toBe(false);
  });

  test("blocks mixed page when non-Latin dominates", () => {
    const mixed = "some english words here ".repeat(3) + "محرك بحث ويكيبيديا هنا".repeat(20);
    expect(isAllowedLanguage(mixed)).toBe(false);
  });

  test("dominant script reported", () => {
    expect(scriptProfile("hello world").dominant).toBe("latin");
    expect(scriptProfile("مرحبا بالعالم").dominant).toBe("arabic");
  });

  test("pages with no letters are not dropped", () => {
    expect(isAllowedLanguage("1234 --- !!!")).toBe(true);
  });
});