
import { analyzeUserRequest } from "../services/context-analyzer.js";
import { generateVideoProductionPlan } from "../services/video-production-planner.js";
import { exampleRequest } from "./example-request.js";

async function main() {

  const userRequest = process.argv.slice(2).join(" ").trim() ||
    exampleRequest;

  // Step 1: Understand the user's request
  console.log("\n1. ANALYZING USER REQUEST...\n");

  const context = await analyzeUserRequest(userRequest);

  console.log(JSON.stringify(context, null, 2));

  // Step 2: Generate the production plan
  console.log("\n2. GENERATING VIDEO PRODUCTION PLAN...\n");

  const plan = await generateVideoProductionPlan(context);

  // Step 3: Display the result
  console.log("\n========== VIDEO PRODUCTION PLAN ==========\n");

  console.log(JSON.stringify(plan, null, 2));

  // Step 4: Display scene timeline
  console.log("\n========== SCENE TIMELINE ==========\n");

  for (const scene of plan.scenes) {
    console.log(
      `Scene ${scene.sceneNumber}: ${scene.sceneTitle} ` +
      `(${scene.durationSeconds} seconds)`
    );
  }

  console.log(
    "\nTotal duration:",
    plan.scenes.reduce(
      (total, scene) => total + scene.durationSeconds,
      0,
    ),
    "seconds",
  );
}

main().catch(console.error);
