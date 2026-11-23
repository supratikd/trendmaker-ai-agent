import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface StdioMcpServerConnection {
  args: string[];
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
  clientName?: string;
}

export const TRENDMAKER_MCP_CLIENT_NAME = "trendmaker-mcp-client";
export const APPLICATION_MCP_CLIENT_VERSION = "1.0.0";

export async function connectTrendmakerMcpClient(
  server: StdioMcpServerConnection,
): Promise<Client> {
  const client = new Client({
    name: server.clientName ?? TRENDMAKER_MCP_CLIENT_NAME,
    version: APPLICATION_MCP_CLIENT_VERSION,
  });
  const transport = new StdioClientTransport({
    command: server.command ?? process.execPath,
    args: server.args,
    cwd: server.cwd ?? process.cwd(),
    env: server.env,
  });

  await client.connect(transport);
  return client;
}

export async function withTrendmakerMcpClient<T>(
  server: StdioMcpServerConnection,
  operation: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await connectTrendmakerMcpClient(server);
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}
