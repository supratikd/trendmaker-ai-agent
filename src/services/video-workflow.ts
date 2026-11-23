import { searchYouTubeCandidates } from "../mcp/youtube/youtube-mcp-client.js";
import { YOUTUBE } from "../config/constants.js";
import { selectHighlights } from "./clip-selector.js";
import { analyzeUserRequest } from "./context-analyzer.js";
import type { UserContext } from "./context-analyzer.js";
import { generateVideoProductionPlan } from "./video-production-planner.js";

export async function createVideoWorkflow(
  userRequest: string,
  existingContext?: UserContext,
) {
  console.log("[WORKFLOW 1/4] Analyzing the request with Gemini...");
  const context = existingContext ?? await analyzeUserRequest(userRequest);
  console.log(`[WORKFLOW 1/4] Request analyzed. Topic: "${context.topic}"`);

  console.log("[WORKFLOW 2/4] Connecting to MCP and searching YouTube...");
  const candidates = await searchYouTubeCandidates(context);
  if (candidates.length === 0) {
    throw new Error(
      `YouTube search returned no video candidates for "${context.topic}". ` +
      "Try a broader topic or check whether matching Shorts are available and verifiable.",
    );
  }
  console.log(`[WORKFLOW 2/4] MCP search complete. Candidates found: ${candidates.length}`);

  console.log("[WORKFLOW 3/4] Selecting the best clips with Gemini...");
  const selection = await selectHighlights(context, candidates);
  console.log(`[WORKFLOW 3/4] Clip selection complete. Selected: ${selection.clips.length}`);

  console.log("[WORKFLOW 4/4] Building the production plan with Gemini...");
  const warnings = selection.clips.length < YOUTUBE.MIN_SELECTED_SHORTS
    ? [`Only ${selection.clips.length} Shorts-length candidate(s) available; the target is ${YOUTUBE.MIN_SELECTED_SHORTS}–${YOUTUBE.MAX_SELECTED_SHORTS}.`]
    : [];
  const plan = await generateVideoProductionPlan(context, selection.clips);
  console.log("[WORKFLOW 4/4] Production plan complete.");
  return { context, candidates, selection, plan, warnings };
}
