import { generateResearchSuggestions } from "./services/gemini.js";

const defaultTopic = "Find the most viewed MEME YouTube Shorts about Jensen Huang";

async function main(): Promise<void> {
  const topic = process.argv.slice(2).join(" ").trim() || defaultTopic;
  const suggestions = await generateResearchSuggestions(topic);

  console.log(`\nGemini research suggestions for "${topic}":\n`);
  console.log(suggestions);
}

main().catch((error: unknown) => {
  console.error("Failed to generate research suggestions:", error);
  process.exitCode = 1;
});
