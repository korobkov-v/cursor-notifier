## Cursor Notifier (macOS)

macOS notifications when a Cursor Agent/Composer response finishes, using the official `afterAgentResponse` hook.

### Quick start (extension)

1. Install the extension.
2. Open a project. The extension will prompt you to add the hook for that workspace.
3. Enable hooks in Cursor (Settings → Hooks).

The extension does not overwrite an existing hook script if you already modified it.
When you disable the extension, it removes only the hook command; the script is
kept in place. The next activation can add the command back (with a prompt).

### Requirements

- macOS (notifications use `/usr/bin/osascript`) or Windows (PowerShell toast notifications)
- Node.js available for hook execution (Cursor uses the Node runtime path when creating hooks)
- Cursor hooks enabled for the workspace

### Extension settings

- `cursor-notifier.enabled` (default: true) — master switch for the extension; when disabled, the hook command is removed.
- `cursor-notifier.autoIgnoreGitFiles` (default: true) — add hook files to `.gitignore` when enabling.

### Quick start (manual)

```bash
# From the repo root (only needed for direct execution)
chmod +x .cursor/hooks/after-agent-response.js
```

Then enable hooks in Cursor and use `.cursor/hooks.json` from this repository.

### Hook details: afterAgentResponse

This repository includes:

- `.cursor/hooks.json`
- `.cursor/hooks/after-agent-response.js`

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

### Uninstall / disable

To remove notifications for a workspace:

1. Open `.cursor/hooks.json` and remove the `afterAgentResponse` entry with the command.
2. Optionally delete `.cursor/hooks/after-agent-response.js`.
3. Disable hooks in Cursor settings if you no longer use them.

When the extension deactivates (for example, when you close the window or uninstall),
it removes its hook command from `.cursor/hooks.json` and deletes the bundled hook
script if it has not been modified. On the next activation, the extension can add
the hook back (it may prompt first).

### Troubleshooting

- **No notification appears**: Ensure hooks are enabled in Cursor settings and the workspace has `.cursor/hooks.json`.
- **Hook does not run**: Verify Node.js is available and the hook script is executable (`chmod +x .cursor/hooks/after-agent-response.js`).
- **Custom message not applied**: Check that environment variables are set in the shell or the process launching Cursor.

### Security

- No network, telemetry, or data export
- Notifications run only:
  - `/usr/bin/osascript -e 'display notification ...'`
- AppleScript strings are escaped (`"`, `\\`) and normalized.
