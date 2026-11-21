# trendmaker-ai-agent

A small TypeScript command-line prototype that uses the Gemini API to suggest
ways to research YouTube videos for a topic.

> **Scope:** The Gemini CLI generates research suggestions only; it does not
> verify live statistics. The separate YouTube MCP server searches YouTube and
> retrieves video metadata and statistics.

## Features

- Uses Google's Gemini Developer API through the official `@google/genai` SDK.
- Defaults to `gemini-3.5-flash-lite`, a cost-efficient text model. The model can
  be changed with `GEMINI_MODEL`.
- Accepts a research topic as a command-line argument.
- Validates required environment configuration before making an API request.
- Keeps API keys in a local environment file, which is excluded from Git.
- Provides a separate stdio MCP tool for discovering YouTube video candidates.

## Requirements

- Node.js and npm
- A Gemini API key from [Google AI Studio](https://aistudio.google.com/apikey)

## Setup

1. Install dependencies:

   ```sh
   npm install
   ```

2. Create a local `.env` file.
3. Set `GEMINI_API_KEY` in `.env` for the Gemini CLI. The model setting is optional.

Example `.env`:

```dotenv
GEMINI_API_KEY=replace_with_your_api_key
# Optional; defaults to gemini-3.5-flash-lite
GEMINI_MODEL=gemini-3.5-flash-lite
# Required only for the YouTube MCP server
YOUTUBE_API_KEY=replace_with_your_youtube_api_key
```

Never commit `.env` or share your API key. If a key is exposed, revoke it in
Google AI Studio and create a replacement.

## Usage

Run in development mode with a topic:

```sh
npm run dev -- "Find the most viewed MEME YouTube Shorts about Jensen Huang"
```

If no topic is provided, the example topic `Find the most viewed MEME YouTube Shorts about Jensen Huang` is used:

```sh
npm run dev
```

Build and run the compiled application:

```sh
npm run build
npm start -- "indie game trailers"
```

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Yes | None | API key used to authenticate with Gemini. |
| `GEMINI_MODEL` | No | `gemini-3.5-flash-lite` | Gemini model ID for text generation. |
| `YOUTUBE_API_KEY` | For YouTube MCP | None | Google API key with YouTube Data API v3 enabled. |

Model availability and prices can change. Check Google's
[model documentation](https://ai.google.dev/gemini-api/docs/models) and
[pricing page](https://ai.google.dev/gemini-api/docs/pricing) before deploying
or estimating costs. API usage may incur charges depending on your account and
current pricing.

## YouTube MCP server

Use Node.js 20.3 or later. Enable the YouTube Data API v3 in Google Cloud,
configure `YOUTUBE_API_KEY`, run `npm run build`, then configure an MCP client
to launch `node` with the absolute path to `dist/mcp/youtube-server.js` as its
argument. Set `YOUTUBE_API_KEY` in the client's environment (or run from the
directory containing `.env`). Do not use the Gemini CLI's key unless it is
also enabled for the YouTube Data API.

The `search_youtube_videos` tool accepts a nonblank `query` and optional
`maxResults` (1–50, default 50). It fetches one search page, retrieves video
details, filters videos to at most 180 seconds, and returns at most 10 ordered
by view count. YouTube's `short` search filter includes videos under four
minutes, so filtering may produce fewer than 10 results even when more exist.
These are duration-based candidates, not verified YouTube Shorts. Missing
counts are reported as zero. Each API request times out after 15 seconds;
errors are returned as MCP tool errors. API quota and service restrictions
apply.

## Project structure

```text
src/
  config/
    constants.ts        # Shared application and YouTube constants
    env.ts              # Loads and validates environment variables
  mcp/
    youtube-server.ts   # YouTube MCP stdio entry point
    youtube-api.ts      # YouTube API requests and response validation
  prompts/
    research.ts         # Builds the research-suggestion prompt
  services/
    gemini.ts           # Calls Gemini and returns generated text
  index.ts              # CLI entry point
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev -- "<topic>"` | Run directly from TypeScript. |
| `npm run typecheck` | Check TypeScript types without emitting files. |
| `npm run build` | Compile TypeScript into `dist/`. |
| `npm test` | Run focused YouTube API and MCP tests. |
| `npm run mcp:youtube` | Run the compiled YouTube MCP stdio server. |
| `npm start -- "<topic>"` | Run the compiled CLI. |

## Contributing

Issues and pull requests are welcome. Keep changes focused, document user-facing
configuration or behavior here, and run `npm run typecheck` and `npm run build`
before submitting a pull request.

## License

This project is distributed under the ISC license declared in `package.json`.
