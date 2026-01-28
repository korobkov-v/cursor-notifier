#!/usr/bin/env node
"use strict";

const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const DEFAULT_TITLE = "Cursor";
const DEFAULT_MESSAGE_TEMPLATE = "Agent finished";
const DEFAULT_STATUS = "OK";
const NOTIFICATION_TIMEOUT_MS = 5000;

const title = (process.env.CURSOR_NOTIFY_TITLE || DEFAULT_TITLE).trim();
const template = (process.env.CURSOR_NOTIFY_MESSAGE || DEFAULT_MESSAGE_TEMPLATE).trim();
const status = (process.env.CURSOR_NOTIFY_STATUS || DEFAULT_STATUS).trim();
const message = template.replace("{status}", status).replace(/\s+/g, " ").trim();

process.stdin.setEncoding("utf8");
process.stdin.on("data", () => {});

process.stdin.on("end", () => {
  void notify();
});

process.stdin.on("error", () => {
  void notify();
});

process.stdin.resume();

async function notify() {
  if (process.platform === "darwin") {
    await notifyMac();
    return;
  }

  if (process.platform === "win32") {
    await notifyWindows();
  }
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
