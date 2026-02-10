import * as path from "node:path";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as vscode from "vscode";

const STATUS_BAR_PRIORITY = 100;
const LOCK_MAX_RETRIES = 8;
const LOCK_RETRY_DELAY_MS = 75;
const CONFIG_SECTION = "cursor-notifier";
const AFTER_AGENT_SCRIPT = "after-agent-response.js";
const BEFORE_SUBMIT_SCRIPT = "before-submit-prompt.js";
const HOOK_COMMAND_AFTER = buildHookCommand(AFTER_AGENT_SCRIPT);
const HOOK_COMMAND_BEFORE = buildHookCommand(BEFORE_SUBMIT_SCRIPT);
const HOOK_COMMANDS = [HOOK_COMMAND_AFTER, HOOK_COMMAND_BEFORE] as const;
const HOOK_SCRIPTS = [AFTER_AGENT_SCRIPT, BEFORE_SUBMIT_SCRIPT] as const;
const CONFIG_FILE_NAME = "cursor-notifier.json";
const START_FILE_NAME = "cursor-notifier-start.json";
const MANAGED_BLOCK_START = "// cursor-notifier:managed:start";
const MANAGED_BLOCK_END = "// cursor-notifier:managed:end";
const GITIGNORE_ENTRIES = [
  ".cursor/hooks.json",
  ".cursor/hooks/after-agent-response.js",
  ".cursor/hooks/before-submit-prompt.js",
  ".cursor/cursor-notifier.json",
  ".cursor/cursor-notifier-start.json",
] as const;
let outputChannel: vscode.OutputChannel | undefined;
let extensionContext: vscode.ExtensionContext | undefined;

export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("Cursor Notifier");
  context.subscriptions.push(outputChannel);

  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    STATUS_BAR_PRIORITY,
  );
  statusBarItem.command = "cursor-notifier.toggle";
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  const extensionEnabled = getSetting("enabled", true);
  if (extensionEnabled) {
    const results = await Promise.all(
      workspaceFolders.map((folder) =>
        ensureCursorHook(folder.uri.fsPath, context),
      ),
    );
    updateStatusBar(statusBarItem, results.some(Boolean));
    await Promise.all(
      workspaceFolders.map((folder) => syncWorkspaceConfig(folder.uri.fsPath)),
    );
  } else {
    updateStatusBar(statusBarItem, false);
  }

  const toggleCommand = vscode.commands.registerCommand(
    "cursor-notifier.toggle",
    async () => {
      const enabled = getSetting("enabled", true);
      const nextEnabled = !enabled;
      await updateSetting("enabled", nextEnabled);

      const toggleResults = await Promise.all(
        workspaceFolders.map((folder) =>
          setWorkspaceHookEnabled(folder.uri.fsPath, context, nextEnabled),
        ),
      );

      updateStatusBar(
        statusBarItem,
        nextEnabled && toggleResults.some(Boolean),
      );
      if (nextEnabled) {
        await Promise.all(
          workspaceFolders.map((folder) =>
            syncWorkspaceConfig(folder.uri.fsPath),
          ),
        );
      }
    },
  );
  context.subscriptions.push(toggleCommand);

  const subscription = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
    if (!getSetting("enabled", true)) {
      return;
    }
    void Promise.all(
      event.added.map((folder) => ensureCursorHook(folder.uri.fsPath, context)),
    ).then((addedResults) => {
      if (addedResults.some(Boolean)) {
        updateStatusBar(statusBarItem, true);
      }
    });
    void Promise.all(
      event.added.map((folder) => syncWorkspaceConfig(folder.uri.fsPath)),
    );
  });
  context.subscriptions.push(subscription);

  const settingsSubscription = vscode.workspace.onDidChangeConfiguration(
    (event) => {
      if (!event.affectsConfiguration(CONFIG_SECTION)) {
        return;
      }
      if (!getSetting("enabled", true)) {
        return;
      }
      void Promise.all(
        workspaceFolders.map((folder) =>
          syncWorkspaceConfig(folder.uri.fsPath),
        ),
      );
    },
  );
  context.subscriptions.push(settingsSubscription);
}

export async function deactivate(): Promise<void> {
  const context = extensionContext;
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!context || !workspaceFolders || workspaceFolders.length === 0) {
    return;
  }

  await Promise.all(
    workspaceFolders.map((folder) =>
      removeWorkspaceHookOnDeactivate(folder.uri.fsPath, context),
    ),
  );
}

async function ensureCursorHook(
  workspacePath: string,
  context: vscode.ExtensionContext,
  allowPrompt = true,
): Promise<boolean> {
  if (!(await isDirectory(workspacePath))) {
    logWarn("Workspace path is not a directory; skipping hook setup.", {
      workspacePath,
    });
    return false;
  }

  const cursorDir = path.join(workspacePath, ".cursor");
  const hooksDir = path.join(cursorDir, "hooks");
  const hooksJsonPath = path.join(cursorDir, "hooks.json");
  const existingConfig = await readHooksConfig(hooksJsonPath);

  if (!existingConfig.valid) {
    logWarn("Invalid hooks.json; skipping update.", { hooksJsonPath });
    return false;
  }

  if (existingConfig.hasHookCommand) {
    await context.globalState.update(getEnabledPromptKey(workspacePath), true);
  }

  const shouldEnable = existingConfig.hasHookCommand
    ? true
    : allowPrompt
      ? await promptToEnableHooks(workspacePath, context, false)
      : true;
  if (!shouldEnable) {
    return existingConfig.hasHookCommand;
  }

  try {
    await fs.mkdir(hooksDir, { recursive: true });
    await Promise.all(
      HOOK_SCRIPTS.map((script) => {
        const srcHookPath = context.asAbsolutePath(
          path.join(".cursor", "hooks", script),
        );
        const destHookPath = path.join(hooksDir, script);
        return copyHookIfMissing(srcHookPath, destHookPath);
      }),
    );
    await upsertHooksJson(hooksJsonPath);
    try {
      if (getSetting("autoIgnoreGitFiles", true)) {
        await ensureGitignoreEntries(workspacePath);
      }
    } catch (error) {
      logWarn("Failed to update .gitignore.", error);
    }
    try {
      await syncWorkspaceConfig(workspacePath);
    } catch (error) {
      logWarn("Failed to update workspace config.", error);
    }
    return true;
  } catch (error) {
    logWarn("Failed to ensure hook files.", error);
    return existingConfig.hasHookCommand;
  }
}

async function copyHookIfMissing(
  srcHookPath: string,
  destHookPath: string,
): Promise<void> {
  const srcExists = await fileExists(srcHookPath);
  if (!srcExists) {
    throw new Error(`Missing bundled hook script at ${srcHookPath}`);
  }

  try {
    await fs.copyFile(srcHookPath, destHookPath, fsConstants.COPYFILE_EXCL);
    return;
  } catch (error) {
    if (!isErrno(error, "EEXIST")) {
      throw error;
    }
  }

  const [srcContent, destContent] = await Promise.all([
    fs.readFile(srcHookPath, "utf8"),
    fs.readFile(destHookPath, "utf8"),
  ]);

  if (srcContent !== destContent) {
    const managedBlock = extractManagedBlock(srcContent);
    if (!managedBlock) {
      logWarn("Bundled hook script is missing managed block markers.", {
        srcHookPath,
      });
      return;
    }
    const mergedContent = replaceManagedBlock(destContent, managedBlock);
    if (mergedContent === null) {
      logWarn(
        "Hook script differs and has no managed block markers; leaving as-is.",
        { destHookPath },
      );
      return;
    }
    if (mergedContent === destContent) {
      return;
    }
    await fs.writeFile(destHookPath, mergedContent, "utf8");
    logWarn("Updated managed hook block to latest bundled version.", {
      destHookPath,
    });
  }
}

function extractManagedBlock(content: string): string | null {
  const start = content.indexOf(MANAGED_BLOCK_START);
  if (start === -1) {
    return null;
  }
  const end = content.indexOf(MANAGED_BLOCK_END, start);
  if (end === -1) {
    return null;
  }
  return content.slice(start, end + MANAGED_BLOCK_END.length);
}

function replaceManagedBlock(
  content: string,
  managedBlock: string,
): string | null {
  const start = content.indexOf(MANAGED_BLOCK_START);
  if (start === -1) {
    return null;
  }
  const end = content.indexOf(MANAGED_BLOCK_END, start);
  if (end === -1) {
    return null;
  }
  const endExclusive = end + MANAGED_BLOCK_END.length;
  return `${content.slice(0, start)}${managedBlock}${content.slice(endExclusive)}`;
}

async function upsertHooksJson(hooksJsonPath: string): Promise<void> {
  await withHooksJsonLock(hooksJsonPath, async () => {
    const exists = await fileExists(hooksJsonPath);
    let config: HooksConfig = {};
    let changed = false;

    if (exists) {
      try {
        const raw = await fs.readFile(hooksJsonPath, "utf8");
        const parsed = parseHooksJson(raw);
        if (!parsed) {
          logWarn("Invalid hooks.json; skipping update.", { hooksJsonPath });
          return;
        }
        config = parsed;
      } catch (error) {
        logWarn("Invalid hooks.json; skipping update.", error);
        return;
      }
    }

    if (typeof config.version !== "number") {
      config.version = 1;
      changed = true;
    }

    if (!config.hooks || !isPlainObject(config.hooks)) {
      config.hooks = {};
      changed = true;
    }

    const hooks = config.hooks;
    const afterAgent = ensureHookArray(hooks, "afterAgentResponse");
    if (addHookCommandIfMissing(afterAgent, HOOK_COMMAND_AFTER)) {
      changed = true;
    }

    const beforeSubmit = ensureHookArray(hooks, "beforeSubmitPrompt");
    if (addHookCommandIfMissing(beforeSubmit, HOOK_COMMAND_BEFORE)) {
      changed = true;
    }

    if (changed) {
      await writeJsonAtomic(hooksJsonPath, config);
    }
  });
}

function ensureHookArray(
  hooks: Record<string, Array<{ command: string }>>,
  key: string,
): Array<{ command: string }> {
  const existing = Array.isArray(hooks[key]) ? hooks[key] : [];
  if (!Array.isArray(hooks[key])) {
    hooks[key] = existing;
  }
  return existing;
}

function addHookCommandIfMissing(
  entries: Array<{ command: string }>,
  command: string,
): boolean {
  if (entries.some((entry) => entry.command === command)) {
    return false;
  }
  entries.push({ command });
  return true;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readHooksConfig(
  hooksJsonPath: string,
): Promise<{ valid: boolean; hasHookCommand: boolean }> {
  const exists = await fileExists(hooksJsonPath);
  if (!exists) {
    return { valid: true, hasHookCommand: false };
  }

  try {
    const raw = await fs.readFile(hooksJsonPath, "utf8");
    const parsed = parseHooksJson(raw);
    if (!parsed) {
      return { valid: false, hasHookCommand: false };
    }
    const afterAgent = Array.isArray(parsed.hooks?.afterAgentResponse)
      ? parsed.hooks.afterAgentResponse
      : [];
    const beforeSubmit = Array.isArray(parsed.hooks?.beforeSubmitPrompt)
      ? parsed.hooks.beforeSubmitPrompt
      : [];
    const hasHookCommand = [...afterAgent, ...beforeSubmit].some((entry) =>
      HOOK_COMMANDS.some((command) => entry.command === command),
    );
    return { valid: true, hasHookCommand };
  } catch {
    return { valid: false, hasHookCommand: false };
  }
}

async function promptToEnableHooks(
  workspacePath: string,
  context: vscode.ExtensionContext,
  hasHookCommand: boolean,
): Promise<boolean> {
  if (hasHookCommand) {
    return true;
  }

  const enabledKey = getEnabledPromptKey(workspacePath);
  const alreadyEnabled = context.globalState.get<boolean>(enabledKey, false);
  if (alreadyEnabled) {
    return true;
  }

  const skipKey = getSkipPromptKey(workspacePath);
  const skipPrompt = context.globalState.get<boolean>(skipKey, false);
  if (skipPrompt) {
    return false;
  }

  const enableLabel = "Enable notifications";
  const skipLabel = "Not now";
  const choice = await vscode.window.showInformationMessage(
    "Enable Cursor Agent notifications for this folder?",
    {
      modal: true,
      detail: "This will create .cursor/hooks.json and add a hook.",
    },
    enableLabel,
    skipLabel,
  );

  if (choice === enableLabel) {
    await context.globalState.update(enabledKey, true);
    await context.globalState.update(skipKey, false);
    return true;
  }

  if (choice === skipLabel) {
    await context.globalState.update(skipKey, true);
  }

  return false;
}

function getEnabledPromptKey(workspacePath: string): string {
  return `cursor-notifier.enabledPrompt:${workspacePath}`;
}

function getSkipPromptKey(workspacePath: string): string {
  return `cursor-notifier.skipPrompt:${workspacePath}`;
}

function getSetting<T>(key: string, defaultValue: T): T {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<T>(key, defaultValue);
}

async function updateSetting<T>(key: string, value: T): Promise<void> {
  await vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .update(key, value, vscode.ConfigurationTarget.Global);
}

type WorkspaceConfig = {
  telegram: {
    enabled: boolean;
    botToken: string;
    chatId: string;
    minDuration: string;
    includeFullResponse: boolean;
  };
};

function buildWorkspaceConfig(): WorkspaceConfig {
  const minDurationSetting = getSetting<unknown>("telegram.minDuration", "");
  const minDuration =
    typeof minDurationSetting === "string" ? minDurationSetting.trim() : "";

  return {
    telegram: {
      enabled: getSetting("telegram.enabled", false),
      botToken: getSetting("telegram.botToken", ""),
      chatId: getSetting("telegram.chatId", ""),
      minDuration,
      includeFullResponse: getSetting("telegram.includeFullResponse", false),
    },
  };
}

async function syncWorkspaceConfig(workspacePath: string): Promise<void> {
  const cursorDir = path.join(workspacePath, ".cursor");
  const configPath = path.join(cursorDir, CONFIG_FILE_NAME);
  const config = buildWorkspaceConfig();
  await writeJsonFileAtomic(configPath, config);
}

function updateStatusBar(item: vscode.StatusBarItem, enabled: boolean): void {
  if (enabled) {
    item.text = "Cursor Notifier: On";
    item.tooltip = "Agent notifications enabled. Click to disable.";
    return;
  }

  item.text = "Cursor Notifier: Off";
  item.tooltip = "Agent notifications disabled. Click to enable.";
}

async function isAnyWorkspaceEnabled(
  workspaceFolders: readonly vscode.WorkspaceFolder[],
): Promise<boolean> {
  const states = await Promise.all(
    workspaceFolders.map((folder) =>
      readHooksConfig(path.join(folder.uri.fsPath, ".cursor", "hooks.json")),
    ),
  );
  return states.some((state) => state.valid && state.hasHookCommand);
}

async function setWorkspaceHookEnabled(
  workspacePath: string,
  context: vscode.ExtensionContext,
  enabled: boolean,
): Promise<boolean> {
  if (enabled) {
    return ensureCursorHook(workspacePath, context, false);
  }

  const hooksJsonPath = path.join(workspacePath, ".cursor", "hooks.json");
  const existingConfig = await readHooksConfig(hooksJsonPath);
  if (!existingConfig.valid) {
    logWarn("Invalid hooks.json; skipping update.", { hooksJsonPath });
    return false;
  }

  await removeHookCommand(hooksJsonPath);
  return false;
}

async function removeHookCommand(hooksJsonPath: string): Promise<void> {
  await withHooksJsonLock(hooksJsonPath, async () => {
    const exists = await fileExists(hooksJsonPath);
    if (!exists) {
      return;
    }

    let config: HooksConfig = {};

    try {
      const raw = await fs.readFile(hooksJsonPath, "utf8");
      const parsed = parseHooksJson(raw);
      if (!parsed) {
        logWarn("Invalid hooks.json; skipping update.", { hooksJsonPath });
        return;
      }
      config = parsed;
    } catch (error) {
      logWarn("Invalid hooks.json; skipping update.", error);
      return;
    }

    const hooks = config.hooks;
    const existingAfter = Array.isArray(hooks?.afterAgentResponse)
      ? (hooks?.afterAgentResponse ?? [])
      : [];
    const existingBefore = Array.isArray(hooks?.beforeSubmitPrompt)
      ? (hooks?.beforeSubmitPrompt ?? [])
      : [];

    const filteredAfter = existingAfter.filter(
      (entry) => !HOOK_COMMANDS.some((command) => entry.command === command),
    );
    const filteredBefore = existingBefore.filter(
      (entry) => !HOOK_COMMANDS.some((command) => entry.command === command),
    );

    if (
      filteredAfter.length === existingAfter.length &&
      filteredBefore.length === existingBefore.length
    ) {
      return;
    }

    if (!config.hooks) {
      config.hooks = {};
    }
    if (Array.isArray(existingAfter)) {
      config.hooks.afterAgentResponse = filteredAfter;
    }
    if (Array.isArray(existingBefore)) {
      config.hooks.beforeSubmitPrompt = filteredBefore;
    }

    await writeJsonAtomic(hooksJsonPath, config);
  });
}

async function removeWorkspaceHookOnDeactivate(
  workspacePath: string,
  context: vscode.ExtensionContext,
): Promise<void> {
  const hooksJsonPath = path.join(workspacePath, ".cursor", "hooks.json");
  try {
    await removeHookCommand(hooksJsonPath);
  } catch (error) {
    logWarn("Failed to remove hook command on deactivation.", error);
  }

  try {
    await removeHookScriptIfOwned(workspacePath, context);
  } catch (error) {
    logWarn("Failed to remove hook script on deactivation.", error);
  }
}

async function removeHookScriptIfOwned(
  workspacePath: string,
  context: vscode.ExtensionContext,
): Promise<void> {
  const hooksDir = path.join(workspacePath, ".cursor", "hooks");
  await Promise.all(
    HOOK_SCRIPTS.map(async (script) => {
      const destHookPath = path.join(hooksDir, script);
      if (!(await fileExists(destHookPath))) {
        return;
      }

      const srcHookPath = context.asAbsolutePath(
        path.join(".cursor", "hooks", script),
      );
      if (!(await fileExists(srcHookPath))) {
        logWarn("Missing bundled hook script; skipping cleanup.", {
          srcHookPath,
        });
        return;
      }

      const [srcContent, destContent] = await Promise.all([
        fs.readFile(srcHookPath, "utf8"),
        fs.readFile(destHookPath, "utf8"),
      ]);

      if (srcContent !== destContent) {
        logWarn("Hook script differs from bundled version; leaving as-is.", {
          destHookPath,
        });
        return;
      }

      await fs.unlink(destHookPath);
    }),
  );
}

type HooksConfig = {
  version?: number;
  hooks?: Record<string, Array<{ command: string }>>;
};

function buildHookCommand(scriptName: string): string {
  const nodePath = process.execPath || "node";
  const safeNode = sanitizeCommandPath(nodePath);
  return `${safeNode} .cursor/hooks/${scriptName}`;
}

function sanitizeCommandPath(value: string): string {
  if (/[\r\n\0`$&|;<>]/.test(value)) {
    logWarn("Unexpected Node path; falling back to 'node'.", { value });
    return "node";
  }
  if (!value.includes(" ")) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function parseHooksJson(raw: string): HooksConfig | null {
  const parsed = JSON.parse(raw);
  if (!isPlainObject(parsed)) {
    return null;
  }

  const hooksValue = parsed.hooks;
  if (hooksValue !== undefined && !isPlainObject(hooksValue)) {
    return null;
  }

  const hooksRecord = hooksValue as Record<string, unknown> | undefined;
  const afterAgent = hooksRecord?.afterAgentResponse;
  if (afterAgent !== undefined && !Array.isArray(afterAgent)) {
    return null;
  }

  const entries: unknown[] = Array.isArray(afterAgent) ? afterAgent : [];
  if (
    entries.some(
      (entry) => !isPlainObject(entry) || typeof entry.command !== "string",
    )
  ) {
    return null;
  }

  return parsed as HooksConfig;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function logWarn(message: string, details?: unknown): void {
  if (!outputChannel) {
    console.warn("[cursor-notifier]", message, details ?? "");
    return;
  }
  outputChannel.appendLine(`[warn] ${message}`);
  if (details) {
    outputChannel.appendLine(formatDetails(details));
  }
}

function formatDetails(details: unknown): string {
  if (details instanceof Error) {
    return details.stack ?? details.message;
  }
  if (typeof details === "string") {
    return details;
  }
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === code
  );
}

async function withHooksJsonLock(
  hooksJsonPath: string,
  action: () => Promise<void>,
): Promise<void> {
  const lockPath = `${hooksJsonPath}.lock`;
  for (let attempt = 0; attempt <= LOCK_MAX_RETRIES; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx");
      try {
        await action();
      } finally {
        await handle.close();
        await fs.unlink(lockPath).catch(() => undefined);
      }
      return;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) {
        throw error;
      }
      if (attempt === LOCK_MAX_RETRIES) {
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      await sleep(LOCK_RETRY_DELAY_MS);
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeJsonAtomic(
  hooksJsonPath: string,
  config: HooksConfig,
): Promise<void> {
  const serialized = JSON.stringify(config, null, 2) + "\n";
  const tempPath = `${hooksJsonPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.mkdir(path.dirname(hooksJsonPath), { recursive: true });
    await fs.writeFile(tempPath, serialized, "utf8");
    await fs.rename(tempPath, hooksJsonPath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    logWarn("Failed to write hooks.json.", error);
    throw error;
  }
}

async function writeJsonFileAtomic(
  filePath: string,
  payload: unknown,
): Promise<void> {
  const serialized = JSON.stringify(payload, null, 2) + "\n";
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(tempPath, serialized, "utf8");
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    logWarn("Failed to write config file.", error);
    throw error;
  }
}

async function ensureGitignoreEntries(workspacePath: string): Promise<void> {
  const gitignorePath = path.join(workspacePath, ".gitignore");
  let content = "";

  if (await fileExists(gitignorePath)) {
    content = await fs.readFile(gitignorePath, "utf8");
  }

  const lines = content.split(/\r?\n/);
  const entries = new Set(
    lines
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#")),
  );

  if (isCursorHooksIgnored(entries)) {
    return;
  }

  const missing = GITIGNORE_ENTRIES.filter((entry) => !entries.has(entry));
  if (missing.length === 0) {
    return;
  }

  if (content.trim().length > 0 && lines[lines.length - 1] !== "") {
    lines.push("");
  }

  lines.push(...missing);
  await fs.writeFile(gitignorePath, `${lines.join("\n")}\n`, "utf8");
}

function isCursorHooksIgnored(entries: Set<string>): boolean {
  const ignoreCandidates = [
    ".cursor",
    ".cursor/",
    ".cursor/**",
    ".cursor/hooks",
    ".cursor/hooks/",
    ".cursor/hooks/**",
  ];

  return ignoreCandidates.some((candidate) => entries.has(candidate));
}

async function isDirectory(targetPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}
