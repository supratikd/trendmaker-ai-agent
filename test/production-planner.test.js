import assert from "node:assert/strict";
import { test } from "node:test";

process.env.GEMINI_API_KEY = "test-key";
const { generateVideoProductionPlan } = await import("../src/services/video-production-planner.ts");

const context = {
  topic: "Jensen Huang memes",
  intent: "video_creation",
  platform: "YouTube",
  targetDuration: 180,
  targetAudience: null,
  contentStyle: "meme",
  researchRequired: true,
  actions: ["Plan a video"],
};

const scene = (sceneNumber, durationSeconds) => ({
  sceneNumber,
  sceneTitle: `Scene ${sceneNumber}`,
  durationSeconds,
  purpose: "Introduce the topic",
  visualDirection: "Show an illustration",
  narration: "Introduce the topic",
  onScreenText: ["Introduction"],
  assetRequirements: ["Illustration"],
  audioDirection: "Background music",
  sourceVideoIds: [],
});

const plan = () => ({
  videoTitle: "Video title",
  videoDescription: "Video description",
  targetAudience: "General audience",
  videoDurationSeconds: 180,
  aspectRatio: "16:9",
  visualStyle: "Animated",
  scenes: [scene(1, 60), scene(2, 120)],
  musicDirection: "Upbeat",
  productionNotes: ["Verify factual claims"],
});

function mockGemini(t, text) {
  return t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text }] } }],
    }), { headers: { "content-type": "application/json" } }));
}

test("generates a plan using the analyzed context", async (t) => {
  let request;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(plan()) }] } }],
    }), { headers: { "content-type": "application/json" } });
  });
  assert.deepEqual(await generateVideoProductionPlan(context), plan());
  assert.ok(request.contents[0].parts[0].text.includes(JSON.stringify(context, null, 2)));
  assert.equal(request.generationConfig.responseMimeType, "application/json");
});

test("requires valid plan structure and a consistent timeline", async (t) => {
  let result = plan();
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(result) }] } }],
    }), { headers: { "content-type": "application/json" } }));

  result = { ...plan(), scenes: [] };
  await assert.rejects(generateVideoProductionPlan(context));
  result = { ...plan(), scenes: [scene(1, 180), { ...scene(2, 1), narration: undefined }] };
  await assert.rejects(generateVideoProductionPlan(context));
  result = { ...plan(), scenes: [scene(1, -1), scene(2, 181)] };
  await assert.rejects(generateVideoProductionPlan(context));
  result = { ...plan(), scenes: [scene(2, 60), scene(1, 120)] };
  await assert.rejects(generateVideoProductionPlan(context), /numbered sequentially/);
  result = { ...plan(), videoDurationSeconds: 179 };
  await assert.rejects(generateVideoProductionPlan(context), /Scene duration mismatch/);
  result = { ...plan(), scenes: [scene(1, 100)], videoDurationSeconds: 100 };
  await assert.rejects(generateVideoProductionPlan(context), /Target duration mismatch/);
  assert.deepEqual(await generateVideoProductionPlan({ ...context, targetDuration: null }), result);
  result = { ...result, videoDurationSeconds: 99 };
  await assert.rejects(generateVideoProductionPlan({ ...context, targetDuration: null }), /Scene duration mismatch/);
});

test("rejects invalid target durations before calling Gemini", async (t) => {
  const fetch = mockGemini(t, JSON.stringify(plan()));
  await assert.rejects(generateVideoProductionPlan({ ...context, targetDuration: 0 }), /Target duration/);
  await assert.rejects(generateVideoProductionPlan({ ...context, targetDuration: 2.5 }), /Target duration/);
  assert.equal(fetch.mock.callCount(), 0);
});

test("rejects empty or malformed Gemini output", async (t) => {
  let text = "";
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text }] } }],
    }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(generateVideoProductionPlan(context), /empty production plan/);
  text = "not json";
  await assert.rejects(generateVideoProductionPlan(context), /Production planner returned invalid JSON/);
});

test("requires source-aware scenes to reference supplied candidates", async (t) => {
  const sources = [{
    order: 1, videoId: "source", title: "Source",
    url: "https://www.youtube.com/watch?v=source",
    durationSeconds: 30, reason: "Relevant title",
  }];
  let result = plan();
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(result) }] } }],
    }), { headers: { "content-type": "application/json" } }));
  await assert.rejects(generateVideoProductionPlan(context, sources), /does not reference/);
  result.scenes = result.scenes.map((item) => ({ ...item, sourceVideoIds: [] }));
  await assert.rejects(generateVideoProductionPlan(context, sources), /does not reference/);
  result.scenes[0].sourceVideoIds = ["unknown"];
  await assert.rejects(generateVideoProductionPlan(context, sources), /unknown source video/);
  result.scenes[0].sourceVideoIds = ["source", "source"];
  await assert.rejects(generateVideoProductionPlan(context, sources), /duplicate source video IDs/);
  result.scenes[0].sourceVideoIds = ["source"];
  assert.deepEqual(await generateVideoProductionPlan(context, sources), result);
});

test("validates aspect ratios, vertical Shorts, and required scene fields", async (t) => {
  let result = plan();
  t.mock.method(globalThis, "fetch", async () =>
    new Response(JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(result) }] } }],
    }), { headers: { "content-type": "application/json" } }));
  result.aspectRatio = "0:16";
  await assert.rejects(generateVideoProductionPlan(context), /aspectRatio/);
  result.aspectRatio = "16:9";
  const shorts = { ...context, platform: "YouTube Shorts" };
  await assert.rejects(generateVideoProductionPlan(shorts), /9:16/);
  assert.deepEqual(await generateVideoProductionPlan({
    ...shorts, contentStyle: "horizontal",
  }), result);
  result.aspectRatio = "9:16";
  assert.deepEqual(await generateVideoProductionPlan(shorts), result);
  result.scenes[0].onScreenText = [];
  await assert.rejects(generateVideoProductionPlan(shorts), /onScreenText/);
  result.scenes[0].onScreenText = ["Intro"];
  delete result.scenes[0].sourceVideoIds;
  await assert.rejects(generateVideoProductionPlan(shorts), /sourceVideoIds/);
});
