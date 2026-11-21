import { searchYouTubeCandidates } from "../mcp/youtube-client.js";
import { selectHighlights } from "./clip-selector.js";
import { analyzeUserRequest } from "./context-analyzer.js";
import { generateVideoProductionPlan } from "./video-production-planner.js";

export async function createVideoWorkflow(userRequest: string) {
  const context = await analyzeUserRequest(userRequest);
  const candidates = await searchYouTubeCandidates(context);
  if (candidates.length === 0) {
    throw new Error(
      `YouTube search returned no video candidates for "${context.topic}". ` +
      "Try a broader topic or check whether matching videos are available.",
    );
  }
  const selection = await selectHighlights(context, candidates);
  const plan = await generateVideoProductionPlan(context, selection.clips);
  return { context, candidates, selection, plan };
}
