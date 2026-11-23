import { z } from "zod";
import { youtubeVideoIdSchema, youtubeWatchUrl } from "../../integrations/youtube/youtube-api.js";
import type { UserContext } from "../../services/context-analyzer.js";
import { parseStructuredJson } from "../../services/structured-json.js";
import { YOUTUBE } from "../../config/constants.js";
import { withTrendmakerMcpClient } from "../trendmaker-mcp-client.js";

export const youtubeCandidateSchema = z.object({
  videoId: youtubeVideoIdSchema,
  license: z.literal("creativeCommon"),
  title: z.string().trim().min(1),
  channel: z.string().trim().min(1),
  publishedAt: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  tags: z.array(z.string().trim().min(1)).optional(),
  categoryId: z.string().trim().min(1).nullable().optional(),
  durationSeconds: z.number().finite().positive().max(YOUTUBE.MAX_CANDIDATE_DURATION_SECONDS),
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
  console.log("[MCP] Starting local YouTube MCP server...");
  return withTrendmakerMcpClient({
    clientName: "trendmaker-youtube-mcp-client",
    args: ["--import", "tsx", "src/mcp/youtube/youtube-mcp-server.ts"],
  }, async (client) => {
    console.log("[MCP] Server connected. Calling search_youtube_videos...");
    const candidates = new Map<string, YouTubeCandidate>();
    for (const searchQuery of [...new Set([query, topic])]) {
      console.log(`[MCP] Searching YouTube: "${searchQuery}"`);
      const response = await client.callTool({
        name: "search_youtube_videos",
        arguments: { query: searchQuery },
      });
      const content = z.array(z.object({
        type: z.literal("text"),
        text: z.string(),
      })).length(1).parse(response.content);
      if (response.isError) {
        throw new Error(`YouTube MCP search failed: ${content[0].text}`);
      }
      const results = parseStructuredJson(content[0].text, searchResultSchema, "YouTube MCP search").results;
      for (const video of results) {
        if (!candidates.has(video.videoId)) candidates.set(video.videoId, video);
      }
      if (candidates.size >= YOUTUBE.MAX_SELECTED_SHORTS) break;
    }
    const results = [...candidates.values()]
      .sort((a, b) => (b.views ?? -1) - (a.views ?? -1))
      .slice(0, YOUTUBE.MAX_RETURNED_RESULTS);
    return results;
  }).finally(() => {
    console.log("[MCP] Search complete. Local MCP server closed.");
  });
}
