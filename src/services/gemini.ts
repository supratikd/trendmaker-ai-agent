import { GoogleGenAI } from "@google/genai";
import { env } from "../config/env.js";
import { createResearchPrompt } from "../prompts/research.js";

const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

export async function generateResearchSuggestions(
  topic: string,
): Promise<string> {
  const response = await ai.models.generateContent({
    model: env.GEMINI_MODEL,
    contents: createResearchPrompt(topic),
  });

  if (!response.text) {
    throw new Error("Gemini returned an empty response.");
  }

  return response.text;
}
