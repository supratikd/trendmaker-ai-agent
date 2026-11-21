
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export function createTestVideo(): Promise<void> {
  return new Promise((resolve, reject) => {
    const outputDir = path.resolve("output");
    fs.mkdirSync(outputDir, { recursive: true });

    const outputFile = path.join(outputDir, "trendmaker-test.mp4");

    const args = [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=black:s=1080x1920:r=30:d=5",
      "-vf",
      "drawtext=text='TRENDMAKER AI':fontcolor=white:fontsize=76:x=(w-text_w)/2:y=(h-text_h)/2",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputFile
    ];

    const process = spawn("ffmpeg", args, { stdio: "inherit" });

    process.on("error", reject);

    process.on("close", (code) => {
      if (code === 0) {
        console.log("Video created:", outputFile);
        resolve();
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
  });
}
