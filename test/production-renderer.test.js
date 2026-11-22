import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  clearProductionOutputDirectory,
  createRenderTimeline,
  getSourceDurationPadding,
} from "../src/production/video-renderer.ts";

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
        sourceVideoIds: ["first"],
      },
      {
        sceneNumber: 2,
        sceneTitle: "Ending",
        durationSeconds: 3,
        narration: "Goodbye",
        onScreenText: ["Finish"],
        sourceVideoIds: ["second"],
      },
    ],
  },
};

test("builds a timed sequence without adding on-screen text", () => {
  assert.deepEqual(createRenderTimeline(production), [
    { sceneNumber: 1, durationSeconds: 5, sourceVideoId: "first" },
    { sceneNumber: 2, durationSeconds: 3, sourceVideoId: "second" },
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
  assert.throws(() => createRenderTimeline(sourceTooShort), /provide only 2s in total/);
});

test("rejects repeated source videos across scenes", () => {
  const repeated = structuredClone(production);
  repeated.plan.videoDurationSeconds = 8;
  repeated.plan.scenes = [
    {
      ...repeated.plan.scenes[0],
      durationSeconds: 4,
      sourceVideoIds: ["first"],
    },
    {
      ...repeated.plan.scenes[1],
      durationSeconds: 4,
      sourceVideoIds: ["first"],
    },
  ];
  assert.throws(
    () => createRenderTimeline(repeated),
    /Source video first is reused/,
  );
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

test("pads small source duration rounding differences but rejects genuinely short clips", () => {
  assert.ok(Math.abs(getSourceDurationPadding(4, "short-source", 7, 6.53) - 0.47) < 0.001);
  assert.equal(getSourceDurationPadding(2, "long-source", 7, 8), 0);
  assert.throws(
    () => getSourceDurationPadding(4, "short-source", 7, 5.9),
    /shortfall exceeds 1s/,
  );
});

test("clears prior output files before a new render without removing the output directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trendmaker-render-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDirectory = path.join(root, "output");
  fs.mkdirSync(outputDirectory);
  fs.writeFileSync(path.join(outputDirectory, "previous.mp4"), "previous render");
  fs.mkdirSync(path.join(outputDirectory, "stale-temp"));
  fs.writeFileSync(path.join(outputDirectory, "stale-temp", "segment.mp4"), "temporary");

  assert.equal(clearProductionOutputDirectory(root), outputDirectory);
  assert.deepEqual(fs.readdirSync(outputDirectory), []);
  assert.equal(fs.statSync(outputDirectory).isDirectory(), true);
});
