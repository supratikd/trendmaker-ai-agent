import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { test } from "node:test";
import {
  checkSourceFiles,
  clearSourceAndOutputDirectories,
  downloadMissingSourceFiles,
} from "../src/services/source-manager.ts";

test("clears source and output directories before a new production", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trendmaker-cleanup-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = path.join(root, "assets", "sources");
  const output = path.join(root, "output");
  fs.mkdirSync(sources, { recursive: true });
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(sources, "old.mp4"), "old source");
  fs.writeFileSync(path.join(output, "old.mp4"), "old output");
  fs.mkdirSync(path.join(output, "stale-temp"));

  const cleared = clearSourceAndOutputDirectories(root);
  assert.deepEqual(fs.readdirSync(cleared.sourceDirectory), []);
  assert.deepEqual(fs.readdirSync(cleared.outputDirectory), []);
  assert.equal(fs.statSync(cleared.sourceDirectory).isDirectory(), true);
  assert.equal(fs.statSync(cleared.outputDirectory).isDirectory(), true);
});

const clip = (videoId) => ({
  order: 1, videoId, title: "Video", url: `https://www.youtube.com/watch?v=${videoId}`,
  durationSeconds: 30,
});
const production = (...ids) => ({ selection: { clips: ids.map(clip) } });
const verifiedShorts = async (url) => {
  const parsed = new URL(url);
  const json = (body) => new Response(JSON.stringify(body));
  if (parsed.pathname.endsWith("/videos")) {
    return json({ items: parsed.searchParams.get("id").split(",").map((id) => ({
      id,
      snippet: { title: id, channelTitle: "channel", channelId: "UCchannel", publishedAt: "2025-01-01" },
      contentDetails: { duration: "PT30S" },
      status: { license: "creativeCommon" },
    })) });
  }
  return json({ items: [{ contentDetails: { videoId: parsed.searchParams.get("videoId") } }] });
};

test("finds authorized ID-named and yt-dlp default files in the source or working directory", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trendmaker-sources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = path.join(root, "assets", "sources");
  fs.mkdirSync(sources, { recursive: true });
  fs.writeFileSync(path.join(sources, "one.mp4"), "one");
  fs.writeFileSync(path.join(sources, "Source title [two].mp4"), "two");
  fs.writeFileSync(path.join(root, "Downloaded title [three].mp4"), "three");
  fs.writeFileSync(path.join(root, "four.mp4"), "four");
  fs.writeFileSync(path.join(root, "Unrelated [three-other].mp4"), "other");

  const results = checkSourceFiles(production("one", "two", "three", "four"), root);
  assert.deepEqual(results.map((result) => path.basename(result.filePath)), [
    "one.mp4", "Source title [two].mp4", "Downloaded title [three].mp4", "four.mp4",
  ]);
  assert.ok(results.every((result) => result.exists && result.sizeBytes > 0));
});

test("reports missing, empty, and directory paths without treating them as videos", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trendmaker-sources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = path.join(root, "assets", "sources");
  fs.mkdirSync(sources, { recursive: true });
  fs.writeFileSync(path.join(sources, "empty.mp4"), "");
  fs.mkdirSync(path.join(sources, "folder.mp4"));
  const results = checkSourceFiles(production("missing", "empty", "folder"), root);
  assert.ok(results.every((result) => !result.exists && result.sizeBytes === 0));
  assert.equal(results[0].filePath, path.join(sources, "missing.mp4"));
});

test("rejects ambiguous filename matches and unsafe input", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trendmaker-sources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "First [abc].mp4"), "1");
  fs.writeFileSync(path.join(root, "Second [abc].mp4"), "2");
  assert.throws(() => checkSourceFiles(production("abc"), root), /Multiple source files/);
  assert.throws(() => checkSourceFiles(production("../abc"), root), /Invalid production selection/);
  assert.throws(() => checkSourceFiles({ selection: {} }, root), /Invalid production selection/);
});

test("downloads missing videos once and preserves existing files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trendmaker-sources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Existing [existing].mp4"), "existing");
  const spawn = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    assert.equal(command, "yt-dlp");
    assert.deepEqual(args.slice(0, 7), [
      "--ignore-config", "--verbose", "-f", "18", "--no-overwrites", "--no-playlist", "-o",
    ]);
    assert.equal(args[7], path.join(root, "assets", "sources", "%(id)s.%(ext)s"));
    assert.equal(args[8], "https://www.youtube.com/watch?v=missing");
    assert.equal(options.stdio, "inherit");
    const outputPath = args[7].replace("%(id)s", "missing").replace("%(ext)s", "mp4");
    fs.writeFileSync(outputPath, "video");
    return { status: 0, error: undefined, signal: null };
  });

  const result = await downloadMissingSourceFiles(production("existing", "missing", "missing"), "key", root, verifiedShorts);
  assert.equal(spawn.mock.callCount(), 1);
  assert.deepEqual(result.errors, []);
  assert.ok(result.sources.every((source) => source.exists));
  assert.equal(result.sources[1].filePath, path.join(root, "assets", "sources", "missing.mp4"));
});

test("reports failures, continues other downloads, and does not overwrite empty targets", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trendmaker-sources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = path.join(root, "assets", "sources");
  fs.mkdirSync(sources, { recursive: true });
  fs.writeFileSync(path.join(sources, "empty.mp4"), "");
  const spawn = t.mock.method(childProcess, "spawnSync", (command, args) => {
    if (args[8].endsWith("failed")) return { status: 1, signal: null };
    if (args[8].endsWith("nooutput")) return { status: 0, signal: null };
    const outputPath = args[7].replace("%(id)s", "success").replace("%(ext)s", "mp4");
    fs.writeFileSync(outputPath, "video");
    return { status: 0, signal: null };
  });

  const result = await downloadMissingSourceFiles(production("empty", "failed", "nooutput", "success"), "key", root, verifiedShorts);
  assert.equal(spawn.mock.callCount(), 3);
  assert.deepEqual(result.errors.map((error) => error.videoId), ["empty", "failed", "nooutput"]);
  assert.match(result.errors[0].message, /already exists/);
  assert.match(result.errors[1].message, /exit code 1/);
  assert.match(result.errors[2].message, /did not produce/);
  assert.equal(fs.statSync(path.join(sources, "empty.mp4")).size, 0);
  assert.equal(result.sources[3].exists, true);
});

test("does not download any files when a source exceeds the Shorts duration limit", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trendmaker-sources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spawn = t.mock.method(childProcess, "spawnSync", () => { throw new Error("unexpected download"); });
  const tooLong = async () => new Response(JSON.stringify({ items: [{
    id: "regular",
    snippet: { title: "regular", channelTitle: "channel", channelId: "UCchannel", publishedAt: "2025-01-01" },
    contentDetails: { duration: "PT3M1S" },
    status: { license: "creativeCommon" },
  }] }));
  await assert.rejects(downloadMissingSourceFiles(production("regular"), "key", root, tooLong), /3-minute/);
  assert.equal(spawn.mock.callCount(), 0);
});

test("does not download a source that is not marked Creative Commons", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trendmaker-sources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const spawn = t.mock.method(childProcess, "spawnSync", () => {
    throw new Error("unexpected download");
  });
  const standardLicense = async () => new Response(JSON.stringify({ items: [{
    id: "standard",
    snippet: { title: "standard", channelTitle: "channel", channelId: "UCchannel", publishedAt: "2025-01-01" },
    contentDetails: { duration: "PT30S" },
    status: { license: "youtube" },
  }] }));
  await assert.rejects(
    downloadMissingSourceFiles(production("standard"), "key", root, standardLicense),
    /not marked Creative Commons/,
  );
  assert.equal(spawn.mock.callCount(), 0);
});
