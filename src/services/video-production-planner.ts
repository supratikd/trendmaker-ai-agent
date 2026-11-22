
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { env } from "../config/env.js";
import { createVideoProductionPrompt } from "../prompts/research.js";
import type { SelectedClip } from "./clip-selector.js";
import type { UserContext } from "./context-analyzer.js";
import { parseStructuredJson } from "./structured-json.js";
import { YOUTUBE } from "../config/constants.js";
import { allocateSceneSourceDurations } from "./scene-source-allocation.js";

const ai = new GoogleGenAI({
  apiKey: env.GEMINI_API_KEY,
});

export interface VideoScene {
  sceneNumber: number;
  sceneTitle: string;
  durationSeconds: number;
  purpose: string;
  visualDirection: string;
  narration: string;
  onScreenText: string[];
  assetRequirements: string[];
  audioDirection: string;
  sourceVideoIds: string[];
}

export interface VideoProductionPlan {
  videoTitle: string;
  videoDescription: string;
  targetAudience: string;
  videoDurationSeconds: number;
  aspectRatio: string;
  visualStyle: string;
  scenes: VideoScene[];
  musicDirection: string;
  productionNotes: string[];
}

const sceneSchema = z.object({
  sceneNumber: z.number().int().positive(),
  sceneTitle: z.string().trim().min(1),
  durationSeconds: z.number().int().positive(),
  purpose: z.string().trim().min(1),
  visualDirection: z.string().trim().min(1),
  narration: z.string().trim().min(1),
  onScreenText: z.array(z.string().trim().min(1)).min(1),
  assetRequirements: z.array(z.string().trim().min(1)).min(1),
  audioDirection: z.string().trim().min(1),
  sourceVideoIds: z.array(z.string().trim().min(1)),
}) satisfies z.ZodType<VideoScene>;

const productionPlanSchema = z.object({
  videoTitle: z.string().trim().min(1),
  videoDescription: z.string().trim().min(1),
  targetAudience: z.string().trim().min(1),
  videoDurationSeconds: z.number().int().positive(),
  aspectRatio: z.string().regex(/^[1-9]\d*:[1-9]\d*$/, "Expected a positive ratio such as 9:16."),
  visualStyle: z.string().trim().min(1),
  scenes: z.array(sceneSchema).min(1),
  musicDirection: z.string().trim().min(1),
  productionNotes: z.array(z.string().trim().min(1)).min(1),
}) satisfies z.ZodType<VideoProductionPlan>;

export async function generateVideoProductionPlan(
  context: UserContext,
  sources: readonly SelectedClip[] = [],
): Promise<VideoProductionPlan> {
  if (context.targetDuration !== null &&
      (!Number.isSafeInteger(context.targetDuration) || context.targetDuration <= 0 ||
       context.targetDuration > YOUTUBE.MAX_CANDIDATE_DURATION_SECONDS)) {
    throw new Error("Target duration must be a positive integer no greater than 180 seconds.");
  }
  if (sources.some((source) => !Number.isSafeInteger(source.durationSeconds) ||
      source.durationSeconds <= 0 || source.durationSeconds > YOUTUBE.MAX_CANDIDATE_DURATION_SECONDS)) {
    throw new Error("Source videos must be within the 3-minute Shorts duration limit.");
  }

  const response = await ai.models.generateContent({
    model: env.GEMINI_MODEL,

    contents: createVideoProductionPrompt(context, sources),

    config: {
      responseMimeType: "application/json",

      responseSchema: {
        type: "OBJECT",
        properties: {
          videoTitle: { type: "STRING" },
          videoDescription: { type: "STRING" },
          targetAudience: { type: "STRING" },
          videoDurationSeconds: { type: "INTEGER" },
          aspectRatio: { type: "STRING" },
          visualStyle: { type: "STRING" },

          scenes: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                sceneNumber: { type: "INTEGER" },
                sceneTitle: { type: "STRING" },
                durationSeconds: { type: "INTEGER" },
                purpose: { type: "STRING" },
                visualDirection: { type: "STRING" },
                narration: { type: "STRING" },
                onScreenText: {
                  type: "ARRAY",
                  items: { type: "STRING" },
                },
                assetRequirements: {
                  type: "ARRAY",
                  items: { type: "STRING" },
                },
                audioDirection: { type: "STRING" },
                sourceVideoIds: {
                  type: "ARRAY",
                  items: { type: "STRING" },
                },
              },
              required: [
                "sceneNumber",
                "sceneTitle",
                "durationSeconds",
                "purpose",
                "visualDirection",
                "narration",
                "onScreenText",
                "assetRequirements",
                "audioDirection",
                "sourceVideoIds",
              ],
            },
          },

          musicDirection: { type: "STRING" },

          productionNotes: {
            type: "ARRAY",
            items: { type: "STRING" },
          },
        },

        required: [
          "videoTitle",
          "videoDescription",
          "targetAudience",
          "videoDurationSeconds",
          "aspectRatio",
          "visualStyle",
          "scenes",
          "musicDirection",
          "productionNotes",
        ],
      },
    },
  });

  if (!response.text) {
    throw new Error("Gemini returned an empty production plan.");
  }

  const plan = parseStructuredJson(response.text, productionPlanSchema, "Production planner");

  if (plan.aspectRatio !== "9:16") {
    throw new Error("YouTube Shorts plans must use the 9:16 aspect ratio.");
  }
  if (plan.videoDurationSeconds > YOUTUBE.MAX_CANDIDATE_DURATION_SECONDS) {
    throw new Error("YouTube Shorts plans must be no longer than 180 seconds.");
  }

  const sourceIds = new Set(sources.map((source) => source.videoId));
  const sourceById = new Map(sources.map((source) => [source.videoId, source]));
  const referencedSources = new Set<string>();
  let adjustedDuration = false;
  for (const scene of plan.scenes) {
    const sceneSourceIds = scene.sourceVideoIds;
    if (new Set(sceneSourceIds).size !== sceneSourceIds.length) {
      throw new Error(`Scene ${scene.sceneNumber} contains duplicate source video IDs.`);
    }
    if (sources.length > 0 && sceneSourceIds.length === 0) {
      throw new Error(`Scene ${scene.sceneNumber} must reference at least one selected source video.`);
    }
    if (sceneSourceIds.length === 0) continue;
    const sceneSources: SelectedClip[] = [];
    for (const videoId of sceneSourceIds) {
      const source = sourceById.get(videoId);
      if (!sourceIds.has(videoId) || !source) {
        throw new Error(`Scene ${scene.sceneNumber} references unknown source video: ${videoId}`);
      }
      sceneSources.push(source);
    }

    let availableDuration = sceneSources.reduce(
      (total, source) => total + source.durationSeconds,
      0,
    );
    if (availableDuration < scene.durationSeconds) {
      const originalSourceCount = sceneSourceIds.length;
      for (const source of sources) {
        if (sceneSourceIds.length >= scene.durationSeconds ||
            sceneSourceIds.includes(source.videoId)) {
          continue;
        }
        sceneSourceIds.push(source.videoId);
        sceneSources.push(source);
        availableDuration += source.durationSeconds;
        if (availableDuration >= scene.durationSeconds) break;
      }
      if (sceneSourceIds.length > originalSourceCount) {
        plan.productionNotes.push(
          `Scene ${scene.sceneNumber} was supplemented with additional selected clips ` +
          `to cover its planned duration.`,
        );
      }
    }

    if (availableDuration < scene.durationSeconds && context.targetDuration === null) {
      scene.durationSeconds = availableDuration;
      adjustedDuration = true;
      plan.productionNotes.push(
        `Scene ${scene.sceneNumber} was shortened to ${availableDuration}s to fit its ` +
        `available selected footage.`,
      );
    }

    for (const videoId of sceneSourceIds) referencedSources.add(videoId);
    allocateSceneSourceDurations(scene.sceneNumber, scene.durationSeconds, sceneSources);
  }

  if (adjustedDuration) {
    plan.videoDurationSeconds = plan.scenes.reduce(
      (total, scene) => total + scene.durationSeconds,
      0,
    );
  }

  if (sources.length > 0) {
    const unusedSource = sources.find((source) => !referencedSources.has(source.videoId));
    if (unusedSource) {
      throw new Error(`Production plan does not use selected source video: ${unusedSource.videoId}`);
    }
  }

  const totalSceneDuration = plan.scenes.reduce(
    (total, scene) => total + scene.durationSeconds,
    0,
  );

  if (!Number.isSafeInteger(totalSceneDuration)) {
    throw new Error("Total scene duration exceeds the safe integer range.");
  }
  if (plan.scenes.some((scene, index) => scene.sceneNumber !== index + 1)) {
    throw new Error("Production plan scenes must be numbered sequentially starting at 1.");
  }
  if (totalSceneDuration !== plan.videoDurationSeconds) {
    throw new Error(
      `Scene duration mismatch. Plan specifies ${plan.videoDurationSeconds}s, ` +
      `but scenes total ${totalSceneDuration}s.`,
    );
  }
  if (context.targetDuration !== null &&
      plan.videoDurationSeconds !== context.targetDuration) {
    throw new Error(
      `Target duration mismatch. Expected ${context.targetDuration}s, ` +
      `received ${plan.videoDurationSeconds}s.`,
    );
  }

  return plan;
}
