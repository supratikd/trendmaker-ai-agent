import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { uploadPost } from "../services/upload-post.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1) {
    throw new Error(
      "Usage: npm run upload:post -- [production.json]",
    );
  }

  const videoPath = path.resolve("output", "output.mp4");
  const productionPath = path.resolve(args[0] ?? "production-output.json");
  if (!fs.existsSync(productionPath)) {
    throw new Error(`Production JSON not found: ${productionPath}`);
  }

  const production: unknown = JSON.parse(fs.readFileSync(productionPath, "utf8"));
  const result = await uploadPost(videoPath, production);
  console.log(`Uploaded as unlisted: ${result.url}`);
}

main().catch((error: unknown) => {
  console.error("Failed to upload YouTube post:", error);
  process.exitCode = 1;
});
