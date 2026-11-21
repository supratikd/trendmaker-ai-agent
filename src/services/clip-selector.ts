import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { env } from "../config/env.js";
import { YOUTUBE } from "../config/constants.js";
import { youtubeCandidateSchema } from "../mcp/youtube-client.js";
import type { YouTubeCandidate } from "../mcp/youtube-client.js";
import { createClipSelectionPrompt } from "../prompts/research.js";
import type { UserContext } from "./context-analyzer.js";
import { parseStructuredJson, validateStructuredData } from "./structured-json.js";

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

const modelSelectionSchema = z.object({
  title: z.string().trim().min(1),
  clips: z.array(z.object({
    order: z.number().int().positive(),
    videoId: z.string().min(1),
    reason: z.string().trim().min(1),
  })).min(1),
});

export interface SelectedClip {
  order: number;
  videoId: string;
  license: "creativeCommon";
  title: string;
  url: string;
  durationSeconds: number;
  reason: string;
}

export interface HighlightSelection {
  title: string;
  clips: SelectedClip[];
}

export async function selectHighlights(
  context: UserContext,
  videos: YouTubeCandidate[],
): Promise<HighlightSelection> {
  const candidates = validateStructuredData(
    videos, z.array(youtubeCandidateSchema).min(1), "YouTube candidates",
  );
  const videoMap = new Map(candidates.map((video) => [video.videoId, video]));
  if (videoMap.size !== candidates.length) {
    throw new Error("YouTube search results contain duplicate video IDs.");
  }

  const response = await ai.models.generateContent({
    model: env.GEMINI_MODEL,
    contents: createClipSelectionPrompt(context, candidates),
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          clips: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                order: { type: "INTEGER" },
                videoId: { type: "STRING" },
                reason: { type: "STRING" },
              },
              required: ["order", "videoId", "reason"],
            },
          },
        },
        required: ["title", "clips"],
      },
    },
  });

  if (!response.text) {
    throw new Error("Gemini returned an empty highlight selection.");
  }
  const selection = parseStructuredJson(response.text, modelSelectionSchema, "Clip selector");
  const selectedIds = new Set<string>();
  const clips = selection.clips.map((clip, index) => {
    if (clip.order !== index + 1) {
      throw new Error("Selected clips must be numbered sequentially starting at 1.");
    }
    const source = videoMap.get(clip.videoId);
    if (!source) {
      throw new Error(`Unknown source video: ${clip.videoId}`);
    }
    if (selectedIds.has(clip.videoId)) {
      throw new Error(`Video selected more than once: ${clip.videoId}`);
    }
    selectedIds.add(clip.videoId);
    return {
      ...clip,
      license: source.license,
      title: source.title,
      url: source.url,
      durationSeconds: source.durationSeconds,
    };
  });

  const minimum = Math.min(YOUTUBE.MIN_SELECTED_SHORTS, candidates.length);
  const maximum = Math.min(YOUTUBE.MAX_SELECTED_SHORTS, candidates.length);
  if (clips.length < minimum || clips.length > maximum) {
    throw new Error(`Clip selector must select between ${minimum} and ${maximum} distinct candidates; selected ${clips.length}.`);
  }

  return { title: selection.title, clips };
}
