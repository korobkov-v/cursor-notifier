#!/usr/bin/env node
"use strict";
// cursor-notifier:managed:start

const fs = require("node:fs/promises");
const path = require("node:path");

const PROJECT_DIR =
  process.env.CURSOR_PROJECT_DIR ||
  path.resolve(__dirname, "..", "..");
const START_PATH = path.join(
  PROJECT_DIR,
  ".cursor",
  "cursor-notifier-start.json",
);

process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  void recordStart(input);
});

process.stdin.on("error", () => {
  void recordStart(input);
});

process.stdin.resume();

async function recordStart(rawInput) {
  const payload = parseJson(rawInput);
  const generationId = getGenerationId(payload);
  if (!generationId) {
    return;
  }

  const data = (await readJsonFile(START_PATH)) ?? {};
  data[generationId] = Date.now();
  await writeJsonFile(START_PATH, data);
}

function getGenerationId(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return payload.generation_id || payload.generationId || null;
}

async function readJsonFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath, payload) {
  try {
    const serialized = JSON.stringify(payload, null, 2) + "\n";
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, serialized, "utf8");
  } catch (error) {
    console.error("[cursor-notifier] Failed to write start time.", error);
  }
}

function parseJson(value) {
  if (!value || !value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
// cursor-notifier:managed:end
