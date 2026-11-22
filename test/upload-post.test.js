import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  getYouTubePostMetadata,
  resolveUploadVideoPath,
} from "../src/services/upload-post.ts";
import { createYouTubeShortMetadataPrompt } from "../src/prompts/research.ts";

test("builds a structured YouTube Shorts metadata prompt", () => {
  const production = {
    plan: {
      videoTitle: "Jensen Huang memes",
      videoDescription: "A viral tech meme compilation.",
    },
  };
  const prompt = createYouTubeShortMetadataPrompt(production);

  assert.match(prompt, /YouTube Shorts metadata writer/);
  assert.match(prompt, /Return only structured JSON/);
  assert.match(prompt, /title, description, and hashtags fields/);
  assert.ok(prompt.includes(JSON.stringify(production, null, 2)));
});

test("extracts a YouTube title and description from a production plan", () => {
  assert.deepEqual(getYouTubePostMetadata({
    plan: { videoTitle: "  Video title  ", videoDescription: "Description" },
  }), {
    title: "Video title",
    description: "Description",
  });
  assert.deepEqual(getYouTubePostMetadata({
    plan: { videoTitle: "Video title" },
  }), {
    title: "Video title",
    description: "",
  });
});

test("rejects invalid upload metadata", () => {
  assert.throws(() => getYouTubePostMetadata({ plan: { videoTitle: "" } }), /Invalid production metadata/);
  assert.throws(
    () => getYouTubePostMetadata({ plan: { videoTitle: "x".repeat(101) } }),
    /Invalid production metadata/,
  );
  assert.throws(
    () => getYouTubePostMetadata({ plan: { videoTitle: "Valid", videoDescription: "x".repeat(5001) } }),
    /Invalid production metadata/,
  );
});

test("only resolves non-empty MP4 files inside the output directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trendmaker-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  fs.mkdirSync(output);
  const video = path.join(output, "video.mp4");
  fs.writeFileSync(video, "video");

  assert.equal(resolveUploadVideoPath(video, root), video);
  assert.throws(() => resolveUploadVideoPath(path.join(root, "outside.mp4"), root), /inside the output directory/);
  assert.throws(() => resolveUploadVideoPath(path.join(output, "missing.mp4"), root), /not found/);
  assert.throws(() => resolveUploadVideoPath(path.join(output, "video.mov"), root), /Only MP4/);

  const emptyVideo = path.join(output, "empty.mp4");
  fs.writeFileSync(emptyVideo, "");
  assert.throws(() => resolveUploadVideoPath(emptyVideo, root), /empty or is not a file/);
});
