
import { discoverYouTubeVideos } from "../mcp/youtube-agent.js";
import { exampleRequest } from "./example-request.js";

async function main() {
  const request = process.argv.slice(2).join(" ").trim() ||
    exampleRequest;
  const result = await discoverYouTubeVideos(request);

  console.log("\n===== TRENDMAKER =====\n");
  console.log(result);
}

main().catch((error: unknown) => {
  console.error("Failed to discover YouTube videos:", error);
  process.exitCode = 1;
});
