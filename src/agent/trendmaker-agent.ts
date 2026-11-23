
import { GoogleGenAI, mcpToTool } from "@google/genai";

import { env } from "../config/env.js";
import { createYouTubeDiscoveryPrompt } from "../prompts/research.js";
import { analyzeUserRequest } from "../services/context-analyzer.js";
import { withTrendmakerMcpClient } from "../mcp/trendmaker-mcp-client.js";

const ai = new GoogleGenAI({
  apiKey: env.GEMINI_API_KEY,
});

export async function runTrendmakerAgent(
  userRequest: string,
): Promise<string> {
  const context = await analyzeUserRequest(userRequest);

  return withTrendmakerMcpClient({
    args: ["--import", "tsx", "src/mcp/youtube/youtube-mcp-server.ts"],
  }, async (mcpClient) => {
    // Discover the tools exposed by our MCP server.
    const { tools } = await mcpClient.listTools();

    console.log(
      "MCP tools discovered:",
      tools.map((tool) => tool.name),
    );

    // Give Gemini access to the MCP tools.
    const response = await ai.models.generateContent({
      model: env.GEMINI_MODEL,

      contents: createYouTubeDiscoveryPrompt(userRequest, context),

      config: {
        tools: [mcpToTool(mcpClient)],
      },
    });

    if (!response.text) {
      throw new Error("Gemini returned an empty YouTube discovery response.");
    }
    return response.text;

  });
}
