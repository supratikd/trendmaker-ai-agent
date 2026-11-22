import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import {
  clearSourceAndOutputDirectories,
  downloadMissingSourceFiles,
} from "../services/source-manager.js";
import { uploadPost } from "../services/upload-post.js";
import { renderProductionVideo } from "../production/video-renderer.js";
import { exampleRequest } from "./example-request.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (!args.includes("--authorized-sources")) {
    throw new Error(
      "Pass --authorized-sources only when you have permission to download and reuse every selected source video.",
    );
  }

  const cleared = clearSourceAndOutputDirectories();
  console.log(
    `[CLEANUP] Cleared source and output directories: ` +
    `${cleared.sourceDirectory}; ${cleared.outputDirectory}`,
  );

  const fileOption = args.indexOf("--from-file");
  let production: unknown;
  if (fileOption >= 0) {
    console.log("[STAGE 1/4] Loading production plan from file...");
    const inputPath = args[fileOption + 1];
    if (!inputPath || inputPath.startsWith("--")) {
      throw new Error("--from-file requires a production JSON file path.");
    }
    const resolvedInput = path.resolve(inputPath);
    if (!fs.existsSync(resolvedInput)) {
      throw new Error(`Production JSON not found: ${resolvedInput}`);
    }
    production = JSON.parse(fs.readFileSync(resolvedInput, "utf8"));
    console.log(`[STAGE 1/4] Production plan loaded: ${resolvedInput}`);
  } else {
    const ignored = new Set(["--authorized-sources"]);
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--from-file") ignored.add(args[index + 1]);
    }
    const request = args.filter((arg) => !ignored.has(arg)).join(" ").trim() || exampleRequest;
    console.log(`[STAGE 1/4] Request received: ${request}`);
    const { createVideoWorkflow } = await import("../services/video-workflow.js");
    production = await createVideoWorkflow(request);
    const outputJson = path.resolve("production-output.json");
    fs.writeFileSync(outputJson, `${JSON.stringify(production, null, 2)}\n`, "utf8");
    console.log(`[STAGE 1/4] Production plan created and saved: ${outputJson}`);
  }

  console.log("[STAGE 2/4] Checking, verifying, and downloading source videos...");
  const downloadResult = await downloadMissingSourceFiles(
    production, process.env.YOUTUBE_API_KEY?.trim(),
  );
  for (const source of downloadResult.sources) {
    console.log(`${source.exists ? "AVAILABLE" : "MISSING"} | ${source.videoId} | ${source.filePath}`);
  }
  for (const error of downloadResult.errors) {
    console.error(`DOWNLOAD FAILED | ${error.videoId} | ${error.message}`);
  }
  if (downloadResult.errors.length > 0 || downloadResult.sources.some((source) => !source.exists)) {
    throw new Error("Cannot render until all selected source videos are available.");
  }
  console.log("[STAGE 2/4] All source videos are available.");

  console.log("[STAGE 3/4] Rendering final video with FFmpeg...");
  const outputPath = await renderProductionVideo(production);
  console.log(`[STAGE 3/4] Production video created: ${outputPath}`);
  console.log("Source audio is retained when present; planned narration and text are not rendered.");
  console.log("Music direction is not rendered because no music asset was supplied.");

  console.log("[STAGE 4/4] Uploading the completed video to YouTube...");
  const upload = await uploadPost(outputPath, production);
  console.log(`[STAGE 4/4] YouTube upload complete (${upload.privacyStatus}): ${upload.url}`);
}

main().catch((error: unknown) => {
  console.error("Failed to produce and upload the video:", error);
  process.exitCode = 1;
});
