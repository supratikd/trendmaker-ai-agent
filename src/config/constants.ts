export const APPLICATION = {
  MCP_SERVER_VERSION: "1.0.0",
} as const;

export const YOUTUBE = {
  MCP_SERVER_NAME: "youtube-discovery-server",
  API_BASE: "https://www.googleapis.com/youtube/v3/",
  REQUEST_TIMEOUT_MS: 15_000,
  MAX_SEARCH_RESULTS: 50,
  MAX_CANDIDATE_DURATION_SECONDS: 180,
  MAX_RETURNED_RESULTS: 10,
} as const;
