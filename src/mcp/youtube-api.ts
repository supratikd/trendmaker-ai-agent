import { z } from "zod";
import { YOUTUBE } from "../config/constants.js";

export class YouTubeError extends Error {}

export const youtubeVideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]+$/);

export function youtubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

const searchSchema = z.object({
  items: z.array(z.object({ id: z.object({ videoId: youtubeVideoIdSchema }) })),
});

const countSchema = z.string().regex(/^\d+$/).refine(
  (value) => Number.isSafeInteger(Number(value)),
  "Count exceeds the safe integer range.",
);

const detailsSchema = z.object({
  items: z.array(z.object({
    id: youtubeVideoIdSchema,
    snippet: z.object({
      title: z.string().trim().min(1),
      channelTitle: z.string().trim().min(1),
      publishedAt: z.string().trim().min(1),
      thumbnails: z.object({
        medium: z.object({ url: z.string().url() }).optional(),
      }).optional(),
    }),
    contentDetails: z.object({ duration: z.string() }),
    statistics: z.object({
      viewCount: countSchema.optional(),
      likeCount: countSchema.optional(),
      commentCount: countSchema.optional(),
    }).optional(),
  })),
});

/** Parse a YouTube ISO 8601 duration, rejecting malformed values. */
function durationToSeconds(duration: string): number {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(duration);
  if (!match || !match.slice(1).some((part) => part !== undefined) || duration.endsWith("T")) {
    throw new YouTubeError("YouTube returned an invalid video duration.");
  }
  const seconds =
    Number(match[1] ?? 0) * 86_400 +
    Number(match[2] ?? 0) * 3_600 +
    Number(match[3] ?? 0) * 60 +
    Number(match[4] ?? 0);
  if (!Number.isFinite(seconds)) {
    throw new YouTubeError("YouTube returned an invalid video duration.");
  }
  return seconds;
}

/** Fetch and validate one YouTube API response without exposing credentials. */
async function requestYouTube<T>(
  endpoint: string,
  params: URLSearchParams,
  apiKey: string,
  schema: z.ZodType<T>,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${YOUTUBE.API_BASE}${endpoint}?${params}`, {
      headers: { "x-goog-api-key": apiKey },
      signal: AbortSignal.any([signal, AbortSignal.timeout(YOUTUBE.REQUEST_TIMEOUT_MS)]),
    });
  } catch {
    if (signal.aborted) {
      throw new YouTubeError("YouTube request was cancelled.");
    }
    throw new YouTubeError(`YouTube ${endpoint} request failed or timed out. Check network connectivity.`);
  }
  if (!response.ok) {
    throw new YouTubeError(`YouTube ${endpoint} request failed with HTTP ${response.status}.`);
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new YouTubeError(`YouTube ${endpoint} returned invalid JSON or the response was interrupted.`);
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new YouTubeError(`YouTube ${endpoint} returned an invalid response.`);
  }
  return result.data;
}

/** Search videos, retrieve their statistics, and rank candidates by view count. */
export async function searchYouTubeVideos(
  query: string,
  maxResults: number,
  apiKey: string | undefined,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
  duration: "short" | "any" = "short",
) {
  if (!apiKey) {
    throw new YouTubeError("YOUTUBE_API_KEY is required to search YouTube.");
  }

  const searchParams = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    order: "viewCount",
    maxResults: String(maxResults),
  });
  if (duration === "short") {
    searchParams.set("videoDuration", "short");
  }
  const search = await requestYouTube("search", searchParams, apiKey, searchSchema, signal, fetchImpl);
  const videoIds = search.items.map((item) => item.id.videoId);
  if (videoIds.length === 0) {
    return { query, results: [] };
  }

  const details = await requestYouTube("videos", new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    id: videoIds.join(","),
  }), apiKey, detailsSchema, signal, fetchImpl);

  const searchedIds = new Set(videoIds);
  if (details.items.some((video) => !searchedIds.has(video.id))) {
    throw new YouTubeError("YouTube returned video details for an unrequested ID.");
  }
  const candidates = details.items.map((video) => ({
    videoId: video.id,
    title: video.snippet.title,
    channel: video.snippet.channelTitle,
    publishedAt: video.snippet.publishedAt,
    durationSeconds: durationToSeconds(video.contentDetails.duration),
    views: video.statistics?.viewCount === undefined ? null : Number(video.statistics.viewCount),
    likes: video.statistics?.likeCount === undefined ? null : Number(video.statistics.likeCount),
    comments: video.statistics?.commentCount === undefined ? null : Number(video.statistics.commentCount),
    url: youtubeWatchUrl(video.id),
    thumbnail: video.snippet.thumbnails?.medium?.url ?? null,
  })).filter((video) =>
    duration === "any" || video.durationSeconds <= YOUTUBE.MAX_CANDIDATE_DURATION_SECONDS);

  candidates.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  return { query, totalCandidates: candidates.length, results: candidates.slice(0, YOUTUBE.MAX_RETURNED_RESULTS) };
}
