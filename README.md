## Cursor Notifier (macOS)

macOS notifications when a Cursor Agent/Composer response finishes, using the official `afterAgentResponse` hook.

### Quick start (extension)

1. Install the extension.
2. Open a project. The extension will prompt you to add the hook for that workspace.
3. Enable hooks in Cursor (Settings → Hooks).

The extension does not overwrite an existing hook script if you already modified it.
When you disable the extension, it removes only the hook command; the script is
kept in place. The next activation can add the command back (with a prompt).

### Install from VSIX

If you have the packaged file `cursor-notifier-0.1.11.vsix`:

1. In Cursor, open the Command Palette.
2. Run **Extensions: Install from VSIX...** and select the file.
3. Reload Cursor when prompted.

### Requirements

- macOS (notifications use `/usr/bin/osascript`) or Windows (PowerShell toast notifications)
- Node.js available for hook execution (Cursor uses the Node runtime path when creating hooks)
- Cursor hooks enabled for the workspace

### Extension settings

- `cursor-notifier.enabled` (default: true) — master switch for the extension; when disabled, the hook command is removed.
- `cursor-notifier.autoIgnoreGitFiles` (default: true) — add hook files to `.gitignore` when enabling.
- `cursor-notifier.telegram.enabled` (default: false) — enable Telegram notifications.
- `cursor-notifier.telegram.botToken` — Telegram bot token used to send notifications.
- `cursor-notifier.telegram.chatId` — Telegram chat ID where notifications are sent.
- `cursor-notifier.telegram.minDuration` — minimal task duration in `MM:SS` before sending Telegram notification; if empty, Telegram notification is sent for any duration.
- `cursor-notifier.telegram.includeFullResponse` (default: false) — send full agent response to Telegram in additional message parts.

### Build / package

```bash
npm install
npm run build
```

To create a VSIX package:

```bash
npm run package
```

### Development

1. Install dependencies: `npm install`.
2. Open the repo in Cursor.
3. Run the extension in Extension Development Host (e.g. `F5`).

### Hook details: afterAgentResponse

The extension package includes hook assets:

- `assets/hooks/after-agent-response.cjs`
- `assets/hooks/before-submit-prompt.cjs`

The hook runs on `afterAgentResponse` and shows a macOS notification.
You can customize the text with environment variables:

- `CURSOR_NOTIFY_TITLE` (default: `Cursor`)
- `CURSOR_NOTIFY_MESSAGE` (default: `Agent finished`)
- `CURSOR_NOTIFY_STATUS` (default: `OK`)

Example customization:

```bash
CURSOR_NOTIFY_TITLE="Cursor Agent" \
CURSOR_NOTIFY_MESSAGE="Agent finished with {status}" \
CURSOR_NOTIFY_STATUS="OK"
```

### Telegram notifications (minimum duration)

Telegram notifications are sent only after the agent finishes.
Duration is measured using `beforeSubmitPrompt` (start) and `afterAgentResponse` (finish).

To enable:

1. Set `cursor-notifier.telegram.enabled` to `true`.
2. Set `cursor-notifier.telegram.botToken` and `cursor-notifier.telegram.chatId`.
3. Optionally set `cursor-notifier.telegram.minDuration` in `MM:SS` format (e.g. `01:30`).
4. Optionally set `cursor-notifier.telegram.includeFullResponse` to `true` to send the full agent response in additional Telegram message parts.
5. If `cursor-notifier.telegram.minDuration` is empty, Telegram message is sent for any task duration.

### Uninstall / disable

To remove notifications for a workspace:

1. Open `.cursor/hooks.json` and remove both entries: `afterAgentResponse` and `beforeSubmitPrompt`.
2. Optionally delete `.cursor/hooks/after-agent-response.cjs` and `.cursor/hooks/before-submit-prompt.cjs`.
3. Optionally delete `.cursor/cursor-notifier.json` and `.cursor/cursor-notifier-start.json`.
4. Disable hooks in Cursor settings if you no longer use them.

When the extension deactivates (for example, when you close the window or uninstall),
it removes its hook commands from `.cursor/hooks.json` and deletes bundled hook
scripts if they have not been modified. On the next activation, the extension can add
the hook back (it may prompt first).

### Troubleshooting

- **No notification appears**: Ensure hooks are enabled in Cursor settings and the workspace has `.cursor/hooks.json`.
- **Hook does not run**: Verify Node.js is available and the workspace has `.cursor/hooks/after-agent-response.cjs` and `.cursor/hooks/before-submit-prompt.cjs`.
- **Custom message not applied**: Check that environment variables are set in the shell or the process launching Cursor.

### Security

- No network, telemetry, or data export
- Notifications run only:
  - `/usr/bin/osascript -e 'display notification ...'`
- AppleScript strings are escaped (`"`, `\\`) and normalized.
