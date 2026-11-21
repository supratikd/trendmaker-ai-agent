import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { searchYouTubeVideos } from "../src/mcp/youtube-api.ts";

const signal = () => new AbortController().signal;
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });
const video = (id, duration, views) => ({
  id,
  snippet: { title: id, channelTitle: "channel", publishedAt: "2025-01-01" },
  contentDetails: { duration },
  statistics: { viewCount: String(views) },
});

test("searches, filters at three minutes, ranks, and limits results", async () => {
  const items = Array.from({ length: 12 }, (_, i) => video(`v${i}`, "PT3M", i));
  items.push(video("too-long", "PT3M0.1S", 999), video("day", "P1DT1S", 999));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return calls.length === 1
      ? json({ items: items.map((item) => ({ id: { videoId: item.id } })) })
      : json({ items });
  };
  const result = await searchYouTubeVideos("test", 50, "secret", signal(), fetchImpl);
  assert.equal(result.totalCandidates, 12);
  assert.equal(result.results.length, 10);
  assert.deepEqual(result.results.map((item) => item.views), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  assert.equal(result.results[0].durationSeconds, 180);
  assert.equal(result.results[0].likes, null);
  assert.equal(result.results[0].comments, null);
  assert.equal(result.results[0].thumbnail, null);
  assert.equal(result.results[0].url, "https://www.youtube.com/watch?v=v11");
  assert.deepEqual(Object.keys(result.results[0]), [
    "videoId", "title", "channel", "publishedAt", "durationSeconds",
    "views", "likes", "comments", "url", "thumbnail",
  ]);
  assert.equal(calls[0].url.searchParams.get("q"), "test");
  assert.equal(calls[0].url.searchParams.get("maxResults"), "50");
  assert.equal(calls[0].url.searchParams.get("videoDuration"), "short");
  assert.equal(calls[1].url.searchParams.get("id").split(",").length, 14);
  assert.equal(calls[0].url.searchParams.has("key"), false);
  assert.equal(calls[0].options.headers["x-goog-api-key"], "secret");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
});

test("keeps unavailable statistics distinct from zero and sorts known views first", async () => {
  const missing = video("missing", "PT1M", 0);
  delete missing.statistics;
  const zero = video("zero", "PT1M", 0);
  zero.statistics.likeCount = "0";
  const input = [missing, zero];
  let calls = 0;
  const result = await searchYouTubeVideos("test", 5, "key", signal(), async () =>
    ++calls === 1
      ? json({ items: input.map((item) => ({ id: { videoId: item.id } })) })
      : json({ items: input }));
  assert.deepEqual(result.results.map((item) => item.views), [0, null]);
  assert.equal(result.results[0].likes, 0);
  assert.equal(result.results[1].likes, null);
  assert.equal(result.results[1].thumbnail, null);
});

test("can search all source durations without filtering longer videos", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(new URL(url));
    return calls.length === 1
      ? json({ items: [{ id: { videoId: "long" } }, { id: { videoId: "short" } }] })
      : json({ items: [video("long", "PT10M", 200), video("short", "PT1M", 100)] });
  };
  const result = await searchYouTubeVideos("Jensen Huang", 50, "key", signal(), fetchImpl, "any");
  assert.equal(calls[0].searchParams.has("videoDuration"), false);
  assert.deepEqual(result.results.map((item) => item.videoId), ["long", "short"]);
  assert.equal(result.results[0].durationSeconds, 600);
});

test("returns no results without requesting details", async () => {
  let calls = 0;
  const result = await searchYouTubeVideos("test", 5, "key", signal(), async () => {
    calls++;
    return json({ items: [] });
  });
  assert.deepEqual(result, { query: "test", results: [] });
  assert.equal(calls, 1);
});

test("reports invalid data, HTTP errors, network errors, and cancellation safely", async () => {
  await assert.rejects(searchYouTubeVideos("x", 1, undefined, signal()), /YOUTUBE_API_KEY/);
  await assert.rejects(
    searchYouTubeVideos("x", 1, "key", signal(), async () => json({ error: "secret" }, 403)),
    (error) => error.message === "YouTube search request failed with HTTP 403.",
  );
  await assert.rejects(
    searchYouTubeVideos("x", 1, "key", signal(), async () => json({})),
    /invalid response/,
  );
  await assert.rejects(
    searchYouTubeVideos("x", 1, "key", signal(), async () => { throw new Error("secret"); }),
    (error) => /network connectivity/.test(error.message) && !error.message.includes("secret"),
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    searchYouTubeVideos("x", 1, "key", controller.signal, async () => { throw new Error("aborted"); }),
    /cancelled/,
  );
  let calls = 0;
  await assert.rejects(
    searchYouTubeVideos("x", 1, "key", signal(), async () =>
      ++calls === 1 ? json({ items: [{ id: { videoId: "v" } }] }) : json({ items: [video("v", "garbagePT1S", 1)] })),
    /invalid video duration/,
  );
});

test("stdio MCP server validates inputs and reports missing credentials", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/youtube-server.ts"],
    env: { ...process.env, YOUTUBE_API_KEY: "" },
    stderr: "pipe",
  });
  const client = new Client({ name: "test-client", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "search_youtube_videos"));
    const invalid = await client.callTool({ name: "search_youtube_videos", arguments: { query: "   " } });
    assert.equal(invalid.isError, true);
    const invalidDuration = await client.callTool({
      name: "search_youtube_videos", arguments: { query: "test", duration: "long" },
    });
    assert.equal(invalidDuration.isError, true);
    const missing = await client.callTool({
      name: "search_youtube_videos", arguments: { query: "test", duration: "any" },
    });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /YOUTUBE_API_KEY/);
  } finally {
    await client.close();
  }
});
