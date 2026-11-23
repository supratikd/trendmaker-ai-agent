import fs from "node:fs";
import path from "node:path";
import { renderProductionVideo } from "../production/video-renderer.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    throw new Error("Usage: npm run render:production -- [production.json]");
  }


  const inputPath = path.resolve(args[0] ?? "production-output.json");
  if (!fs.existsSync(inputPath)) {
    throw new Error(`Production JSON not found: ${inputPath}`);
  }

  const production: unknown = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  console.log(`[RENDER] Loaded production JSON: ${inputPath}`);
  const outputPath = await renderProductionVideo(production);
  console.log(`[RENDER] Production video created: ${outputPath}`);
  console.log("[RENDER] Upload not requested. The MP4 remains local.");
}

main().catch((error: unknown) => {
  console.error("Failed to render production JSON:", error);
  process.exitCode = 1;
});
