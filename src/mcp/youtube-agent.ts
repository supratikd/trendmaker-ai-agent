
import { GoogleGenAI, mcpToTool } from "@google/genai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { env } from "../config/env.js";
import { createYouTubeDiscoveryPrompt } from "../prompts/research.js";

const ai = new GoogleGenAI({
  apiKey: env.GEMINI_API_KEY,
});

export async function discoverYouTubeVideos(
  userRequest: string,
): Promise<string> {

  const mcpClient = new Client({
    name: "trendmaker-agent",
    version: "1.0.0",
  });

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "src/mcp/youtube-server.ts"],
    cwd: process.cwd(),
  });

  await mcpClient.connect(transport);

  try {
    // Discover the tools exposed by our MCP server.
    const { tools } = await mcpClient.listTools();

    console.log(
      "MCP tools discovered:",
      tools.map((tool) => tool.name),
    );

    // Give Gemini access to the MCP tools.
    const response = await ai.models.generateContent({
      model: env.GEMINI_MODEL,

      contents: createYouTubeDiscoveryPrompt(userRequest),

      config: {
        tools: [mcpToTool(mcpClient)],
      },
    });

    return response.text ?? "Gemini returned an empty response.";

  } finally {
    await mcpClient.close();
  }
}
