
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { z } from "zod";

interface ProductionClip {
  order: number;
  videoId: string;
  title: string;
  url: string;
  durationSeconds: number;
}

interface ProductionInput {
  selection: {
    clips: ProductionClip[];
  };
}

interface SourceFileResult {
  videoId: string;
  title: string;
  filePath: string;
  exists: boolean;
  sizeBytes: number;
}

const productionSchema = z.object({
  selection: z.object({
    clips: z.array(z.object({
      videoId: z.string().regex(/^[A-Za-z0-9_-]+$/),
      title: z.string().trim().min(1),
    })),
  }),
});

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function fileInfo(filePath: string): { exists: boolean; sizeBytes: number } {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: stat.isFile() && stat.size > 0,
      sizeBytes: stat.isFile() ? stat.size : 0,
    };
  } catch (error: unknown) {
    if (isMissingFile(error)) return { exists: false, sizeBytes: 0 };
    throw error;
  }
}

function directoryFiles(directory: string): string[] {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch (error: unknown) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

export function checkSourceFiles(
  production: ProductionInput,
  rootDirectory = process.cwd(),
): SourceFileResult[] {
  const parsed = productionSchema.safeParse(production);
  if (!parsed.success) {
    throw new Error(`Invalid production selection: ${parsed.error.message}`);
  }
  const root = path.resolve(rootDirectory);
  const sourceDirectory = path.join(root, "assets", "sources");
  const directories = [
    { path: sourceDirectory, files: directoryFiles(sourceDirectory) },
    { path: root, files: directoryFiles(root) },
  ];

  return parsed.data.selection.clips.map((clip) => {
    let filePath = path.join(sourceDirectory, `${clip.videoId}.mp4`);
    for (const directory of directories) {
      const exactName = `${clip.videoId}.mp4`;
      const exact = directory.files.find((name) => name === exactName);
      if (exact) {
        filePath = path.join(directory.path, exact);
        break;
      }

      const matching = directory.files.filter((name) => {
        const extension = path.extname(name);
        return extension.toLowerCase() === ".mp4" &&
          path.basename(name, extension).endsWith(`[${clip.videoId}]`);
      });
      if (matching.length > 1) {
        throw new Error(
          `Multiple source files match video ${clip.videoId} in ${directory.path}. ` +
          "Keep one file or name the intended file by video ID.",
        );
      }
      if (matching.length === 1) {
        filePath = path.join(directory.path, matching[0]);
        break;
      }
    }

    const { exists, sizeBytes } = fileInfo(filePath);

    return {
      videoId: clip.videoId,
      title: clip.title,
      filePath,
      exists,
      sizeBytes,
    };
  });
}

export function downloadMissingSourceFiles(
  production: ProductionInput,
  rootDirectory = process.cwd(),
): { sources: SourceFileResult[]; errors: { videoId: string; message: string }[] } {
  const sources = checkSourceFiles(production, rootDirectory);
  const sourceDirectory = path.resolve(rootDirectory, "assets", "sources");
  const errors: { videoId: string; message: string }[] = [];
  const attempted = new Set<string>();

  for (const source of sources) {
    if (source.exists || attempted.has(source.videoId)) continue;
    attempted.add(source.videoId);

    try {
      const target = path.join(sourceDirectory, `${source.videoId}.mp4`);
      if (fs.existsSync(target)) {
        throw new Error(`Target already exists but is not a nonempty file: ${target}`);
      }
      fs.mkdirSync(sourceDirectory, { recursive: true });
      const result = childProcess.spawnSync("yt-dlp", [
        "--ignore-config", "--verbose", "-f", "18", "--no-overwrites",
        "--no-playlist", "-o", target,
        `https://www.youtube.com/watch?v=${source.videoId}`,
      ], { stdio: "inherit" });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        throw new Error(`yt-dlp failed${result.signal ? ` with signal ${result.signal}` : ` with exit code ${result.status}`}`);
      }
      if (!fileInfo(target).exists) {
        throw new Error(`yt-dlp did not produce a nonempty file: ${target}`);
      }
    } catch (error: unknown) {
      errors.push({
        videoId: source.videoId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { sources: checkSourceFiles(production, rootDirectory), errors };
}
