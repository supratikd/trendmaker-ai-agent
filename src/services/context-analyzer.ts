
import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { env } from "../config/env.js";
import { createContextAnalyzerPrompt } from "../prompts/research.js";
import { parseStructuredJson } from "./structured-json.js";
import { YOUTUBE } from "../config/constants.js";

const ai = new GoogleGenAI({
  apiKey: env.GEMINI_API_KEY,
});

const userContextSchema = z.object({
  topic: z.string().trim().min(1),
  intent: z.enum(["video_discovery", "video_creation", "research", "comparison"]),
  platform: z.string().trim().min(1),
  targetDuration: z.number().int().positive().nullable(),
  targetAudience: z.string().trim().min(1).nullable(),
  contentStyle: z.string().trim().min(1).nullable(),
  researchRequired: z.boolean(),
  uploadRequested: z.boolean(),
  actions: z.array(z.string().trim().min(1)).min(1),
});

export type UserContext = z.infer<typeof userContextSchema>;

export async function analyzeUserRequest(
  userRequest: string,
): Promise<UserContext> {
  if (!userRequest.trim()) {
    throw new Error("User request must not be blank.");
  }

  const response = await ai.models.generateContent({
    model: env.GEMINI_MODEL,

    contents: createContextAnalyzerPrompt(userRequest),

    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          topic: { type: "STRING" },
          intent: {
            type: "STRING",
            enum: [
              "video_discovery",
              "video_creation",
              "research",
              "comparison",
            ],
          },
          platform: { type: "STRING" },
          targetDuration: {
            type: "INTEGER",
            nullable: true,
          },
          targetAudience: {
            type: "STRING",
            nullable: true,
          },
          contentStyle: {
            type: "STRING",
            nullable: true,
          },
          researchRequired: { type: "BOOLEAN" },
          uploadRequested: { type: "BOOLEAN" },
          actions: {
            type: "ARRAY",
            items: { type: "STRING" },
          },
        },
        required: [
          "topic",
          "intent",
          "platform",
          "targetDuration",
          "targetAudience",
          "contentStyle",
          "researchRequired",
          "uploadRequested",
          "actions",
        ],
      },
    },
  });

  if (!response.text) {
    throw new Error("Context analyzer returned an empty response.");
  }

  const context = parseStructuredJson(response.text, userContextSchema, "Context analyzer");
  if (context.targetDuration !== null && context.targetDuration > YOUTUBE.MAX_CANDIDATE_DURATION_SECONDS) {
    throw new Error("YouTube Shorts must be no longer than 180 seconds.");
  }
  return { ...context, platform: "YouTube Shorts" };
}
