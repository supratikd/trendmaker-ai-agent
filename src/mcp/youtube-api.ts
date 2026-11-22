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
      description: z.string().optional(),
      tags: z.array(z.string().trim().min(1)).optional(),
      categoryId: z.string().trim().min(1).optional(),
      thumbnails: z.object({
        medium: z.object({ url: z.string().url() }).optional(),
      }).optional(),
    }),
    contentDetails: z.object({ duration: z.string() }),
    status: z.object({
      license: z.enum(["youtube", "creativeCommon"]).optional(),
    }).optional(),
    statistics: z.object({
      viewCount: countSchema.optional(),
      likeCount: countSchema.optional(),
      commentCount: countSchema.optional(),
    }).optional(),
  })),
});

const apiErrorSchema = z.object({
  error: z.object({
    message: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

const exhaustedQuotaReasons = new Set([
  "dailyLimitExceeded",
  "dailyLimitExceededUnreg",
  "quotaExceeded",
]);

const retryableRateLimitReasons = new Set([
  "rateLimitExceeded",
  "userRateLimitExceeded",
]);

interface ApiErrorDetails {
  reason?: string;
  message?: string;
}

async function getApiErrorDetails(response: Response): Promise<ApiErrorDetails> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {};
  }
  const parsed = apiErrorSchema.safeParse(body);
  if (!parsed.success) return {};
  return {
    reason: parsed.data.error.errors?.find((item) => item.reason)?.reason,
    message: parsed.data.error.message,
  };
}

function isQuotaExhaustion(reason: string | undefined): boolean {
  return reason !== undefined && exhaustedQuotaReasons.has(reason);
}

function isRetryableRateLimit(status: number, reason: string | undefined): boolean {
  return status === 429 || (reason !== undefined && retryableRateLimitReasons.has(reason));
}

function formatHttpError(endpoint: string, status: number, details: ApiErrorDetails): YouTubeError {
  if (isQuotaExhaustion(details.reason)) {
    return new YouTubeError(
      `YouTube API quota is exhausted (${details.reason}). Wait for the Google Cloud quota reset ` +
      "or request additional quota for the project that owns YOUTUBE_API_KEY.",
    );
  }
  const reason = details.reason ? ` (${details.reason})` : "";
  const message = details.message ? `: ${details.message}` : "";
  return new YouTubeError(
    `YouTube ${endpoint} request failed with HTTP ${status}${reason}${message}.`,
  );
}

function retryDelayMs(retryAfter: string | null, retryNumber: number): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const retryAt = Date.parse(retryAfter);
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
  }
  return YOUTUBE.RETRY_BASE_DELAY_MS * (2 ** retryNumber);
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(new YouTubeError("YouTube request was cancelled."));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, delayMs);
    const cancel = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
      reject(new YouTubeError("YouTube request was cancelled."));
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

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
  let retries = 0;
  while (true) {
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
      const details = await getApiErrorDetails(response);
      if (isQuotaExhaustion(details.reason)) {
        throw formatHttpError(endpoint, response.status, details);
      }
      if (isRetryableRateLimit(response.status, details.reason) &&
          retries < YOUTUBE.MAX_REQUEST_RETRIES) {
        const delay = retryDelayMs(response.headers.get("retry-after"), retries);
        if (delay <= YOUTUBE.MAX_RETRY_DELAY_MS) {
          await waitForRetry(delay, signal);
          retries++;
          continue;
        }
        throw new YouTubeError(
          `${formatHttpError(endpoint, response.status, details).message} ` +
          `The server requested a retry after ${Math.ceil(delay / 1_000)} seconds; rerun later.`,
        );
      }
      throw formatHttpError(endpoint, response.status, details);
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
}

/** Search videos, retrieve their statistics, and rank candidates by view count. */
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

  const searchParams = new URLSearchParams({
    part: "snippet",
    q: query,
    type: "video",
    order: "viewCount",
    maxResults: String(maxResults),
  });
  searchParams.set("videoDuration", "short");
  searchParams.set("videoLicense", "creativeCommon");
  const search = await requestYouTube("search", searchParams, apiKey, searchSchema, signal, fetchImpl);
  const videoIds = search.items.map((item) => item.id.videoId);
  if (videoIds.length === 0) {
    return { query, results: [] };
  }

  const details = await requestYouTube("videos", new URLSearchParams({
    part: "snippet,statistics,contentDetails,status",
    id: videoIds.join(","),
  }), apiKey, detailsSchema, signal, fetchImpl);

  const searchedIds = new Set(videoIds);
  if (details.items.some((video) => !searchedIds.has(video.id))) {
    throw new YouTubeError("YouTube returned video details for an unrequested ID.");
  }
  const eligible = details.items.filter((video) => {
    const seconds = durationToSeconds(video.contentDetails.duration);
    return video.status?.license === "creativeCommon" &&
      seconds > 0 && seconds <= YOUTUBE.MAX_CANDIDATE_DURATION_SECONDS;
  });
  const candidates = eligible.map((video) => ({
    videoId: video.id,
    license: "creativeCommon" as const,
    title: video.snippet.title,
    channel: video.snippet.channelTitle,
    publishedAt: video.snippet.publishedAt,
    description: video.snippet.description?.trim() || null,
    tags: video.snippet.tags?.slice(0, 20) ?? [],
    categoryId: video.snippet.categoryId ?? null,
    durationSeconds: durationToSeconds(video.contentDetails.duration),
    views: video.statistics?.viewCount === undefined ? null : Number(video.statistics.viewCount),
    likes: video.statistics?.likeCount === undefined ? null : Number(video.statistics.likeCount),
    comments: video.statistics?.commentCount === undefined ? null : Number(video.statistics.commentCount),
    url: youtubeWatchUrl(video.id),
    thumbnail: video.snippet.thumbnails?.medium?.url ?? null,
  }));

  candidates.sort((a, b) => (b.views ?? -1) - (a.views ?? -1));
  return { query, totalCandidates: candidates.length, results: candidates.slice(0, YOUTUBE.MAX_RETURNED_RESULTS) };
}

export async function verifyYouTubeShortsForReuse(
  videoIds: string[],
  apiKey: string | undefined,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  if (!apiKey) throw new YouTubeError("YOUTUBE_API_KEY is required to verify source video durations.");
  const ids = [...new Set(z.array(youtubeVideoIdSchema).parse(videoIds))];
  for (let offset = 0; offset < ids.length; offset += YOUTUBE.MAX_SEARCH_RESULTS) {
    const batch = ids.slice(offset, offset + YOUTUBE.MAX_SEARCH_RESULTS);
    const details = await requestYouTube("videos", new URLSearchParams({
      part: "snippet,statistics,contentDetails,status",
      id: batch.join(","),
    }), apiKey, detailsSchema, signal, fetchImpl);
    const videos = new Map(details.items.map((video) => [video.id, video]));
    if (videos.size !== details.items.length || details.items.some((video) => !batch.includes(video.id))) {
      throw new YouTubeError("YouTube returned unexpected video details during Shorts verification.");
    }
    for (const id of batch) {
      const video = videos.get(id);
      if (!video) throw new YouTubeError(`Cannot verify YouTube Short ${id}: video details unavailable.`);
      if (video.status?.license !== "creativeCommon") {
        throw new YouTubeError(
          `Video ${id} is not marked Creative Commons by YouTube and cannot be selected for reuse.`,
        );
      }
      const duration = durationToSeconds(video.contentDetails.duration);
      if (duration <= 0 || duration > YOUTUBE.MAX_CANDIDATE_DURATION_SECONDS) {
        throw new YouTubeError(`Video ${id} is not within the 3-minute Shorts duration limit.`);
      }
    }
  }
}
