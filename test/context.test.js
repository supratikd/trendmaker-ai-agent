import assert from "node:assert/strict";
import { test } from "node:test";
import { exampleRequest } from "../src/execute/example-request.ts";

process.env.GEMINI_API_KEY = "test-key";

const { analyzeUserRequest } = await import("../src/services/context-analyzer.ts");
const { discoverYouTubeVideos } = await import("../src/mcp/youtube-agent.ts");

const request = exampleRequest;
const context = {
  topic: "Jensen Huang",
  intent: "video_discovery",
  platform: "YouTube Shorts",
  targetDuration: null,
  targetAudience: null,
  contentStyle: "meme",
  researchRequired: true,
  actions: ["Search for videos", "Rank by views"],
};

function geminiResponse(text) {
  return new Response(JSON.stringify({
    candidates: [{ content: { role: "model", parts: [{ text }] } }],
  }), { headers: { "content-type": "application/json" } });
}

test("analyzes the request and validates the structured context", async (t) => {
  let body;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    body = JSON.parse(options.body);
    return geminiResponse(JSON.stringify(context));
  });

  assert.deepEqual(await analyzeUserRequest(request), context);
  assert.match(body.contents[0].parts[0].text, /context analyzer/);
  assert.ok(body.contents[0].parts[0].text.includes(request));
  assert.equal(body.generationConfig.responseMimeType, "application/json");
});

test("rejects malformed or incomplete analyzer output", async (t) => {
  let text = "not json";
  t.mock.method(globalThis, "fetch", async () => geminiResponse(text));
  await assert.rejects(analyzeUserRequest(request), /Context analyzer returned invalid JSON/);
  text = JSON.stringify({ ...context, intent: "invalid" });
  await assert.rejects(analyzeUserRequest(request), /Context analyzer returned invalid data: intent/);
  text = JSON.stringify({ ...context, topic: " ", targetDuration: 0, actions: [] });
  await assert.rejects(analyzeUserRequest(request), /topic/);
  await assert.rejects(analyzeUserRequest(" "), /must not be blank/);
});

test("enforces Shorts platform and maximum duration", async (t) => {
  let result = { ...context, platform: "YouTube" };
  t.mock.method(globalThis, "fetch", async () => geminiResponse(JSON.stringify(result)));
  assert.equal((await analyzeUserRequest("Make a video")).platform, "YouTube Shorts");
  result = { ...result, targetDuration: 181 };
  await assert.rejects(analyzeUserRequest("Make a long video"), /180 seconds/);
});

test("discovery passes the analyzed context and original request to Gemini", async (t) => {
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return geminiResponse(bodies.length === 1 ? JSON.stringify(context) : "Discovery result");
  });

  assert.equal(await discoverYouTubeVideos(request), "Discovery result");
  assert.equal(bodies.length, 2);
  const prompt = bodies[1].contents[0].parts[0].text;
  assert.ok(prompt.includes(request));
  assert.ok(prompt.includes(JSON.stringify(context, null, 2)));
  assert.ok(bodies[1].tools.length > 0);
});

test("discovery stops when context analysis fails", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    return geminiResponse("{}");
  });

  await assert.rejects(discoverYouTubeVideos(request));
  assert.equal(calls, 1);
});
