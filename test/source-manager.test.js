import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { test } from "node:test";
import { checkSourceFiles, downloadMissingSourceFiles } from "../src/services/source-manager.ts";

const clip = (videoId) => ({
  order: 1, videoId, title: "Video", url: `https://www.youtube.com/watch?v=${videoId}`,
  durationSeconds: 30,
});
const production = (...ids) => ({ selection: { clips: ids.map(clip) } });

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

test("downloads missing videos once and preserves existing files", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trendmaker-sources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "Existing [existing].mp4"), "existing");
  const spawn = t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    assert.equal(command, "yt-dlp");
    assert.deepEqual(args.slice(0, 7), [
      "--ignore-config", "--verbose", "-f", "18", "--no-overwrites", "--no-playlist", "-o",
    ]);
    assert.equal(args[8], "https://www.youtube.com/watch?v=missing");
    assert.equal(options.stdio, "inherit");
    fs.writeFileSync(args[7], "video");
    return { status: 0, error: undefined, signal: null };
  });

  const result = downloadMissingSourceFiles(production("existing", "missing", "missing"), root);
  assert.equal(spawn.mock.callCount(), 1);
  assert.deepEqual(result.errors, []);
  assert.ok(result.sources.every((source) => source.exists));
  assert.equal(result.sources[1].filePath, path.join(root, "assets", "sources", "missing.mp4"));
});

test("reports failures, continues other downloads, and does not overwrite empty targets", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "trendmaker-sources-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sources = path.join(root, "assets", "sources");
  fs.mkdirSync(sources, { recursive: true });
  fs.writeFileSync(path.join(sources, "empty.mp4"), "");
  const spawn = t.mock.method(childProcess, "spawnSync", (command, args) => {
    if (args[8].endsWith("failed")) return { status: 1, signal: null };
    if (args[8].endsWith("nooutput")) return { status: 0, signal: null };
    fs.writeFileSync(args[7], "video");
    return { status: 0, signal: null };
  });

  const result = downloadMissingSourceFiles(production("empty", "failed", "nooutput", "success"), root);
  assert.equal(spawn.mock.callCount(), 3);
  assert.deepEqual(result.errors.map((error) => error.videoId), ["empty", "failed", "nooutput"]);
  assert.match(result.errors[0].message, /already exists/);
  assert.match(result.errors[1].message, /exit code 1/);
  assert.match(result.errors[2].message, /did not produce/);
  assert.equal(fs.statSync(path.join(sources, "empty.mp4")).size, 0);
  assert.equal(result.sources[3].exists, true);
});
