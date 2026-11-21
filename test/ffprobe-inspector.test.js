import assert from "node:assert/strict";
import { test } from "node:test";
import { inspectVideoFile } from "../src/production/ffprobe-inspector.ts";

const validProbe = {
  streams: [
    {
      codec_type: "video",
      codec_name: "h264",
      width: 1920,
      height: 1080,
      avg_frame_rate: "30000/1001",
      pix_fmt: "yuv420p",
      duration: "30.000000",
    },
    {
      codec_type: "audio",
      codec_name: "aac",
      sample_rate: "48000",
      channels: 2,
    },
  ],
  format: { duration: "30.000000" },
};

test("inspects duration, video dimensions, frame rate, and audio properties", () => {
  assert.deepEqual(
    inspectVideoFile("source.mp4", () => JSON.stringify(validProbe)),
    {
      durationSeconds: 30,
      width: 1920,
      height: 1080,
      frameRate: 30000 / 1001,
      videoCodec: "h264",
      pixelFormat: "yuv420p",
      hasAudio: true,
      audioCodec: "aac",
      audioSampleRate: 48000,
      audioChannels: 2,
    },
  );
});

test("supports silent source video and rejects invalid probe output", () => {
  const silentProbe = {
    ...validProbe,
    streams: [validProbe.streams[0]],
  };
  assert.equal(inspectVideoFile("silent.mp4", () => JSON.stringify(silentProbe)).hasAudio, false);
  assert.throws(() => inspectVideoFile("broken.mp4", () => "not json"), /invalid JSON/);
  assert.throws(
    () => inspectVideoFile("audio-only.mp4", () => JSON.stringify({
      streams: [{ codec_type: "audio" }],
      format: { duration: "30" },
    })),
    /No video stream/,
  );
  assert.throws(
    () => inspectVideoFile("unknown-duration.mp4", () => JSON.stringify({
      streams: [{ codec_type: "video", width: 1920, height: 1080 }],
      format: { duration: "N\/A" },
    })),
    /invalid video duration/,
  );
});
