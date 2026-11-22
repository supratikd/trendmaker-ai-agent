import "dotenv/config";

import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { google } from "googleapis";
import { z } from "zod";
import { env } from "../config/env.js";
import { parseStructuredJson } from "./structured-json.js";
import { createYouTubeShortMetadataPrompt } from "../prompts/research.js";

const ROOT = process.cwd();
const CLIENT_PATH = path.resolve(ROOT, "credentials", "youtube-oauth-client.json");
const TOKEN_PATH = path.resolve(ROOT, "credentials", "youtube-upload-token.json");

const productionPostSchema = z.object({
  plan: z.object({
    videoTitle: z.string().trim().min(1).max(100),
    videoDescription: z.string().max(5000).optional(),
  }),
});

const oauthClientSchema = z.object({
  installed: z.object({
    client_id: z.string().min(1),
    client_secret: z.string().min(1),
    redirect_uris: z.array(z.string().url()).min(1),
  }),
});

export interface YouTubePostMetadata {
  title: string;
  description: string;
}

export interface YouTubePostResult {
  videoId: string;
  title: string;
  privacyStatus: string;
  url: string;
}

const shortMetadataSchema = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(5000),
  hashtags: z.array(z.string().trim().min(1).max(40)).min(3).max(10),
});

export async function generateYouTubeShortMetadata(
  production: unknown,
): Promise<YouTubePostMetadata> {
  getYouTubePostMetadata(production);
  const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: env.GEMINI_MODEL,
    contents: createYouTubeShortMetadataPrompt(production),
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          description: { type: "STRING" },
          hashtags: {
            type: "ARRAY",
            items: { type: "STRING" },
          },
        },
        required: ["title", "description", "hashtags"],
      },
    },
  });
  if (!response.text) {
    throw new Error("Gemini returned empty YouTube Shorts metadata.");
  }

  const metadata = parseStructuredJson(
    response.text,
    shortMetadataSchema,
    "YouTube Shorts metadata",
  );
  const normalizeHashtag = (value: string): string =>
    `#${value
      .replace(/^#+/, "")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 30)}`;
  const hashtags = [...new Set([
    "#Shorts",
    ...metadata.hashtags.map(normalizeHashtag).filter((tag) => tag !== "#"),
  ])];
  let title = metadata.title.trim();
  if (!/#Shorts\b/i.test(title)) {
    const suffix = " #Shorts";
    title = title.length + suffix.length <= 100
      ? `${title}${suffix}`
      : title.slice(0, 100 - suffix.length).trimEnd() + suffix;
  }
  const description = `${metadata.description.trim()}\n\n${hashtags.join(" ")}`.trim();
  if (description.length > 5000) {
    throw new Error("Gemini generated a YouTube description longer than 5000 characters.");
  }

  return { title, description };
}

export function getYouTubePostMetadata(production: unknown): YouTubePostMetadata {
  const parsed = productionPostSchema.safeParse(production);
  if (!parsed.success) {
    throw new Error(`Invalid production metadata for YouTube upload: ${parsed.error.message}`);
  }
  return {
    title: parsed.data.plan.videoTitle,
    description: parsed.data.plan.videoDescription ?? "",
  };
}

export function resolveUploadVideoPath(
  filePath: string,
  rootDirectory = ROOT,
): string {
  const outputDirectory = path.resolve(rootDirectory, "output");
  const resolvedPath = path.resolve(rootDirectory, filePath);
  const relativePath = path.relative(outputDirectory, resolvedPath);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Video must be located inside the output directory.");
  }
  if (path.extname(resolvedPath).toLowerCase() !== ".mp4") {
    throw new Error("Only MP4 videos can be uploaded.");
  }
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Video file not found: ${resolvedPath}`);
  }
  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile() || stats.size === 0) {
    throw new Error("The selected video is empty or is not a file.");
  }
  return resolvedPath;
}

async function getYouTubeClient() {
  if (!fs.existsSync(CLIENT_PATH)) {
    throw new Error(
      "OAuth client credentials not found. Expected credentials/youtube-oauth-client.json.",
    );
  }
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(
      "OAuth token not found. Run `npm run youtube:auth` to authorize uploads.",
    );
  }

  const clientConfig = oauthClientSchema.parse(
    JSON.parse(fs.readFileSync(CLIENT_PATH, "utf8")),
  );
  const installed = clientConfig.installed;
  const oauth2Client = new google.auth.OAuth2(
    installed.client_id,
    installed.client_secret,
    installed.redirect_uris[0],
  );

  let savedTokens: Record<string, unknown> = JSON.parse(
    fs.readFileSync(TOKEN_PATH, "utf8"),
  );
  oauth2Client.setCredentials(savedTokens);
  oauth2Client.on("tokens", (newTokens) => {
    savedTokens = {
      ...savedTokens,
      ...newTokens,
      refresh_token: newTokens.refresh_token ?? savedTokens.refresh_token,
    };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(savedTokens, null, 2), "utf8");
  });

  return google.youtube({ version: "v3", auth: oauth2Client });
}

export async function uploadPost(
  filePath: string,
  production: unknown,
  privacyStatus: "public" | "unlisted" | "private" = "unlisted",
): Promise<YouTubePostResult> {
  const videoPath = resolveUploadVideoPath(filePath);
  console.log("[YouTube Upload] Generating Shorts title, description, and hashtags with Gemini...");
  const metadata = await generateYouTubeShortMetadata(production);
  const youtube = await getYouTubeClient();

  console.log(`[YouTube Upload] Uploading: ${videoPath}`);
  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: {
        title: metadata.title,
        description: metadata.description,
        categoryId: "28",
      },
      status: { privacyStatus },
    },
    media: {
      mimeType: "video/mp4",
      body: fs.createReadStream(videoPath),
    },
  });

  const videoId = response.data.id;
  if (!videoId) {
    throw new Error("YouTube did not return a video ID.");
  }

  const result = {
    videoId,
    title: response.data.snippet?.title ?? metadata.title,
    privacyStatus: response.data.status?.privacyStatus ?? "unlisted",
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
  console.log(`[YouTube Upload] Completed: ${result.url} (${result.privacyStatus})`);
  return result;
}
