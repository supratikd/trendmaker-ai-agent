import { z } from "zod";
import { YOUTUBE } from "../config/constants.js";

export class YouTubeError extends Error {}

const searchSchema = z.object({
  items: z.array(z.object({ id: z.object({ videoId: z.string().min(1) }) })),
});

const countSchema = z.string().regex(/^\d+$/).refine(
  (value) => Number.isSafeInteger(Number(value)),
  "Count exceeds the safe integer range.",
);

const detailsSchema = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    snippet: z.object({
      title: z.string(),
      channelTitle: z.string(),
      publishedAt: z.string(),
      thumbnails: z.object({
        medium: z.object({ url: z.string() }).optional(),
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

/** Search videos, retrieve their statistics, and rank candidates up to three minutes long. */
export async function searchYouTubeVideos(
  query: string,
  maxResults: number,
  apiKey: string | undefined,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
) {
  if (!apiKey) {
    throw new YouTubeError("YOUTUBE_API_KEY is required to search YouTube.");
  }

  const search = await requestYouTube("search", new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    order: "viewCount",
    videoDuration: "short",
    maxResults: String(maxResults),
  }), apiKey, searchSchema, signal, fetchImpl);
  const videoIds = search.items.map((item) => item.id.videoId);
  if (videoIds.length === 0) {
    return { query, results: [] };
  }

  const details = await requestYouTube("videos", new URLSearchParams({
    part: "snippet,statistics,contentDetails",
    id: videoIds.join(","),
  }), apiKey, detailsSchema, signal, fetchImpl);

  const candidates = details.items.map((video) => ({
    videoId: video.id,
    title: video.snippet.title,
    channel: video.snippet.channelTitle,
    publishedAt: video.snippet.publishedAt,
    durationSeconds: durationToSeconds(video.contentDetails.duration),
    views: Number(video.statistics?.viewCount ?? 0),
    likes: Number(video.statistics?.likeCount ?? 0),
    comments: Number(video.statistics?.commentCount ?? 0),
    url: `https://www.youtube.com/watch?v=${video.id}`,
    thumbnail: video.snippet.thumbnails?.medium?.url,
  })).filter((video) => video.durationSeconds <= YOUTUBE.MAX_CANDIDATE_DURATION_SECONDS);

  candidates.sort((a, b) => b.views - a.views);
  return { query, totalCandidates: candidates.length, results: candidates.slice(0, YOUTUBE.MAX_RETURNED_RESULTS) };
}
