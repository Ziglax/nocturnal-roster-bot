# Nocturnal Roster Bot — AGENTS.md

## Project Overview

Discord bot for the Nocturnal guild on the Quarm EverQuest private server. It manages a guild roster in Google Sheets and backs up attachments to Google Drive.

## Architecture

```
index.js              — Entry point: starts health server, registers slash commands, starts bot
src/
  config.js           — Reads env vars + access.txt, exports cfg + assertEnv()
  discordClient.js    — Discord client setup, slash command registration, attachment backup hookup
  sheets.js           — Google Sheets API wrapper with retry logic, cell read/write/note helpers
  roster.js           — /roster command handler (add/edit/remove), access label interactive menu
  exportRoster.js     — /roster export handler (officer-only guild member dump to sheet)
  backups.js          — Watches Discord channels, downloads .json/.zip, uploads to Google Drive
  backupSelftest.js   — /backup test command (officer-only permission check)
  googleClients.js    — JWT-authenticated sheets + drive API clients
  logger.js           — Simple file+console logger
  health.js           — Express health endpoint on :3000
access.txt            — Access labels shown in the roster menu (one per line, max 25)
env                   — Template for .env
```

## Key Conventions

- **ESM only** — `"type": "module"` in package.json. All imports use `import`/`export`.
- **Google API retries** — Use `withRetry(fn, label, attempts)` from `sheets.js` for all Google API calls. Retries on network errors (ECONNRESET, ETIMEDOUT, etc.) and 408/409/429/5xx status codes.
- **Roster sheet** — Tab named "Roster". Column A = Discord display names with notes storing "Discord ID: <id>". Columns D-R = 15 EQ classes.
- **Cell notes for metadata** — AA count and access labels are stored in class-cell notes, not separate columns. Notes use a `Key: value` format per line. Use `upsertNoteLines()` and `writeCellValueAndNoteByRC()` for efficient single-roundtrip writes.
- **Hyperlinks** — Quarmy profile URLs are stored as `=HYPERLINK("url","display")` formulas. Use `parseClassCellRaw()` to read them back and `composeCellValue()`/`escapeForFormula()` to build them.
- **Discord identity as primary key** — Users are identified by Discord ID (stored in cell note), not by username. Display name in column A is updated on each interaction via `ensureIdentityOnColumnA()`.
- **Ephemeral interactions** — All roster commands reply ephemerally. Use `MessageFlags.Ephemeral` (not `ephemeral: true`).
- **Access control** — `access.txt` defines selectable labels. Officers are identified by having a role named exactly "Officer".
- **Logging** — Use `log.info/warn/error/event` from `logger.js`. Events are structured with a name and context object.
- **No comments in code** — Keep it clean. Let the code speak.

## Common Tasks

### Adding a new slash command

1. Create a new file in `src/` (e.g. `src/mycommand.js`).
2. Export `myCommandJSON` (built with `SlashCommandBuilder().toJSON()`) and a handler function.
3. Import both in `discordClient.js`:
   - Add `myCommandJSON` to the `body` array in `registerCommands()`.
   - Add a `client.on("interactionCreate", handleMyCommand)` in `startBot()`.
4. The handler should check `interaction.isChatInputCommand()` and the command name.

### Adding a new Google Sheets operation

Add the function to `sheets.js`. Always wrap Google API calls with `withRetry()`. Use `batchUpdateCells()` for bulk writes to minimize round-trips. For combined value+note writes, use `writeCellValueAndNoteByRC()`.

### Adding a new access label

Just add a new line to `access.txt`. No code changes needed. Max 25 labels.

## Running

```bash
npm ci
npm start
```

Environment comes from `.env` (copy from `env` template). Docker: `docker compose up -d`.

## Important Gotchas

- The bot requires the **Server Members Intent** enabled in the Discord Developer Portal for `/roster export` to work.
- Google private key can be provided as `GOOGLE_PRIVATE_KEY` (with literal `\n`) or as `GOOGLE_PRIVATE_KEY_BASE64`.
- `access.txt` is read once at startup. The bot must be restarted to pick up changes.
- The `REGISTER_MODE` env var controls how slash commands are registered. `guild-purge` is safe for dev (removes stale global commands first). `global` takes up to 1 hour to propagate.
- Attachment backups use a `Set` for deduplication (in-memory only; resets on restart).
