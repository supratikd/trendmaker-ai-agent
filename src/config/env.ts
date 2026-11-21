import "dotenv/config";

const apiKey = process.env.GEMINI_API_KEY?.trim();

if (!apiKey) {
  throw new Error(
    "GEMINI_API_KEY is required. Copy .env.example to .env and add your API key.",
  );
}

export const env = {
  GEMINI_API_KEY: apiKey,
  GEMINI_MODEL:
    process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite",
};
