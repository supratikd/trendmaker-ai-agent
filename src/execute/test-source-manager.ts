
import fs from "node:fs";
import path from "node:path";
import { downloadMissingSourceFiles } from "../services/source-manager.js";

const jsonPath = path.resolve("production-output.json");

if (!fs.existsSync(jsonPath)) {
  throw new Error(`Production JSON not found: ${jsonPath}`);
}

const production = JSON.parse(
  fs.readFileSync(jsonPath, "utf-8")
);

const { sources: results, errors } = downloadMissingSourceFiles(production);

console.log("\nSOURCE FILE CHECK\n");

for (const source of results) {
  console.log(
    `${source.exists ? "AVAILABLE" : "MISSING"} | ${source.videoId} | ${source.filePath}`
  );
}

for (const error of errors) {
  console.error(`DOWNLOAD FAILED | ${error.videoId} | ${error.message}`);
}

if (errors.length > 0 || results.some((source) => !source.exists)) {
  console.error(
    "\nSome sources are missing or empty. Check the yt-dlp errors above, " +
    "or place authorized MP4 files in assets/sources as <videoId>.mp4.",
  );
  process.exitCode = 1;
}
