import { createVideoWorkflow } from "../services/video-workflow.js";
import { exampleRequest } from "./example-request.js";

async function main(): Promise<void> {
  const request = process.argv.slice(2).join(" ").trim() || exampleRequest;
  const result = await createVideoWorkflow(request);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error("Failed to create video production plan:", error);
  process.exitCode = 1;
});
