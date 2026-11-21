import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { APPLICATION, YOUTUBE } from "../config/constants.js";
import { searchYouTubeVideos, YouTubeError } from "./youtube-api.js";

const server = new McpServer({
  name: YOUTUBE.MCP_SERVER_NAME,
  version: APPLICATION.MCP_SERVER_VERSION,
});

server.registerTool(
  "search_youtube_videos",
  {
    description:
      "Search YouTube videos by keyword and return up to 10 " +
      "video candidates ranked by actual view count. Defaults to short-form candidates.",
    inputSchema: {
      query: z.string().refine((value) => value.trim().length > 0, {
        message: "Query must not be blank.",
      }),
      maxResults: z.number().int().min(1).max(YOUTUBE.MAX_SEARCH_RESULTS).optional(),
      duration: z.enum(["short", "any"]).optional(),
    },
  },
  async ({ query, maxResults, duration }, { signal }) => {
    try {
      const result = await searchYouTubeVideos(
        query,
        maxResults ?? YOUTUBE.MAX_SEARCH_RESULTS,
        process.env.YOUTUBE_API_KEY?.trim(),
        signal,
        undefined,
        duration ?? "short",
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error: unknown) {
      if (!(error instanceof YouTubeError)) {
        console.error("Unexpected YouTube search failure.");
      }
      return {
        isError: true,
        content: [{
          type: "text",
          text: error instanceof YouTubeError ? error.message : "Unexpected YouTube search failure.",
        }],
      };
    }
  },
);

/** Connect the server over stdio; stdout is reserved for MCP messages. */
async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error("MCP server startup failed:", error);
  process.exitCode = 1;
});
