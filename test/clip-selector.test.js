import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { exampleRequest } from "../src/execute/example-request.ts";

process.env.GEMINI_API_KEY = "test-key";
const { analyzeUserRequest } = await import("../src/services/context-analyzer.ts");
const { searchYouTubeCandidates } = await import("../src/mcp/youtube-client.ts");
const { selectHighlights } = await import("../src/services/clip-selector.ts");
const { createVideoWorkflow } = await import("../src/services/video-workflow.ts");

const request = exampleRequest;
const context = {
  topic: "Jensen Huang",
  intent: "video_discovery",
  platform: "YouTube Shorts",
  targetDuration: null,
  targetAudience: null,
  contentStyle: "meme",
  researchRequired: true,
  actions: ["Search for videos"],
};
const video = (videoId) => ({
  videoId,
  title: `Title ${videoId}`,
  channel: "channel",
  publishedAt: "2025-01-01",
  durationSeconds: 30,
  views: 100,
  likes: 10,
  comments: 1,
  url: `https://www.youtube.com/watch?v=${videoId}`,
  thumbnail: null,
});
const videos = [video("first"), video("second")];
const response = (text) => new Response(JSON.stringify({
  candidates: [{ content: { role: "model", parts: [{ text }] } }],
}), { headers: { "content-type": "application/json" } });

function mockClient(t, result) {
  t.mock.method(Client.prototype, "connect", async () => {});
  const close = t.mock.method(Client.prototype, "close", async () => {});
  const call = t.mock.method(Client.prototype, "callTool", async () => result);
  return { close, call };
}

test("passes analyzed context and every MCP result to the selector", async (t) => {
  const { call, close } = mockClient(t, {
    content: [{ type: "text", text: JSON.stringify({ query: "test", results: videos }) }],
  });
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return response(JSON.stringify(bodies.length === 1 ? context : {
      title: "Candidates",
      clips: [{ order: 1, videoId: "second", reason: "Relevant title", url: "https://invented.test", startSeconds: 5 }],
    }));
  });

  const analyzed = await analyzeUserRequest(request);
  const candidates = await searchYouTubeCandidates(analyzed);
  const selected = await selectHighlights(analyzed, candidates);
  assert.deepEqual(call.mock.calls[0].arguments[0], {
    name: "search_youtube_videos",
    arguments: { query: "Jensen Huang meme", duration: "short" },
  });
  assert.equal(close.mock.callCount(), 1);
  assert.deepEqual(candidates, videos);
  const prompt = bodies[1].contents[0].parts[0].text;
  assert.ok(prompt.includes(JSON.stringify(context, null, 2)));
  for (const candidate of videos) assert.ok(prompt.includes(candidate.url));
  assert.deepEqual(selected, {
    title: "Candidates",
    clips: [{
      order: 1, videoId: "second", title: "Title second",
      url: videos[1].url, durationSeconds: 30, reason: "Relevant title",
    }],
  });
});

test("retries a topic-only search when the style-specific query has no results", async (t) => {
  t.mock.method(Client.prototype, "connect", async () => {});
  const close = t.mock.method(Client.prototype, "close", async () => {});
  const call = t.mock.method(Client.prototype, "callTool", async ({ arguments: args }) => ({
    content: [{ type: "text", text: JSON.stringify({
      query: args.query,
      results: args.query === "Jensen Huang" ? videos : [],
    }) }],
  }));
  assert.deepEqual(await searchYouTubeCandidates({ ...context, platform: "YouTube" }), videos);
  assert.deepEqual(call.mock.calls.map((item) => item.arguments[0].arguments), [
    { query: "Jensen Huang meme", duration: "any" },
    { query: "Jensen Huang", duration: "any" },
  ]);
  assert.equal(close.mock.callCount(), 1);
});

test("keeps Shorts searches short and does not retry an identical query", async (t) => {
  const { call } = mockClient(t, {
    content: [{ type: "text", text: JSON.stringify({ query: "test", results: [] }) }],
  });
  assert.deepEqual(await searchYouTubeCandidates({
    ...context, platform: "YouTube Shorts", contentStyle: null,
  }), []);
  assert.equal(call.mock.callCount(), 1);
  assert.deepEqual(call.mock.calls[0].arguments[0].arguments, {
    query: "Jensen Huang", duration: "short",
  });
});

test("propagates MCP failures without retrying and closes the client", async (t) => {
  const { close, call } = mockClient(t, {
    isError: true,
    content: [{ type: "text", text: "YouTube unavailable" }],
  });
  await assert.rejects(searchYouTubeCandidates(context), /YouTube unavailable/);
  assert.equal(call.mock.callCount(), 1);
  assert.equal(close.mock.callCount(), 1);
});

test("rejects malformed MCP results", async (t) => {
  const { close } = mockClient(t, {
    content: [{ type: "text", text: JSON.stringify({ results: [{ videoId: "x" }] }) }],
  });
  await assert.rejects(searchYouTubeCandidates(context));
  assert.equal(close.mock.callCount(), 1);
});

test("reports invalid JSON from the MCP search", async (t) => {
  const { close } = mockClient(t, {
    content: [{ type: "text", text: "invalid json" }],
  });
  await assert.rejects(searchYouTubeCandidates(context), /YouTube MCP search returned invalid JSON/);
  assert.equal(close.mock.callCount(), 1);
});

test("rejects mismatched candidate URLs and malformed JSON", async (t) => {
  const bad = { ...videos[0], url: videos[1].url };
  await assert.rejects(selectHighlights(context, [bad]), /URL must match the video ID/);
  t.mock.method(globalThis, "fetch", async () => response("```json\n{}\n```"));
  await assert.rejects(selectHighlights(context, videos), /Clip selector returned invalid JSON/);
});

test("rejects invalid model selections and missing candidates", async (t) => {
  let selection = { title: "Candidates", clips: [{ order: 1, videoId: "unknown", reason: "Title" }] };
  const fetch = t.mock.method(globalThis, "fetch", async () => response(JSON.stringify(selection)));

  await assert.rejects(selectHighlights(context, []));
  assert.equal(fetch.mock.callCount(), 0);
  await assert.rejects(selectHighlights(context, videos), /Unknown source video/);
  selection = { title: "Candidates", clips: [
    { order: 1, videoId: "first", reason: "Title" },
    { order: 2, videoId: "first", reason: "Title" },
  ] };
  await assert.rejects(selectHighlights(context, videos), /more than once/);
  selection.clips = [{ order: 2, videoId: "first", reason: "Title" }];
  await assert.rejects(selectHighlights(context, videos), /numbered sequentially/);
  selection.clips = [{ order: 1, videoId: "first" }];
  await assert.rejects(selectHighlights(context, videos));
});

test("connects request analysis, MCP search, selection, and source-aware planning", async (t) => {
  const { call } = mockClient(t, {
    content: [{ type: "text", text: JSON.stringify({ query: "test", results: videos }) }],
  });
  const plan = {
    videoTitle: "Highlights",
    videoDescription: "A video plan",
    targetAudience: "General audience",
    videoDurationSeconds: 45,
    aspectRatio: "9:16",
    visualStyle: "Meme",
    scenes: [{
      sceneNumber: 1, sceneTitle: "Introduction", durationSeconds: 45,
      purpose: "Introduce the topic", visualDirection: "Review source before use",
      narration: "Introduction", onScreenText: ["Introduction"], assetRequirements: ["Illustration"],
      audioDirection: "Music", sourceVideoIds: ["second"],
    }],
    musicDirection: "Upbeat",
    productionNotes: ["Verify rights and footage"],
  };
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    const outputs = [
      context,
      { title: "Candidates", clips: [{ order: 1, videoId: "second", reason: "Relevant title" }] },
      plan,
    ];
    assert.ok(bodies.length <= outputs.length);
    return response(JSON.stringify(outputs[bodies.length - 1]));
  });

  const result = await createVideoWorkflow(request);
  assert.deepEqual(Object.keys(result), ["context", "candidates", "selection", "plan"]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(call.mock.callCount(), 1);
  assert.equal(bodies.length, 3);
  assert.deepEqual(result.context, context);
  assert.deepEqual(result.candidates, videos);
  assert.equal(result.selection.clips[0].url, videos[1].url);
  assert.deepEqual(result.plan, plan);
  const planningPrompt = bodies[2].contents[0].parts[0].text;
  assert.ok(planningPrompt.includes(JSON.stringify(context, null, 2)));
  assert.ok(planningPrompt.includes(videos[1].url));
  assert.ok(!planningPrompt.includes(videos[0].url));
});

test("workflow stops when YouTube returns no candidates", async (t) => {
  mockClient(t, {
    content: [{ type: "text", text: JSON.stringify({ query: "test", results: [] }) }],
  });
  const fetch = t.mock.method(globalThis, "fetch", async () => response(JSON.stringify(context)));
  await assert.rejects(createVideoWorkflow(request), /no video candidates/);
  assert.equal(fetch.mock.callCount(), 1);
});
