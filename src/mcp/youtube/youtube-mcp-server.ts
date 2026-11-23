import "dotenv/config";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { APPLICATION, YOUTUBE } from "../../config/constants.js";
import { searchYouTubeVideos, YouTubeError } from "../../integrations/youtube/youtube-api.js";
import { createVideoWorkflow } from "../../services/video-workflow.js";
import { downloadMissingSourceFiles } from "../../services/source-manager.js";
import { renderProductionVideo } from "../../production/video-renderer.js";
import { generateYouTubeShortMetadata, uploadPost } from "../../services/upload-post.js";

const server = new McpServer({
  name: YOUTUBE.MCP_SERVER_NAME,
  version: APPLICATION.MCP_SERVER_VERSION,
});

server.registerTool(
  "search_youtube_videos",
  {
    description:
      "Search YouTube by keyword and return up to 10 relevant videos marked Creative Commons " +
      "and up to 3 minutes long, ranked by actual view count. This does not verify vertical " +
      "Shorts format or independently establish ownership of all content. Results include " +
      "title, channel, description, tags, category, duration, and engagement metadata for " +
      "theme and vibe matching.",
    inputSchema: {
      query: z.string().refine((value) => value.trim().length > 0, {
        message: "Query must not be blank.",
      }),
      maxResults: z.number().int().min(1).max(YOUTUBE.MAX_SEARCH_RESULTS).optional(),
    },
  },
  async ({ query, maxResults }, { signal }) => {
    console.error(`[MCP SERVER] Executing search_youtube_videos for: "${query}"`);
    try {
      const result = await searchYouTubeVideos(
        query,
        maxResults ?? YOUTUBE.MAX_SEARCH_RESULTS,
        process.env.YOUTUBE_API_KEY?.trim(),
        signal,
      );
      console.error(`[MCP SERVER] Search complete. Candidates: ${result.results.length}`);
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

server.registerTool(
  "create_video_production_plan",
  {
    description:
      "Analyze a YouTube Shorts request, search YouTube candidates, select clips, and " +
      "return a production plan. This tool does not download, render, or publish anything.",
    inputSchema: {
      request: z.string().refine((value) => value.trim().length > 0, {
        message: "Request must not be blank.",
      }),
    },
  },
  async ({ request }) => {
    try {
      const production = await createVideoWorkflow(request);
      return {
        content: [{ type: "text", text: JSON.stringify(production, null, 2) }],
      };
    } catch (error: unknown) {
      return mcpToolError(error);
    }
  },
);

server.registerTool(
  "render_youtube_short",
  {
    description:
      "Verify and download selected source footage, then render the supplied production plan " +
      "as an MP4. Only call this after the user has authorized reuse of every source.",
    inputSchema: {
      production: z.record(z.string(), z.unknown()),
      authorizedSources: z.literal(true),
    },
  },
  async ({ production, authorizedSources }) => {
    try {
      if (!authorizedSources) {
        throw new Error("Source reuse authorization is required.");
      }
      const downloadResult = await downloadMissingSourceFiles(
        production,
        process.env.YOUTUBE_API_KEY?.trim(),
      );
      if (downloadResult.errors.length > 0 ||
          downloadResult.sources.some((source) => !source.exists)) {
        throw new Error("Cannot render until all selected source videos are available.");
      }
      const outputPath = await renderProductionVideo(production);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ outputPath, sources: downloadResult.sources }, null, 2),
        }],
      };
    } catch (error: unknown) {
      return mcpToolError(error);
    }
  },
);

server.registerTool(
  "preview_youtube_upload",
  {
    description:
      "Generate the title and description that would be used for a YouTube upload. " +
      "This tool previews metadata and does not upload.",
    inputSchema: {
      production: z.record(z.string(), z.unknown()),
    },
  },
  async ({ production }) => {
    try {
      const metadata = await generateYouTubeShortMetadata(production);
      return {
        content: [{ type: "text", text: JSON.stringify(metadata, null, 2) }],
      };
    } catch (error: unknown) {
      return mcpToolError(error);
    }
  },
);

server.registerTool(
  "upload_youtube_short",
  {
    description:
      "Upload a local rendered MP4 to YouTube. Requires explicit user confirmation " +
      "and refuses public or private upload unless confirmation is true.",
    inputSchema: {
      videoPath: z.string().min(1),
      production: z.record(z.string(), z.unknown()),
      confirmUpload: z.literal(true),
      privacyStatus: z.enum(["public", "unlisted", "private"]).default("unlisted"),
    },
  },
  async ({ videoPath, production, confirmUpload, privacyStatus }) => {
    try {
      if (!confirmUpload) {
        throw new Error("Explicit upload confirmation is required.");
      }
      const result = await uploadPost(videoPath, production, privacyStatus);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error: unknown) {
      return mcpToolError(error);
    }
  },
);

function mcpToolError(error: unknown): {
  isError: true;
  content: { type: "text"; text: string }[];
} {
  if (error instanceof YouTubeError) {
    return toolError(error.message);
  }
  if (error instanceof Error) {
    console.error(`MCP tool failure: ${error.message}`);
    return toolError(error.message);
  }
  console.error("Unexpected MCP tool failure.");
  return toolError("Unexpected MCP tool failure.");
}

function toolError(message: string): {
  isError: true;
  content: { type: "text"; text: string }[];
} {
  return {
    isError: true,
    content: [{ type: "text", text: message }],
  };
}

/** Connect the server over stdio; stdout is reserved for MCP messages. */
async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error("MCP server startup failed:", error);
  process.exitCode = 1;
});
