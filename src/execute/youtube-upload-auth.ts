import fs from "node:fs";
import path from "node:path";
import { authenticate } from "@google-cloud/local-auth";

const credentialsDirectory = path.resolve("credentials");
const clientPath = path.join(credentialsDirectory, "youtube-oauth-client.json");
const tokenPath = path.join(credentialsDirectory, "youtube-upload-token.json");

async function main(): Promise<void> {
  if (!fs.existsSync(clientPath)) {
    throw new Error(
      "Download a Desktop OAuth client from Google Cloud and save it as " +
      "credentials/youtube-oauth-client.json.",
    );
  }
  const auth = await authenticate({
    keyfilePath: clientPath,
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
  });
  fs.mkdirSync(credentialsDirectory, { recursive: true });
  fs.writeFileSync(tokenPath, `${JSON.stringify(auth.credentials, null, 2)}\n`, "utf8");
  console.log(`YouTube upload authorization saved to ${tokenPath}`);
}

main().catch((error: unknown) => {
  console.error("Failed to authorize YouTube uploads:", error);
  process.exitCode = 1;
});
