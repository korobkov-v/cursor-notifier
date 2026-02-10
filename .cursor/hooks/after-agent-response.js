#!/usr/bin/env node
"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs/promises");
const path = require("node:path");
const https = require("node:https");

const execFileAsync = promisify(execFile);

const DEFAULT_TITLE = "Cursor";
const DEFAULT_MESSAGE_TEMPLATE = "Agent finished";
const DEFAULT_STATUS = "OK";
const NOTIFICATION_TIMEOUT_MS = 5000;
const TELEGRAM_TIMEOUT_MS = 5000;
const TELEGRAM_MESSAGE_LIMIT = 3900;
const PROJECT_DIR =
  process.env.CURSOR_PROJECT_DIR ||
  path.resolve(__dirname, "..", "..");
const CONFIG_PATH = path.join(PROJECT_DIR, ".cursor", "cursor-notifier.json");
const START_PATH = path.join(
  PROJECT_DIR,
  ".cursor",
  "cursor-notifier-start.json",
);

const title = (process.env.CURSOR_NOTIFY_TITLE || DEFAULT_TITLE).trim();
const template = (process.env.CURSOR_NOTIFY_MESSAGE || DEFAULT_MESSAGE_TEMPLATE).trim();
const status = (process.env.CURSOR_NOTIFY_STATUS || DEFAULT_STATUS).trim();
const message = template.replace("{status}", status).replace(/\s+/g, " ").trim();

process.stdin.setEncoding("utf8");
let input = "";
process.stdin.on("data", (chunk) => {
  input += chunk;
});

process.stdin.on("end", () => {
  void notify(input);
});

process.stdin.on("error", () => {
  void notify(input);
});

process.stdin.resume();

async function notify(rawInput) {
  const payload = parseJson(rawInput);
  const durationMs = await getDurationMs(payload);
  if (process.platform === "darwin") {
    await notifyMac();
    await maybeSendTelegram(payload, durationMs);
    return;
  }

  if (process.platform === "win32") {
    await notifyWindows();
  }
  await maybeSendTelegram(payload, durationMs);
}

async function notifyMac() {
  const safeTitle = escapeAppleScriptString(title);
  const safeMessage = escapeAppleScriptString(message);
  const script = `display notification "${safeMessage}" with title "${safeTitle}"`;

  try {
    await execFileAsync("/usr/bin/osascript", ["-e", script], {
      timeout: NOTIFICATION_TIMEOUT_MS,
    });
  } catch (error) {
    // Best-effort notification: log and ignore failures.
    console.error("[cursor-notifier] Notification failed.", error);
  }
}

async function notifyWindows() {
  const safeTitle = escapePowerShellString(title || DEFAULT_TITLE);
  const safeMessage = escapePowerShellString(message);
  const safeAppId = escapePowerShellString(DEFAULT_TITLE);
  const script = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "$template = [Windows.UI.Notifications.ToastTemplateType]::ToastText02",
    "$toastXml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent($template)",
    "$toastTextElements = $toastXml.GetElementsByTagName('text')",
    `$toastTextElements.Item(0).AppendChild($toastXml.CreateTextNode('${safeTitle}')) > $null`,
    `$toastTextElements.Item(1).AppendChild($toastXml.CreateTextNode('${safeMessage}')) > $null`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($toastXml)",
    `$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${safeAppId}')`,
    "$notifier.Show($toast)",
  ].join("; ");

  try {
    await execFileAsync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      { timeout: NOTIFICATION_TIMEOUT_MS }
    );
  } catch (error) {
    // Best-effort notification: log and ignore failures.
    console.error("[cursor-notifier] Notification failed.", error);
  }
}

async function maybeSendTelegram(payload, durationMs) {
  const config = await readJsonFile(CONFIG_PATH);
  const telegram = config?.telegram ?? {};
  if (!telegram.enabled) {
    return;
  }
  const botToken = String(telegram.botToken || "").trim();
  const chatId = String(telegram.chatId || "").trim();
  if (!botToken || !chatId) {
    return;
  }

  const minDurationSeconds = parseMinDurationSeconds(telegram.minDuration);
  const includeFullResponse = Boolean(telegram.includeFullResponse);
  const fullResponse = includeFullResponse
    ? extractFullResponse(payload)
    : "";
  if (durationMs == null) {
    // If minimum duration is not configured, send anyway.
    if (minDurationSeconds != null && Number.isFinite(minDurationSeconds)) {
      return;
    }
    const messageText = buildTelegramMessage(payload, null);
    await sendTelegramMessage(botToken, chatId, messageText);
    if (includeFullResponse && fullResponse) {
      await sendLongTelegramText(
        botToken,
        chatId,
        `Full response\n\n${fullResponse}`
      );
    }
    return;
  }

  const durationSeconds = durationMs / 1000;
  if (
    minDurationSeconds != null &&
    Number.isFinite(minDurationSeconds) &&
    durationSeconds < minDurationSeconds
  ) {
    return;
  }
  const messageText = buildTelegramMessage(payload, durationSeconds);
  await sendTelegramMessage(botToken, chatId, messageText);
  if (includeFullResponse && fullResponse) {
    await sendLongTelegramText(botToken, chatId, `Full response\n\n${fullResponse}`);
  }
}

async function getDurationMs(payload) {
  const generationId = getGenerationId(payload);
  if (!generationId) {
    return null;
  }
  const startData = await readJsonFile(START_PATH);
  if (!startData || typeof startData !== "object") {
    return null;
  }
  const startedAt = Number(startData[generationId]);
  if (!Number.isFinite(startedAt)) {
    return null;
  }

  delete startData[generationId];
  await writeJsonFile(START_PATH, startData);
  return Math.max(0, Date.now() - startedAt);
}

function getGenerationId(payload) {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return payload.generation_id || payload.generationId || null;
}

function buildTelegramMessage(payload, durationSeconds) {
  const durationText = formatDuration(durationSeconds);
  const durationPart = Number.isFinite(durationSeconds)
    ? `${durationText} s`
    : "unknown duration";
  const payloadStatus = getPayloadStatus(payload) || status;
  const model = getPayloadModel(payload);
  const projectName = path.basename(PROJECT_DIR);
  const generationId = getGenerationId(payload);
  const summary = getPayloadSummary(payload);
  const requestPreview = getPayloadRequestPreview(payload);
  const changedFiles = getPayloadChangedFiles(payload);

  const lines = [
    "Cursor Notifier",
    "",
    `Project: ${projectName}`,
    `Status: ${payloadStatus}`,
    `Duration: ${durationPart}`,
  ];

  if (model) {
    lines.push(`Model: ${model}`);
  }
  if (generationId) {
    lines.push(`Generation: ${generationId}`);
  }
  if (changedFiles.length > 0) {
    lines.push(`Files: ${truncateText(changedFiles.join(", "), 280)}`);
  }
  if (summary) {
    lines.push("");
    lines.push("Summary");
    lines.push(summary);
  }
  if (requestPreview) {
    lines.push("");
    lines.push("Request");
    lines.push(requestPreview);
  }

  return lines.join("\n");
}

function parseMinDurationSeconds(rawValue) {
  if (rawValue == null) {
    return null;
  }
  const value = String(rawValue).trim();
  if (!value) {
    return null;
  }
  const match = /^(\d+):([0-5]?\d)$/.exec(value);
  if (!match) {
    return null;
  }
  const minutes = Number(match[1]);
  const seconds = Number(match[2]);
  if (!Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }
  return minutes * 60 + seconds;
}

function getPayloadStatus(payload) {
  const value = pickFirstString(payload, [
    "status",
    "result.status",
    "response.status",
  ]);
  return value ? value.toUpperCase() : "";
}

function getPayloadModel(payload) {
  return pickFirstString(payload, [
    "model",
    "result.model",
    "response.model",
    "metadata.model",
  ]);
}

function getPayloadSummary(payload) {
  const summary = pickFirstString(payload, [
    "summary",
    "result.summary",
    "response.summary",
    "message",
    "result.message",
  ]);
  return truncateText(summary, 320);
}

function getPayloadRequestPreview(payload) {
  const request = pickFirstString(payload, [
    "prompt",
    "request",
    "request.prompt",
    "request.text",
    "userPrompt",
    "user_prompt",
  ]);
  return truncateText(request, 220);
}

function getPayloadChangedFiles(payload) {
  const raw = pickFirstArray(payload, [
    "changedFiles",
    "changed_files",
    "files",
    "filePaths",
  ]);
  if (!raw.length) {
    return [];
  }
  return raw
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .slice(0, 8);
}

function pickFirstArray(payload, paths) {
  for (const keyPath of paths) {
    const value = getByPath(payload, keyPath);
    if (Array.isArray(value)) {
      return value;
    }
  }
  return [];
}

function pickFirstString(payload, paths) {
  for (const keyPath of paths) {
    const value = getByPath(payload, keyPath);
    if (typeof value === "string" && value.trim()) {
      return value.trim().replace(/\s+/g, " ");
    }
  }
  return "";
}

function getByPath(obj, keyPath) {
  if (!obj || typeof obj !== "object") {
    return undefined;
  }
  const parts = keyPath.split(".");
  let current = obj;
  for (const part of parts) {
    if (!current || typeof current !== "object" || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function truncateText(value, maxLength) {
  if (typeof value !== "string" || maxLength <= 0) {
    return "";
  }
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

function formatSeconds(value) {
  if (!Number.isFinite(value)) {
    return "0";
  }
  if (value >= 60) {
    return String(Math.round(value));
  }
  return String(Math.round(value * 10) / 10);
}

function formatDuration(value) {
  return formatSeconds(value);
}

async function sendTelegramMessage(token, chatId, text) {
  const payload = JSON.stringify({
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  });
  const options = {
    hostname: "api.telegram.org",
    path: `/bot${token}/sendMessage`,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    },
    timeout: TELEGRAM_TIMEOUT_MS,
  };

  await new Promise((resolve) => {
    const request = https.request(options, (response) => {
      response.on("data", () => {});
      response.on("end", resolve);
    });
    request.on("error", (error) => {
      console.error("[cursor-notifier] Telegram notification failed.", error);
      resolve();
    });
    request.on("timeout", () => {
      request.destroy();
      resolve();
    });
    request.write(payload);
    request.end();
  });
}

async function sendLongTelegramText(token, chatId, text) {
  const chunks = splitTextByLimit(text, TELEGRAM_MESSAGE_LIMIT);
  for (const chunk of chunks) {
    await sendTelegramMessage(token, chatId, chunk);
  }
}

function splitTextByLimit(text, limit) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return [];
  }
  if (normalized.length <= limit) {
    return [normalized];
  }
  const chunks = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) {
      splitAt = remaining.lastIndexOf(" ", limit);
    }
    if (splitAt <= 0) {
      splitAt = limit;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

function extractFullResponse(payload) {
  const direct = pickFirstString(payload, [
    "response",
    "result.response",
    "response.text",
    "result.responseText",
    "result.text",
    "text",
    "output",
    "result.output",
    "finalResponse",
    "message",
    "result.message",
  ]);
  if (direct) {
    return direct;
  }
  const contentArray = pickFirstArray(payload, [
    "response.content",
    "result.content",
    "content",
  ]);
  if (contentArray.length > 0) {
    const joined = contentArray
      .map((entry) =>
        typeof entry === "string" ? entry.trim() : JSON.stringify(entry),
      )
      .filter(Boolean)
      .join("\n");
    if (joined) {
      return joined;
    }
  }
  const objectCandidate = getByPath(payload, "response");
  if (objectCandidate && typeof objectCandidate === "object") {
    try {
      return JSON.stringify(objectCandidate, null, 2);
    } catch {
      return "";
    }
  }
  return "";
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
    console.error("[cursor-notifier] Failed to write file.", error);
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

function escapeAppleScriptString(value) {
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\s+/g, " ")
    .trim();
}

function escapePowerShellString(value) {
  return String(value)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/'/g, "''")
    .replace(/\s+/g, " ")
    .trim();
}
