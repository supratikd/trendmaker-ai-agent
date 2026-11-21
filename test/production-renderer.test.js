import assert from "node:assert/strict";
import { test } from "node:test";
import { createRenderTimeline } from "../src/production/video-renderer.ts";

const production = {
  selection: {
    clips: [
      { videoId: "first", title: "First", durationSeconds: 30 },
      { videoId: "second", title: "Second", durationSeconds: 30 },
    ],
  },
  plan: {
    videoTitle: "Combined video",
    videoDurationSeconds: 8,
    scenes: [
      {
        sceneNumber: 1,
        sceneTitle: "Opening",
        durationSeconds: 5,
        narration: "Welcome",
        onScreenText: ["Start"],
        sourceVideoIds: ["first", "second"],
      },
      {
        sceneNumber: 2,
        sceneTitle: "Ending",
        durationSeconds: 3,
        narration: "Goodbye",
        onScreenText: ["Finish"],
        sourceVideoIds: ["first"],
      },
    ],
  },
};

test("builds a timed sequence without adding on-screen text", () => {
  assert.deepEqual(createRenderTimeline(production), [
    { sceneNumber: 1, durationSeconds: 3, sourceVideoId: "first" },
    { sceneNumber: 1, durationSeconds: 2, sourceVideoId: "second" },
    { sceneNumber: 2, durationSeconds: 3, sourceVideoId: "first" },
  ]);
});

test("rejects unselected sources and durations inconsistent with the plan", () => {
  const unknownSource = structuredClone(production);
  unknownSource.plan.scenes[0].sourceVideoIds[0] = "unknown";
  assert.throws(() => createRenderTimeline(unknownSource), /references unselected video/);

  const invalidDuration = structuredClone(production);
  invalidDuration.plan.videoDurationSeconds = 9;
  assert.throws(() => createRenderTimeline(invalidDuration), /timeline is 8 seconds/);

  const sourceTooShort = structuredClone(production);
  sourceTooShort.selection.clips[0].durationSeconds = 2;
  sourceTooShort.selection.clips[1].durationSeconds = 2;
  assert.throws(() => createRenderTimeline(sourceTooShort), /provide only 4s in total/);
});

test("redistributes scene time when a source clip is shorter than an even split", () => {
  const shortSourceProduction = {
    selection: {
      clips: [
        { videoId: "long", title: "Long", durationSeconds: 23 },
        { videoId: "short", title: "Short", durationSeconds: 7 },
      ],
    },
    plan: {
      videoTitle: "Redistributed",
      videoDurationSeconds: 20,
      scenes: [{
        sceneNumber: 1,
        sceneTitle: "Scene",
        durationSeconds: 20,
        narration: "Not rendered",
        onScreenText: ["Text"],
        sourceVideoIds: ["long", "short"],
      }],
    },
  };
  assert.deepEqual(createRenderTimeline(shortSourceProduction), [
    { sceneNumber: 1, durationSeconds: 13, sourceVideoId: "long" },
    { sceneNumber: 1, durationSeconds: 7, sourceVideoId: "short" },
  ]);
});
