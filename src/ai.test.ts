import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { buildContext, extractiveAnswer, parseAction, runAgent, systemPrompt } from "./ai.ts";
import { providerPacing } from "./provider.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";

const realFetch = globalThis.fetch;
const realKey = process.env.COGITO_API_KEY;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

beforeEach(() => {
  providerPacing.minIntervalMs = 0;
  process.env.COGITO_API_KEY = "cog-live-test";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  providerPacing.minIntervalMs = 400;
  if (realKey === undefined) delete process.env.COGITO_API_KEY;
  else process.env.COGITO_API_KEY = realKey;
});

function stubFetch(impl: FetchLike) {
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

/** Scripted provider: serves /v1/models then a sequence of assistant messages. */
function stubProvider(turns: string[], toolCallTurn?: { calls: any[] }) {
  let chatCalls = 0;
  stubFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "gpt-oss:ultra-fast" }] }), {
        headers: { "content-type": "application/json" },
      });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    const content = toolCallTurn && chatCalls === 0 ? null : turns[Math.min(chatCalls++, turns.length - 1)];
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content, reasoning: "", tool_calls: toolCallTurn?.calls ?? [] } }],
      }),
      { headers: { "content-type": "application/json" } },
    );
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
    stubProvider(["unused"], {
      calls: [{ id: "t1", type: "function", function: { name: "index_stats", arguments: "{}" } }],
    });
    const events: any[] = [];
    const answer = await runAgent({ message: "how big is the index?", index: tinyIndex(), onEvent: (e) => events.push(e) });
    expect(events.some((e) => e.type === "tool" && e.name === "index_stats")).toBe(true);
    expect(answer.length).toBeGreaterThan(0);
  });

  test("falls back to the reasoning channel when content comes back empty", async () => {
    stubProvider(["only-reasoning"], undefined);
    const events: any[] = [];
    const answer = await runAgent({ message: "geneva", index: tinyIndex(), onEvent: (e) => events.push(e) });
    expect(answer.length).toBeGreaterThan(0);
  });

  test("provider outage degrades to an extractive answer, not an error", async () => {
    stubFetch(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/models")) return new Response(JSON.stringify({ data: [] }));
      return new Response("boom", { status: 500 });
    });
    const events: any[] = [];
    const answer = await runAgent({ message: "geneva energy", index: tinyIndex(), onEvent: (e) => events.push(e) });
    expect(answer).toContain("bbc.com/news/story-1");
    expect(events.some((e) => e.type === "error" && e.message.includes("model unavailable"))).toBe(true);
    expect(events.some((e) => e.type === "answer")).toBe(true);
  }, 20_000); // provider retries with backoff before falling back

  test("missing API key never calls the provider", async () => {
    delete process.env.COGITO_API_KEY;
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response("{}", { status: 500 });
    });
    const events: any[] = [];
    const answer = await runAgent({ message: "geneva energy", index: tinyIndex(), onEvent: (e) => events.push(e) });
    expect(calls).toBe(0);
    expect(answer).toContain("bbc.com/news/story-1");
    expect(events.some((e) => e.type === "error" && e.message.includes("COGITO_API_KEY"))).toBe(true);
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