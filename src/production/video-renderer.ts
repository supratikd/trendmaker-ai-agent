
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { checkSourceFiles } from "../services/source-manager.js";
import { allocateSceneSourceDurations } from "../services/scene-source-allocation.js";
import { inspectVideoFile } from "./ffprobe-inspector.js";
import type { VideoFileProperties } from "./ffprobe-inspector.js";

export function createTestVideo(): Promise<void> {
  return new Promise((resolve, reject) => {
    const outputDir = path.resolve("output");
    fs.mkdirSync(outputDir, { recursive: true });

    const outputFile = path.join(outputDir, "trendmaker-test.mp4");

    const args = [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=black:s=1080x1920:r=30:d=5",
      "-vf",
      "drawtext=text='TRENDMAKER AI':fontcolor=white:fontsize=76:x=(w-text_w)/2:y=(h-text_h)/2",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputFile
    ];

    const process = spawn("ffmpeg", args, { stdio: "inherit" });

    process.on("error", reject);

    process.on("close", (code) => {
      if (code === 0) {
        console.log("Video created:", outputFile);
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
  });
}

const productionRenderSchema = z.object({
  selection: z.object({
    clips: z.array(z.object({
      videoId: z.string().regex(/^[A-Za-z0-9_-]+$/),
      title: z.string().trim().min(1),
      durationSeconds: z.number().int().positive().max(180),
    })).min(1),
  }),
  plan: z.object({
    videoTitle: z.string().trim().min(1),
    videoDurationSeconds: z.number().int().positive(),
    scenes: z.array(z.object({
      sceneNumber: z.number().int().positive(),
      sceneTitle: z.string().trim().min(1),
      durationSeconds: z.number().int().positive(),
      narration: z.string(),
      onScreenText: z.array(z.string()),
      sourceVideoIds: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/)),
    })).min(1),
  }),
});

export interface RenderSegment {
  sceneNumber: number;
  durationSeconds: number;
  sourceVideoId: string | null;
}

export function createRenderTimeline(production: unknown): RenderSegment[] {
  const parsed = productionRenderSchema.safeParse(production);
  if (!parsed.success) {
    throw new Error(`Invalid production plan for rendering: ${parsed.error.message}`);
  }
  const { selection, plan } = parsed.data;
  const selectedIds = new Set(selection.clips.map((clip) => clip.videoId));
  if (selectedIds.size !== selection.clips.length) {
    throw new Error("Cannot render a selection with duplicate video IDs.");
  }

  const timeline: RenderSegment[] = [];
  const usedIds = new Set<string>();
  for (const [index, scene] of plan.scenes.entries()) {
    if (scene.sceneNumber !== index + 1) {
      throw new Error("Production plan scenes must be numbered sequentially starting at 1.");
    }
    const unknownId = scene.sourceVideoIds.find((id) => !selectedIds.has(id));
    if (unknownId) {
      throw new Error(`Scene ${scene.sceneNumber} references unselected video ${unknownId}.`);
    }
    const sceneSources = scene.sourceVideoIds.map((videoId) => {
      const source = selection.clips.find((clip) => clip.videoId === videoId);
      if (!source) {
        throw new Error(`Scene ${scene.sceneNumber} references unselected video ${videoId}.`);
      }
      return source;
    });
    const allocations = allocateSceneSourceDurations(
      scene.sceneNumber, scene.durationSeconds, sceneSources,
    );
    allocations.forEach(({ videoId: sourceVideoId, durationSeconds }) => {
      if (sourceVideoId) usedIds.add(sourceVideoId);
      timeline.push({
        sceneNumber: scene.sceneNumber,
        durationSeconds,
        sourceVideoId,
      });
    });
  }

  const unusedId = [...selectedIds].find((id) => !usedIds.has(id));
  if (unusedId) {
    throw new Error(`Selected video ${unusedId} is not used by any production-plan scene.`);
  }
  const duration = timeline.reduce((sum, segment) => sum + segment.durationSeconds, 0);
  if (duration !== plan.videoDurationSeconds) {
    throw new Error(
      `Render timeline is ${duration} seconds but the plan is ${plan.videoDurationSeconds} seconds.`,
    );
  }
  return timeline;
}

function runProcess(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: "inherit" });
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}

function concatPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/'/g, "'\\''");
}

function safeFileName(title: string): string {
  return title.normalize("NFKD")
    .replace(/[^\w -]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase() || "trendmaker-video";
}

export async function renderProductionVideo(
  production: unknown,
  rootDirectory = process.cwd(),
): Promise<string> {
  const parsed = productionRenderSchema.safeParse(production);
  if (!parsed.success) {
    throw new Error(`Invalid production plan for rendering: ${parsed.error.message}`);
  }
  const timeline = createRenderTimeline(parsed.data);
  const sourceResults = checkSourceFiles(parsed.data, rootDirectory);
  const sources = new Map(sourceResults.map((source) => [source.videoId, source]));
  const mediaProperties = new Map<string, VideoFileProperties>();
  console.log(`[FFPROBE] Inspecting ${sourceResults.length} source file(s)...`);
  for (const source of sourceResults) {
    if (!source?.exists) {
      throw new Error(`Source video ${source.videoId} is missing or empty: ${source.filePath}`);
    }
    const properties = inspectVideoFile(source.filePath);
    mediaProperties.set(source.videoId, properties);
    console.log(
      `[FFPROBE] ${source.videoId}: ${properties.width}x${properties.height}, ` +
      `${properties.durationSeconds.toFixed(2)}s, ${properties.frameRate?.toFixed(2) ?? "unknown"} fps, ` +
      `${properties.hasAudio ? "audio present" : "no audio"}`,
    );
  }
  for (const segment of timeline) {
    if (!segment.sourceVideoId) continue;
    const properties = mediaProperties.get(segment.sourceVideoId);
    if (!properties) {
      throw new Error(`FFprobe properties are missing for source ${segment.sourceVideoId}.`);
    }
    if (segment.durationSeconds > properties.durationSeconds + 0.25) {
      throw new Error(
        `Scene ${segment.sceneNumber} requires ${segment.durationSeconds}s from source ` +
        `${segment.sourceVideoId}, but FFprobe measured ${properties.durationSeconds.toFixed(2)}s.`,
      );
    }
  }

  const outputDirectory = path.resolve(rootDirectory, "output");
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, `${safeFileName(parsed.data.plan.videoTitle)}.mp4`);
  if (fs.existsSync(outputPath)) {
    throw new Error(`Output already exists; move it before rendering again: ${outputPath}`);
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(outputDirectory, ".trendmaker-render-"));
  try {
    console.log(`[RENDER] Processing ${timeline.length} scene segment(s)...`);
    const segments: string[] = [];
    for (const [index, segment] of timeline.entries()) {
      console.log(`[RENDER] Rendering segment ${index + 1}/${timeline.length} (${segment.durationSeconds}s)...`);
      const segmentPath = path.join(temporaryDirectory, `segment-${index}.mp4`);
      const fadeDuration = 0.18;
      const videoFilter = [
        `scale=1080:1920:force_original_aspect_ratio=increase,` +
        `crop=1080:1920,setsar=1,fps=30,trim=duration=${segment.durationSeconds},` +
        `setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${segment.durationSeconds}`,
        "zoompan=z='min(1.03\\,1+0.03*on/90)':" +
          "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30",
        `fade=t=in:st=0:d=${fadeDuration}`,
        `fade=t=out:st=${Math.max(0, segment.durationSeconds - fadeDuration)}:d=${fadeDuration}`,
      ].join(",");
      const args = ["-hide_banner", "-loglevel", "error", "-nostats", "-y"];

      if (segment.sourceVideoId) {
        const source = sources.get(segment.sourceVideoId);
        if (!source?.exists) {
          throw new Error(`Source video ${segment.sourceVideoId} is missing or empty.`);
        }
        args.push("-i", source.filePath);
        const audio = mediaProperties.get(segment.sourceVideoId)?.hasAudio ?? false;
        if (!audio) {
          args.push(
            "-f", "lavfi", "-t", String(segment.durationSeconds), "-i",
            "anullsrc=channel_layout=stereo:sample_rate=48000",
          );
        }
        args.push(
          "-map", "0:v:0",
          "-map", audio ? "0:a:0" : "1:a:0",
          "-vf", videoFilter,
          "-af", "aresample=48000,apad",
        );
      } else {
        args.push(
          "-f", "lavfi", "-i",
          `color=c=black:s=1080x1920:r=30:d=${segment.durationSeconds}`,
          "-f", "lavfi", "-t", String(segment.durationSeconds), "-i",
          "anullsrc=channel_layout=stereo:sample_rate=48000",
          "-map", "0:v:0", "-map", "1:a:0", "-vf", videoFilter,
        );
      }

      args.push(
        "-t", String(segment.durationSeconds),
        "-r", "30",
        "-c:v", "libx264",
        "-preset", "medium",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-ar", "48000",
        "-ac", "2",
        "-movflags", "+faststart",
        segmentPath,
      );
      await runProcess("ffmpeg", args);
      segments.push(segmentPath);
    }

    const concatList = path.join(temporaryDirectory, "segments.txt");
    const stagedOutputPath = path.join(temporaryDirectory, "final.mp4");
    fs.writeFileSync(
      concatList,
      segments.map((segment) => `file '${concatPath(segment)}'`).join("\n"),
      "utf8",
    );
    await runProcess("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostats",
      "-f", "concat", "-safe", "0", "-i", concatList,
      "-c", "copy", "-movflags", "+faststart", stagedOutputPath,
    ]);
    console.log("[FFPROBE] Verifying the staged MP4...");
    const outputProperties = inspectVideoFile(stagedOutputPath);
    if (outputProperties.width !== 1080 || outputProperties.height !== 1920) {
      throw new Error(
        `Rendered video must be 1080x1920; FFprobe found ` +
        `${outputProperties.width}x${outputProperties.height}.`,
      );
    }
    if (Math.abs(outputProperties.durationSeconds - parsed.data.plan.videoDurationSeconds) > 0.5) {
      throw new Error(
        `Rendered video duration is ${outputProperties.durationSeconds.toFixed(2)}s; ` +
        `expected ${parsed.data.plan.videoDurationSeconds}s.`,
      );
    }
    if (outputProperties.videoCodec !== "h264" || outputProperties.pixelFormat !== "yuv420p") {
      throw new Error("Rendered video must use H.264 video with yuv420p pixel format.");
    }
    if (outputProperties.frameRate === null || Math.abs(outputProperties.frameRate - 30) > 0.01) {
      throw new Error("Rendered video must use a 30 fps frame rate.");
    }
    if (!outputProperties.hasAudio || outputProperties.audioCodec !== "aac" ||
        outputProperties.audioSampleRate !== 48000 || outputProperties.audioChannels !== 2) {
      throw new Error("Rendered video must contain 48 kHz stereo AAC audio.");
    }
    fs.renameSync(stagedOutputPath, outputPath);
    console.log(
      `[RENDER] Final MP4 created and verified: ${outputPath} ` +
      `(${outputProperties.width}x${outputProperties.height}, ` +
      `${outputProperties.durationSeconds.toFixed(2)}s, ${outputProperties.videoCodec}/${outputProperties.audioCodec}).`,
    );
    return outputPath;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}
