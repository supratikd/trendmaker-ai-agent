
import { discoverYouTubeVideos } from "./mcp/youtube-agent.js";

async function main() {
  const result = await discoverYouTubeVideos(
    "Find the most viewed MEME YouTube Shorts about Jensen Huang"
  );

  console.log("\n===== TRENDMAKER =====\n");
  console.log(result);
}

main().catch(console.error);
