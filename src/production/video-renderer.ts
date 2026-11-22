
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { z } from "zod";
import { checkSourceFiles } from "../services/source-manager.js";
import { allocateSceneSourceDurations } from "../services/scene-source-allocation.js";
import { inspectVideoFile } from "./ffprobe-inspector.js";
import type { VideoFileProperties } from "./ffprobe-inspector.js";

function videoEncoderArgs(): string[] {
  return [
    "-c:v", "h264_nvenc",
    "-preset", "p4",
    "-rc", "vbr",
    "-cq", "23",
    "-b:v", "0",
  ];
}

function intermediateVideoEncoderArgs(): string[] {
  return ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-threads", "2"];
}

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
      ...videoEncoderArgs(),
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
  context: z.object({
    contentStyle: z.string().optional(),
    actions: z.array(z.string()).optional(),
  }).optional(),
  selection: z.object({
    clips: z.array(z.object({
      videoId: z.string().regex(/^[A-Za-z0-9_-]+$/),
      title: z.string().trim().min(1),
      durationSeconds: z.number().int().positive().max(180),
    })).min(1),
  }),
  plan: z.object({
    videoTitle: z.string().trim().min(1),
    visualStyle: z.string().optional(),
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

const COMPILATION_TRANSITION_SECONDS = 0.35;
const MAX_END_CARD_DURATION_SECONDS = 1.5;
const MAX_SOURCE_DURATION_ROUNDING_SECONDS = 1;

export function getSourceDurationPadding(
  sceneNumber: number,
  videoId: string,
  requiredDurationSeconds: number,
  actualDurationSeconds: number,
): number {
  const shortfall = Math.max(0, requiredDurationSeconds - actualDurationSeconds);
  if (shortfall > MAX_SOURCE_DURATION_ROUNDING_SECONDS) {
    throw new Error(
      `Scene ${sceneNumber} requires ${requiredDurationSeconds}s from source ${videoId}, ` +
      `but FFprobe measured ${actualDurationSeconds.toFixed(2)}s; the shortfall exceeds ` +
      `${MAX_SOURCE_DURATION_ROUNDING_SECONDS}s.`,
    );
  }
  return shortfall;
}

function isShortCompilation(production: z.infer<typeof productionRenderSchema>): boolean {
  const hints = [
    production.context?.contentStyle,
    ...(production.context?.actions ?? []),
    production.plan.visualStyle,
    production.plan.videoTitle,
  ];
  return hints.some((hint) => /compilation|montage|highlight reel/i.test(hint ?? ""));
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
  const seenInScenes = new Set<string>();
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
    for (const source of sceneSources) {
      if (seenInScenes.has(source.videoId)) {
        throw new Error(
          `Source video ${source.videoId} is reused. Each source may appear in exactly one scene.`,
        );
      }
      seenInScenes.add(source.videoId);
    }
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

function trimTimelineToDuration(
  timeline: readonly RenderSegment[],
  durationSeconds: number,
): RenderSegment[] {
  let remaining = durationSeconds;
  const trimmed: RenderSegment[] = [];
  for (const segment of timeline) {
    if (remaining <= 0) break;
    const duration = Math.min(segment.durationSeconds, remaining);
    trimmed.push({ ...segment, durationSeconds: duration });
    remaining -= duration;
  }
  if (remaining > 0.001) {
    throw new Error(`Cannot reserve an end card; source timeline is short by ${remaining}s.`);
  }
  return trimmed;
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

export function clearProductionOutputDirectory(rootDirectory = process.cwd()): string {
  const outputDirectory = path.resolve(rootDirectory, "output");
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const entry of fs.readdirSync(outputDirectory)) {
    fs.rmSync(path.join(outputDirectory, entry), { recursive: true, force: true });
  }
  return outputDirectory;
}

function overlayFontFile(): string {
  const candidates = process.platform === "win32"
    ? [
      path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts", "arialbi.ttf"),
      path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts", "segoeuiz.ttf"),
    ]
    : process.platform === "darwin"
      ? [
        "/System/Library/Fonts/Supplemental/Arial Bold Italic.ttf",
      ]
      : [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-BoldOblique.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-BoldItalic.ttf",
      ];
  const fontPath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!fontPath) {
    throw new Error(
      "Cannot render text overlays: no supported bold italic font file was found.",
    );
  }
  return fontPath.replace(/\\/g, "/").replace(/:/g, "\\:");
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
  const endCardDuration = Math.min(
    MAX_END_CARD_DURATION_SECONDS,
    parsed.data.plan.videoDurationSeconds / 2,
  );
  const contentDuration = parsed.data.plan.videoDurationSeconds - endCardDuration;
  const contentTimeline = trimTimelineToDuration(timeline, contentDuration);
  const sourceResults = checkSourceFiles(parsed.data, rootDirectory);
  const sources = new Map(sourceResults.map((source) => [source.videoId, source]));
  const sourceOrderById = new Map<string, number>();
  for (const segment of timeline) {
    if (segment.sourceVideoId && !sourceOrderById.has(segment.sourceVideoId)) {
      sourceOrderById.set(segment.sourceVideoId, sourceOrderById.size + 1);
    }
  }
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
    getSourceDurationPadding(
      segment.sceneNumber,
      segment.sourceVideoId,
      segment.durationSeconds,
      properties.durationSeconds,
    );
  }

  const outputDirectory = clearProductionOutputDirectory(rootDirectory);
  const outputPath = path.join(outputDirectory, "output.mp4");

  const temporaryDirectory = fs.mkdtempSync(path.join(outputDirectory, ".trendmaker-render-"));
  try {
    const shortCompilation = isShortCompilation(parsed.data);
    const overlayFont = overlayFontFile();
    console.log(`[RENDER] Processing ${contentTimeline.length} scene segment(s)...`);
    const segments: string[] = [];
    for (const [index, segment] of contentTimeline.entries()) {
      console.log(`[RENDER] Rendering segment ${index + 1}/${contentTimeline.length} (${segment.durationSeconds}s)...`);
      const segmentPath = path.join(temporaryDirectory, `segment-${index}.mp4`);
      const fadeDuration = 0.18;
      const padDuration = shortCompilation && index < contentTimeline.length - 1
        ? COMPILATION_TRANSITION_SECONDS
        : 0;
      const outputDuration = segment.durationSeconds + padDuration;
      const sourceProperties = segment.sourceVideoId
        ? mediaProperties.get(segment.sourceVideoId)
        : undefined;
      const sourceDurationPadding = segment.sourceVideoId && sourceProperties
        ? getSourceDurationPadding(
          segment.sceneNumber,
          segment.sourceVideoId,
          segment.durationSeconds,
          sourceProperties.durationSeconds,
        )
        : 0;
      const sourceOrder = segment.sourceVideoId
        ? sourceOrderById.get(segment.sourceVideoId)
        : index + 1;
      const videoFilter = [
        `scale=1080:1920:force_original_aspect_ratio=increase,` +
        `crop=1080:1920,setsar=1,fps=30,trim=duration=${segment.durationSeconds},` +
        `setpts=PTS-STARTPTS,tpad=stop_mode=clone:` +
        `stop_duration=${sourceDurationPadding + padDuration}`,
        "zoompan=z='min(1.03\\,1+0.03*on/90)':" +
          "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30",
        ...(shortCompilation
          ? [
            `drawtext=text='#${sourceOrder ?? index + 1}':fontfile='${overlayFont}':` +
            "fontcolor=white:fontsize=112:" +
            "box=1:boxcolor=0x111111@0.78:boxborderw=28:" +
            "borderw=5:bordercolor=0xF5C842:shadowcolor=black@0.65:shadowx=6:shadowy=6:" +
            "x=54:y=54:" +
            "alpha='if(lt(t\\,1)\\,1\\,if(lt(t\\,1.4)\\,1-(t-1)/0.4\\,0))'",
          ]
          : [
            `fade=t=in:st=0:d=${fadeDuration}`,
            `fade=t=out:st=${Math.max(0, segment.durationSeconds - fadeDuration)}:d=${fadeDuration}`,
          ]),
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
            "-f", "lavfi", "-t", String(outputDuration), "-i",
            "anullsrc=channel_layout=stereo:sample_rate=48000",
          );
        }
        args.push(
          "-map", "0:v:0",
          "-map", audio ? "0:a:0" : "1:a:0",
          "-vf", videoFilter,
          "-af", `aresample=48000,apad=whole_dur=${outputDuration}`,
        );
      } else {
        args.push(
          "-f", "lavfi", "-i",
          `color=c=black:s=1080x1920:r=30:d=${outputDuration}`,
          "-f", "lavfi", "-t", String(outputDuration), "-i",
          "anullsrc=channel_layout=stereo:sample_rate=48000",
          "-map", "0:v:0", "-map", "1:a:0", "-vf", videoFilter,
        );
      }

      args.push(
        "-t", String(outputDuration),
        "-r", "30",
        ...intermediateVideoEncoderArgs(),
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

    const stagedContentPath = path.join(temporaryDirectory, "content.mp4");
    if (shortCompilation && segments.length > 1) {
      console.log("[RENDER] Assembling compilation transitions...");
      const filterParts: string[] = [];
      for (const [index] of segments.entries()) {
        filterParts.push(
          `[${index}:v]settb=AVTB,setpts=PTS-STARTPTS,format=yuv420p[v${index}]`,
          `[${index}:a]aresample=48000,asetpts=PTS-STARTPTS[a${index}]`,
        );
      }
      let offset = 0;
      let videoInput = "v0";
      let audioInput = "a0";
      for (let index = 1; index < segments.length; index++) {
        offset += contentTimeline[index - 1].durationSeconds;
        const videoOutput = index === segments.length - 1 ? "vout" : `vx${index}`;
        const audioOutput = index === segments.length - 1 ? "aout" : `ax${index}`;
        filterParts.push(
          `[${videoInput}][v${index}]xfade=transition=smoothleft:` +
          `duration=${COMPILATION_TRANSITION_SECONDS}:offset=${offset}[${videoOutput}]`,
          `[${audioInput}][a${index}]acrossfade=d=${COMPILATION_TRANSITION_SECONDS}:` +
          `c1=tri:c2=tri[${audioOutput}]`,
        );
        videoInput = videoOutput;
        audioInput = audioOutput;
      }
      const args = ["-hide_banner", "-loglevel", "error", "-nostats"];
      for (const segment of segments) args.push("-i", segment);
      args.push(
        "-filter_complex", filterParts.join(";"),
        "-map", "[vout]", "-map", "[aout]",
        "-t", String(contentDuration),
        "-r", "30",
        ...intermediateVideoEncoderArgs(),
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-ar", "48000",
        "-ac", "2",
        "-movflags", "+faststart",
        stagedContentPath,
      );
      await runProcess("ffmpeg", args);
    } else {
      const concatList = path.join(temporaryDirectory, "segments.txt");
      fs.writeFileSync(
        concatList,
        segments.map((segment) => `file '${concatPath(segment)}'`).join("\n"),
        "utf8",
      );
      await runProcess("ffmpeg", [
        "-hide_banner", "-loglevel", "error", "-nostats",
        "-f", "concat", "-safe", "0", "-i", concatList,
        "-c", "copy", "-movflags", "+faststart", stagedContentPath,
      ]);
    }

    const endCardPath = path.join(temporaryDirectory, "end-card.mp4");
    console.log("[RENDER] Rendering the animated black end card...");
    const animationDuration = Math.min(0.8, endCardDuration / 2);
    const zoomOutFrames = Math.max(1, Math.round(animationDuration * 30));
    const soundDuration = Math.min(1, endCardDuration);
    const soundFadeOut = Math.min(0.25, soundDuration / 2);
    const soundFadeOutStart = soundDuration - soundFadeOut;
    const endCardFilter =
      `drawtext=text='Made by \n TrendMaker AI':fontfile='${overlayFont}':` +
      "fontcolor=white:fontsize=84:x=(w-text_w)/2:y=(h-text_h)/2," +
      `zoompan=z='if(lte(on\\,${zoomOutFrames})\\,1.8-0.8*on/${zoomOutFrames}\\,1)':` +
      "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1080x1920:fps=30";
    const soundEffect =
      `aevalsrc=(0.16*sin(2*PI*(523*t+180*t*t))+` +
      `0.08*sin(2*PI*(784*t+240*t*t)))*exp(-3*t):s=48000:d=${soundDuration}`;
    const endCardArgs = [
      "-hide_banner", "-loglevel", "error", "-nostats", "-y",
      "-f", "lavfi", "-i", `color=c=black:s=1080x1920:r=30:d=${endCardDuration}`,
      "-f", "lavfi", "-i", soundEffect,
      "-map", "0:v:0", "-map", "1:a:0",
      "-vf", endCardFilter,
      "-af", `aresample=48000,afade=t=in:st=0:d=0.02,` +
        `afade=t=out:st=${soundFadeOutStart}:d=${soundFadeOut},` +
        `apad=whole_dur=${endCardDuration}`,
      "-t", String(endCardDuration),
      "-r", "30",
      ...intermediateVideoEncoderArgs(),
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-ar", "48000",
      "-ac", "2",
      "-movflags", "+faststart",
      endCardPath,
    ];
    await runProcess("ffmpeg", endCardArgs);

    const concatList = path.join(temporaryDirectory, "final-segments.txt");
    const stagedCombinedPath = path.join(temporaryDirectory, "combined.mp4");
    console.log("[RENDER] Joining the video and end card...");
    fs.writeFileSync(
      concatList,
      [stagedContentPath, endCardPath]
        .map((segment) => `file '${concatPath(segment)}'`)
        .join("\n"),
      "utf8",
    );
    await runProcess("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostats",
      "-f", "concat", "-safe", "0", "-i", concatList,
      "-c", "copy", "-movflags", "+faststart", stagedCombinedPath,
    ]);

    const stagedOutputPath = path.join(temporaryDirectory, "final.mp4");
    console.log("[RENDER] Encoding the final video with NVENC...");
    await runProcess("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-nostats", "-y",
      "-i", stagedCombinedPath,
      "-t", String(parsed.data.plan.videoDurationSeconds),
      "-r", "30",
      ...videoEncoderArgs(),
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-ar", "48000",
      "-ac", "2",
      "-movflags", "+faststart",
      stagedOutputPath,
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
