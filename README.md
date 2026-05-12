# Nocturnal Roster Bot

A Discord bot for the **Nocturnal** guild on the **Quarm** EverQuest private server. It manages a guild roster in Google Sheets and backs up attachments to Google Drive.

## Features

- **`/roster add <name> <class> <level>`** — Add a character to your roster row. Supports optional AA count and a [Quarmy](https://quarmy.com) profile link (stored as a clickable `=HYPERLINK` formula). An interactive menu lets you assign access labels (VP, ST, Emp, VT, etc. defined in `access.txt`).
- **`/roster edit <name> <class> <level>`** — Edit an existing character. Preserves the existing Quarmy link and access labels unless overridden.
- **`/roster remove <name>`** — Remove a character from your row.
- **`/roster export`** — (Officer-only) Dumps the full Discord guild member list into a "Raw Discord Data" sheet in the same spreadsheet.
- **`/backup test`** — (Officer-only) Validates the bot can read/send messages in the configured backup channel.
- **Attachment backups** — Automatically downloads `.json`/`.zip` attachments from watched Discord channels and uploads them to Google Drive with timestamped filenames.

## Setup

### Prerequisites

- Node.js >= 18
- A Google Cloud project with the Sheets & Drive APIs enabled
- A Google service account with access to your target Sheet and Drive folder
- A Discord bot application with the following intents enabled: Guilds, Guild Messages, Message Content, Server Members
- Docker (optional, for containerized deployment)

### Environment Variables

Copy `env` to `.env` and fill in:

| Variable | Description |
|---|---|
| `DISCORD_BOT_TOKEN` | Bot token from Discord Developer Portal |
| `DISCORD_CLIENT_ID` | Application ID |
| `DISCORD_GUILD_ID` | Discord server (guild) ID |
| `DISCORD_CHANNEL_ID` | Comma-separated channel IDs to watch for attachment backups |
| `REGISTER_MODE` | `guild` (fast, dev), `global` (production, up to 1h cache), or `guild-purge` (remove global then add guild) |
| `ATTACHMENT_DELAY` | Milliseconds to wait before processing attachments (default: 800) |
| `GOOGLE_SHEET_ID` | ID of the Google Sheet (from the sheet URL) |
| `GOOGLE_CLIENT_EMAIL` | Service account email |
| `GOOGLE_PRIVATE_KEY` | Service account private key (newlines as `\n`) |
| `GDRIVE_FOLDER_ID` | Google Drive folder ID for backup uploads |

### Access Labels

Edit `access.txt` to define the labels available in the roster access menu (one per line, max 25). These are server-specific tags (e.g., raid/zone access flags).

### Google Sheet Structure

The bot expects a sheet tab named **Roster** with:
- Column A — Discord display names, with cell notes storing "Discord ID: <id>"
- Columns D–R — Class columns (Bard, Cleric, Druid, Enchanter, Magician, Monk, Necromancer, Paladin, Ranger, Rogue, Shadow Knight, Shaman, Warrior, Wizard, Beastlord)

The export command creates/uses a sheet tab named **Raw Discord Data**.

### Running

```bash
# Install dependencies
npm ci

# Start
npm start
```

### Docker

```bash
docker compose up -d
```

The bot exposes a health endpoint on port 3000 (`GET /` returns `OK`).
