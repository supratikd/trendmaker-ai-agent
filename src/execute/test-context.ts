
import { analyzeUserRequest } from "../services/context-analyzer.js";
import { exampleRequest } from "./example-request.js";

async function main() {
  const request = process.argv.slice(2).join(" ").trim() ||
    exampleRequest;

  const context = await analyzeUserRequest(request);

  console.log("\n===== ANALYZED USER CONTEXT =====\n");

  console.log(JSON.stringify(context, null, 2));
}

main().catch((error: unknown) => {
  console.error("Failed to analyze user request:", error);
  process.exitCode = 1;
});
