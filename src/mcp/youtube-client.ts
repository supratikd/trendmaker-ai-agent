import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { youtubeVideoIdSchema, youtubeWatchUrl } from "./youtube-api.js";
import type { UserContext } from "../services/context-analyzer.js";
import { parseStructuredJson } from "../services/structured-json.js";

export const youtubeCandidateSchema = z.object({
  videoId: youtubeVideoIdSchema,
  title: z.string().trim().min(1),
  channel: z.string().trim().min(1),
  publishedAt: z.string().trim().min(1),
  durationSeconds: z.number().finite().nonnegative(),
  views: z.number().int().nonnegative().nullable(),
  likes: z.number().int().nonnegative().nullable(),
  comments: z.number().int().nonnegative().nullable(),
  url: z.string().url(),
  thumbnail: z.string().url().nullable(),
}).refine((video) => video.url === youtubeWatchUrl(video.videoId), {
  path: ["url"],
  message: "URL must match the video ID.",
});

export type YouTubeCandidate = z.infer<typeof youtubeCandidateSchema>;

const searchResultSchema = z.object({
  query: z.string(),
  results: z.array(youtubeCandidateSchema),
});

export async function searchYouTubeCandidates(
  context: UserContext,
): Promise<YouTubeCandidate[]> {
  const topic = context.topic.trim();
  if (!topic) {
    throw new Error("Cannot search YouTube without a topic.");
  }
  const query = [topic, context.contentStyle?.trim()].filter(Boolean).join(" ");
  const duration = /\bshorts\b/i.test(context.platform) ? "short" : "any";
  const client = new Client({ name: "trendmaker-clip-selector", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/youtube-server.ts"],
    cwd: process.cwd(),
  });

  await client.connect(transport);
  try {
    for (const searchQuery of [...new Set([query, topic])]) {
      const response = await client.callTool({
        name: "search_youtube_videos",
        arguments: { query: searchQuery, duration },
      });
      const content = z.array(z.object({
        type: z.literal("text"),
        text: z.string(),
      })).length(1).parse(response.content);
      if (response.isError) {
        throw new Error(`YouTube MCP search failed: ${content[0].text}`);
      }
      const results = parseStructuredJson(content[0].text, searchResultSchema, "YouTube MCP search").results;
      if (results.length > 0) {
        return results;
      }
    }
    return [];
  } finally {
    await client.close();
  }
}
