#!/usr/bin/env node
"use strict";
// cursor-notifier:managed:start

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
const TELEGRAM_FORMATTED_MESSAGE_LIMIT = 3200;
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
      { timeout: NOTIFICATION_TIMEOUT_MS },
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
      await sendLongTelegramFormattedText(
        botToken,
        chatId,
        `Full response\n\n${fullResponse}`,
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
    await sendLongTelegramFormattedText(
      botToken,
      chatId,
      `Full response\n\n${fullResponse}`,
    );
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
  return `${normalized.slice(0, maxLength - 1)}...`;
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

async function sendTelegramMessage(token, chatId, text, parseMode = null) {
  const requestBody = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (parseMode) {
    requestBody.parse_mode = parseMode;
  }
  const payload = JSON.stringify(requestBody);
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

  const responsePayload = await new Promise((resolve) => {
    const request = https.request(options, (response) => {
      let responseBody = "";
      response.on("data", (chunk) => {
        responseBody += chunk;
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(responseBody));
        } catch {
          resolve(null);
        }
      });
    });
    request.on("error", (error) => {
      console.error("[cursor-notifier] Telegram notification failed.", error);
      resolve(null);
    });
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.write(payload);
    request.end();
  });

  if (responsePayload && responsePayload.ok) {
    return true;
  }

  const apiDescription =
    responsePayload &&
    typeof responsePayload === "object" &&
    "description" in responsePayload
      ? String(responsePayload.description || "")
      : "";

  if (parseMode) {
    const plainText = stripTelegramHtml(text);
    if (plainText.trim()) {
      console.error(
        "[cursor-notifier] Telegram parse mode failed; retrying as plain text.",
        apiDescription,
      );
      return sendTelegramMessage(token, chatId, plainText, null);
    }
  }

  console.error(
    "[cursor-notifier] Telegram API returned an error.",
    apiDescription || responsePayload,
  );
  return false;
}

async function sendLongTelegramText(token, chatId, text) {
  const chunks = splitTextByLimit(text, TELEGRAM_MESSAGE_LIMIT);
  for (const chunk of chunks) {
    await sendTelegramMessage(token, chatId, chunk);
  }
}

async function sendLongTelegramFormattedText(token, chatId, text) {
  const chunks = splitTextByLimit(text, TELEGRAM_FORMATTED_MESSAGE_LIMIT);
  for (const chunk of chunks) {
    const formatted = formatTelegramRichText(chunk);
    if (formatted) {
      await sendTelegramMessage(token, chatId, formatted, "HTML");
    }
  }
}

function splitTextByLimit(text, limit) {
  const normalized = String(text || "");
  if (!normalized.trim()) {
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
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
    if (remaining.startsWith("\n")) {
      remaining = remaining.slice(1);
    }
  }
  if (remaining.trim().length > 0) {
    chunks.push(remaining);
  }
  return chunks;
}

function extractFullResponse(payload) {
  const direct = pickFirstStringRaw(payload, [
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

function formatTelegramRichText(rawValue) {
  const value = String(rawValue || "").replace(/\r\n/g, "\n").trim();
  if (!value) {
    return "";
  }

  const segments = [];
  const codeBlockRegex = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match = codeBlockRegex.exec(value);

  while (match) {
    const [fullMatch, language = "", codeBlockBody = ""] = match;
    const start = match.index;
    const end = start + fullMatch.length;
    const textPart = value.slice(lastIndex, start);
    if (textPart) {
      const formatted = formatTelegramTextSegment(textPart);
      if (formatted.trim()) {
        segments.push(formatted);
      }
    }
    const languageClass = language.trim()
      ? ` class="language-${escapeTelegramHtmlAttribute(language.trim())}"`
      : "";
    segments.push(
      `<pre><code${languageClass}>${escapeTelegramHtml(codeBlockBody.trim())}</code></pre>`,
    );
    lastIndex = end;
    match = codeBlockRegex.exec(value);
  }

  const tail = value.slice(lastIndex);
  if (tail) {
    const formatted = formatTelegramTextSegment(tail);
    if (formatted.trim()) {
      segments.push(formatted);
    }
  }

  return segments.filter(Boolean).join("\n");
}

function formatTelegramTextSegment(rawText) {
  const lines = String(rawText || "").split("\n");
  const formattedLines = lines.map((line) => formatTelegramTextLine(line));
  const text = formattedLines.join("\n");
  return text;
}

function formatTelegramTextLine(rawLine) {
  const headingMatch = /^\s*#{1,6}\s+(.+)$/.exec(rawLine);
  if (headingMatch) {
    return `<b>${formatTelegramInline(headingMatch[1].trim())}</b>`;
  }

  const bulletMatch = /^(\s*)[-*]\s+(.+)$/.exec(rawLine);
  if (bulletMatch) {
    return `${bulletMatch[1]}• ${formatTelegramInline(bulletMatch[2])}`;
  }

  const numberedMatch = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(rawLine);
  if (numberedMatch) {
    return `${numberedMatch[1]}${numberedMatch[2]}. ${formatTelegramInline(numberedMatch[3])}`;
  }

  return formatTelegramInline(rawLine);
}

function formatTelegramInline(rawText) {
  let working = String(rawText || "");
  const placeholders = [];
  const createPlaceholder = (value) => {
    const key = `ZZZTGPH${placeholders.length}ZZZ`;
    placeholders.push({ key, value });
    return key;
  };

  working = working.replace(/`([^`\n]+)`/g, (_match, inlineCode) =>
    createPlaceholder(`<code>${escapeTelegramHtml(inlineCode)}</code>`),
  );

  working = working.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_match, label, href) =>
      createPlaceholder(
        `<a href="${escapeTelegramHtmlAttribute(href)}">${escapeTelegramHtml(label)}</a>`,
      ),
  );

  working = escapeTelegramHtml(working);
  working = working.replace(/\*\*([^*\n][^*\n]*?)\*\*/g, "<b>$1</b>");
  working = working.replace(/__([^_\n][^_\n]*?)__/g, "<b>$1</b>");
  working = working.replace(/~~([^~\n][^~\n]*?)~~/g, "<s>$1</s>");
  working = working.replace(/\*([^*\n][^*\n]*?)\*/g, "<i>$1</i>");
  working = working.replace(/_([^_\n][^_\n]*?)_/g, "<i>$1</i>");

  for (const placeholder of placeholders) {
    working = working.replaceAll(placeholder.key, placeholder.value);
  }
  return working;
}

function escapeTelegramHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeTelegramHtmlAttribute(value) {
  return escapeTelegramHtml(value).replace(/"/g, "&quot;");
}

function stripTelegramHtml(value) {
  const withoutTags = String(value || "").replace(/<\/?[^>]+>/g, "");
  return withoutTags
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function pickFirstStringRaw(payload, paths) {
  for (const keyPath of paths) {
    const value = getByPath(payload, keyPath);
    if (typeof value === "string" && value.trim()) {
      return value;
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
  return String(value)
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
// cursor-notifier:managed:end
