import { spawnSync } from "node:child_process";
import { z } from "zod";

const probeOutputSchema = z.object({
  streams: z.array(z.object({
    codec_type: z.string(),
    codec_name: z.string().nullable().optional(),
    width: z.number().int().positive().nullable().optional(),
    height: z.number().int().positive().nullable().optional(),
    avg_frame_rate: z.string().nullable().optional(),
    pix_fmt: z.string().nullable().optional(),
    sample_rate: z.string().nullable().optional(),
    channels: z.number().int().positive().nullable().optional(),
    duration: z.string().nullable().optional(),
  })),
  format: z.object({
    duration: z.string().nullable().optional(),
  }).optional(),
});

export interface VideoFileProperties {
  durationSeconds: number;
  width: number;
  height: number;
  frameRate: number | null;
  videoCodec: string | null;
  pixelFormat: string | null;
  hasAudio: boolean;
  audioCodec: string | null;
  audioSampleRate: number | null;
  audioChannels: number | null;
}

type ProbeRunner = (filePath: string) => string;

function runFfprobe(filePath: string): string {
  const result = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries",
    "format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,pix_fmt,sample_rate,channels,duration",
    "-of", "json",
    filePath,
  ], { encoding: "utf8", windowsHide: true });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    const details = result.stderr.trim();
    throw new Error(
      `FFprobe could not inspect "${filePath}"${details ? `: ${details}` : "."}`,
    );
  }
  return result.stdout;
}

function parseFrameRate(value: string | null | undefined): number | null {
  if (!value) return null;
  const [numeratorText, denominatorText] = value.split("/");
  const numerator = Number(numeratorText);
  const denominator = Number(denominatorText);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return null;
  }
  const frameRate = numerator / denominator;
  return Number.isFinite(frameRate) && frameRate > 0 ? frameRate : null;
}

export function inspectVideoFile(
  filePath: string,
  runProbe: ProbeRunner = runFfprobe,
): VideoFileProperties {
  const probeOutput = runProbe(filePath);
  let output: unknown;
  try {
    output = JSON.parse(probeOutput);
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      throw new Error(`FFprobe returned invalid JSON for "${filePath}".`);
    }
    throw error;
  }

  const parsed = probeOutputSchema.safeParse(output);
  if (!parsed.success) {
    throw new Error(`FFprobe returned invalid media properties for "${filePath}": ${parsed.error.message}`);
  }

  const video = parsed.data.streams.find((stream) => stream.codec_type === "video");
  if (!video?.width || !video.height) {
    throw new Error(`No video stream with valid dimensions was found in "${filePath}".`);
  }
  const audio = parsed.data.streams.find((stream) => stream.codec_type === "audio");
  const durationSeconds = Number(parsed.data.format?.duration ?? video.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`FFprobe returned an invalid video duration for "${filePath}".`);
  }

  const audioSampleRate = audio?.sample_rate ? Number(audio.sample_rate) : null;
  return {
    durationSeconds,
    width: video.width,
    height: video.height,
    frameRate: parseFrameRate(video.avg_frame_rate),
    videoCodec: video.codec_name ?? null,
    pixelFormat: video.pix_fmt ?? null,
    hasAudio: Boolean(audio),
    audioCodec: audio?.codec_name ?? null,
    audioSampleRate: audioSampleRate !== null && Number.isFinite(audioSampleRate)
      ? audioSampleRate
      : null,
    audioChannels: audio?.channels ?? null,
  };
}
