import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CONFIG } from "./config.ts";
import { buildContext, extractiveAnswer, parseAction, providerPacing, runAgent, systemPrompt } from "./ai.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";

const realFetch = globalThis.fetch;

beforeEach(() => {
  // never wait on the provider's 15s anonymous pacing inside tests
  providerPacing.minIntervalMs = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  providerPacing.minIntervalMs = CONFIG.ai.minIntervalMsAnonymous;
});

function stubFetch(impl: () => Promise<Response>) {
  globalThis.fetch = impl as unknown as typeof fetch;
}

function tinyIndex() {
  const idx = new InvertedIndex();
  idx.addDocument({
    id: "a",
    url: "https://www.bbc.com/news/story-1",
    title: "BBC world report",
    text: "Global markets moved today while leaders met in Geneva to discuss energy policy.",
    lang: "en",
    outlinks: [],
    fetchedAt: new Date().toISOString(),
    contentHash: "h1",
    wordCount: 14,
  });
  return idx;
}

/** Stub the provider with a scripted sequence of assistant messages. */
function stubProvider(turns: string[]) {
  let i = 0;
  stubFetch(async () => {
    const content = turns[Math.min(i++, turns.length - 1)];
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
      headers: { "content-type": "application/json" },
    });
  });
}

describe("agent", () => {
  test("system prompt brands the agent and documents the tool protocol", () => {
    const p = systemPrompt("Germany");
    expect(p).toContain("MiniSearch AI");
    expect(p).toContain("MINISEARCH_TOOL");
    expect(p).toContain("Germany");
  });

  test("parses a protocol tool call and keeps the rest of the reply", () => {
    const a = parseAction('thinking\nMINISEARCH_TOOL {"name":"search_index","args":{"query":"geneva","limit":3}}');
    expect(a?.name).toBe("search_index");
    expect(a?.args.query).toBe("geneva");
    expect(a?.clean).toContain("thinking");
  });

  test("parses plain answers as no action", () => {
    expect(parseAction("Geneva hosted an energy summit.")).toBeNull();
  });

  test("tool loop searches the index, then answers with citations", async () => {
    stubProvider([
      'MINISEARCH_TOOL {"name":"search_index","args":{"query":"geneva energy","limit":3}}',
      "Leaders met in Geneva to discuss energy ([BBC](https://www.bbc.com/news/story-1)).",
    ]);
    const events: any[] = [];
    const answer = await runAgent({ message: "what happened in geneva?", index: tinyIndex(), onEvent: (e) => events.push(e) });
    expect(answer).toContain("Geneva");
    expect(events.find((e) => e.type === "tool")?.name).toBe("search_index");
    expect(events.at(-1)?.type).toBe("answer");
  });

  test("honours native tool_calls when the provider returns them", async () => {
    stubFetch(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{ id: "t1", type: "function", function: { name: "index_stats", arguments: "{}" } }],
              },
            },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const events: any[] = [];
    // provider repeats the same tool call, so the loop ends on the step limit
    // and falls back to an extractive answer built from the index.
    const answer = await runAgent({ message: "how big is the index?", index: tinyIndex(), onEvent: (e) => events.push(e) });
    expect(events.some((e) => e.type === "tool" && e.name === "index_stats")).toBe(true);
    expect(answer.length).toBeGreaterThan(0);
  });

  test("provider outage degrades to an extractive answer, not an error", async () => {
    // keep the retry backoff instant for the test
    const cfg = CONFIG.ai as { retryBackoffMs: number };
    const original = cfg.retryBackoffMs;
    cfg.retryBackoffMs = 1;
    stubFetch(async () => new Response("boom", { status: 500 }));
    const events: any[] = [];
    const answer = await runAgent({ message: "geneva energy", index: tinyIndex(), onEvent: (e) => events.push(e) });
    cfg.retryBackoffMs = original;
    expect(answer).toContain("bbc.com/news/story-1");
    expect(events.some((e) => e.type === "error" && e.message.includes("model unavailable"))).toBe(true);
    expect(events.some((e) => e.type === "answer")).toBe(true);
  });

  test("extractive answer lists sources when the index has nothing", () => {
    const out = extractiveAnswer(buildContext(new InvertedIndex()), "quantum tunnels");
    expect(out).toContain("nothing matching");
  });

  test("read_page refuses URLs outside the index", async () => {
    const ctx = buildContext(tinyIndex());
    const out = await ctx.readPage("https://evil.test/not-indexed");
    expect(out).toHaveProperty("error");
  });
});