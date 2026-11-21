# trendmaker-ai-agent

A TypeScript prototype for researching YouTube videos, analyzing content
requests, and generating scene-by-scene video production plans with Gemini.

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
- Analyzes requests into structured context before YouTube agent discovery.
- Generates structured video production plans from analyzed context.
- Selects whole-video candidates from YouTube search metadata.
- Connects analysis, YouTube discovery, candidate selection, and production planning.
- Renders a standalone test video with FFmpeg.

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

After configuring `.env`, install dependencies with `npm install`; run the
research CLI with `npm run dev -- "<topic>"`; analyze an example request with
`npx tsx src/execute/test-context.ts`; discover YouTube videos with
`npx tsx src/execute/test-agent.ts` (requires both API keys); run the connected
selection and planning workflow with `npm run --silent workflow -- "<request>"`
(requires both API keys); or
generate a video plan with `npx tsx src/execute/test-video-planner.ts`.
Run `npm run typecheck` to check types,
`npm test` to run tests, and `npm run build` to compile; after building, use
`npm start -- "<topic>"` for the compiled CLI or `npm run mcp:youtube` to launch
the stdio MCP server. Run `npx tsx src/execute/test-renderer.ts` to render a test video
with FFmpeg.

Run in development mode with a topic:

```sh
npm run dev -- "indie game trailers"
```

If no topic is provided, the example topic `indie game trailers` is used:

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

The `search_youtube_videos` tool accepts a nonblank `query`, optional
`maxResults` (1–50, default 50), and `duration` (`short` or `any`, default
`short`). It fetches one search page, retrieves video details, and returns at
most 10 ordered by view count. The default filters videos to at most 180
seconds; `any` also includes longer sources. YouTube's `short` search filter
includes videos under four minutes, so filtering may produce fewer than 10
results even when more exist. These are duration-based candidates, not verified
YouTube Shorts. Missing counts and thumbnails are reported as `null`, not
fabricated values. Each API request times
out after 15 seconds; errors are returned as MCP tool errors. API quota and
service restrictions apply.

To run the example discovery agent, set both API keys and run
`npx tsx src/execute/test-agent.ts`. It first analyzes the request with Gemini, then
uses the original request and analyzed context to guide discovery through the
YouTube MCP tool. Run `npx tsx src/execute/test-context.ts` to inspect the analyzed
context alone. Both examples accept an optional request. Analysis and
discovery each make a Gemini request and may incur charges. The executable
examples for context, discovery, planning, and the connected workflow default to
`Find the most viewed MEME YouTube Shorts about Jensen Huang`; pass a request as
an argument to override it.

## Video production planner

With `GEMINI_API_KEY` set, run the planner example:

```sh
npx tsx src/execute/test-video-planner.ts
```

The example analyzes the request and then generates a plan, making two Gemini
requests. It prints a plan with scene directions, asset requirements and
audio notes, followed by a scene timeline. Scene durations must add up to the
plan duration and, when provided, the requested duration; invalid plans fail
rather than being returned. This planner does not search YouTube, verify claims,
or obtain rights to assets.

## Connected discovery and planning

Set both API keys and optionally provide a request:

```sh
npm run --silent workflow -- "Create a 45-second gaming highlights video for YouTube Shorts"
```

The workflow analyzes the request once,
searches via the YouTube MCP tool, selects whole-video candidates from the
returned metadata, and passes the selected links and context to the production
planner. It prints the context, all search candidates, the selected candidates,
and the plan. Scene `sourceVideoIds` refer to selected candidates; those
references are tentative and require human review. The workflow makes three
Gemini requests as well as YouTube API requests.

The output is one JSON object with `context`, `candidates`, `selection`, and
`plan`. Each candidate has a canonical URL derived from its video ID; unavailable
statistics and thumbnails are `null`. Scene `sourceVideoIds` may be empty for
original material and otherwise reference selected candidates. Scene durations
must total the planned duration and match the requested duration when specified.
Vertical Shorts use `9:16`. Invalid JSON or inconsistent data produces an error
instead of a partial result.

Illustrative mock output (the video ID is a placeholder, not a search result):

```json
{
  "context": {
    "topic": "indie games", "intent": "video_creation", "platform": "YouTube Shorts",
    "targetDuration": 45, "targetAudience": "gamers", "contentStyle": "vertical highlights",
    "researchRequired": true, "actions": ["Find candidates", "Plan scenes"]
  },
  "candidates": [{
    "videoId": "VIDEO_ID", "title": "Game trailer", "channel": "Example channel",
    "publishedAt": "2025-01-01T00:00:00Z", "durationSeconds": 60,
    "views": null, "likes": null, "comments": null,
    "url": "https://www.youtube.com/watch?v=VIDEO_ID", "thumbnail": null
  }],
  "selection": {
    "title": "Gaming highlights",
    "clips": [{
      "order": 1, "videoId": "VIDEO_ID", "title": "Game trailer",
      "url": "https://www.youtube.com/watch?v=VIDEO_ID",
      "durationSeconds": 60, "reason": "The title is relevant to the topic."
    }]
  },
  "plan": {
    "videoTitle": "Gaming highlights", "videoDescription": "A short gaming overview.",
    "targetAudience": "gamers", "videoDurationSeconds": 45, "aspectRatio": "9:16",
    "visualStyle": "vertical highlights",
    "scenes": [{
      "sceneNumber": 1, "sceneTitle": "Introduction", "durationSeconds": 45,
      "purpose": "Introduce the topic", "visualDirection": "Review the source before use.",
      "narration": "Introduce the game.", "onScreenText": ["Gaming highlights"],
      "assetRequirements": ["Licensed visuals"], "audioDirection": "Background music",
      "sourceVideoIds": ["VIDEO_ID"]
    }],
    "musicDirection": "Upbeat", "productionNotes": ["Verify footage and reuse rights."]
  }
}
```

Selection is based on metadata only: it does not inspect footage or transcripts,
provide timestamps, download or combine videos, or establish reuse rights.
Review the results and obtain permission before reusing footage. For general
YouTube requests the workflow searches sources of any duration; for YouTube
Shorts it searches short-form candidates. If a topic-and-style search has no
results, the workflow retries using only the topic, which uses additional YouTube
API quota. The combined source duration is not guaranteed to match the
requested duration.

## Test video renderer

Install FFmpeg with the `drawtext` filter and `libx264` encoder, and make sure
`ffmpeg` is on `PATH`. Run `npx tsx src/execute/test-renderer.ts` to create
`output/trendmaker-test.mp4`: a five-second, silent, 1080x1920 black video
with centered text. The renderer overwrites an existing output file. This demo
does not render production plans or require an API key.

## Project structure

```text
src/
  config/
    constants.ts        # Shared application and YouTube constants
    env.ts              # Loads and validates environment variables
  mcp/
    youtube-agent.ts    # Analyzes requests and runs MCP-based discovery
    youtube-server.ts   # YouTube MCP stdio entry point
    youtube-api.ts      # YouTube API requests and response validation
    youtube-client.ts   # Retrieves structured MCP search candidates
  prompts/
    research.ts         # Builds research, analysis, discovery, and planning prompts
  production/
    video-renderer.ts   # Renders a standalone FFmpeg test video
  services/
    clip-selector.ts    # Selects whole-video candidates from metadata
    context-analyzer.ts # Extracts and validates structured request context
    gemini.ts           # Calls Gemini and returns generated text
    video-production-planner.ts # Generates and validates a scene-by-scene plan
    video-workflow.ts   # Connects request analysis, discovery, selection, and planning
  index.ts              # CLI entry point
  execute/
    example-request.ts    # Shared default request for executable examples
    test-agent.ts         # Example YouTube discovery
    test-clip-selector.ts # Connected discovery and planning example
    test-context.ts       # Example request analysis
    test-renderer.ts      # Example test video renderer
    test-video-planner.ts # Example request analysis and production planning
```

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev -- "<topic>"` | Run directly from TypeScript. |
| `npm run --silent workflow -- "<request>"` | Print the complete validated workflow as JSON. |
| `npm run typecheck` | Check TypeScript types without emitting files. |
| `npm run build` | Compile TypeScript into `dist/`. |
| `npm test` | Run context, clip selection, production planning, YouTube API, and MCP tests. |
| `npm run mcp:youtube` | Run the compiled YouTube MCP stdio server. |
| `npm start -- "<topic>"` | Run the compiled CLI. |

## Contributing

Issues and pull requests are welcome. Keep changes focused, document user-facing
configuration or behavior here, and run `npm run typecheck` and `npm run build`
before submitting a pull request.

## License

This project is distributed under the ISC license declared in `package.json`.
