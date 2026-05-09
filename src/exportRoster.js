// /roster export: replaces the "Raw Discord Data" sheet with guild members data.
// Columns: ID | Username | Display Name | Roles | User Type | Join Date
// Data is written as plain text (valueInputOption: "RAW") to avoid any conversion in Google Sheets.

import { cfg } from "./config.js";
import { MessageFlags } from "discord.js";
import { sheets } from "./googleClients.js";
import { withRetry } from "./sheets.js";

// Sheet title to write to
const RAW_SHEET_NAME = "Raw Discord Data";

// Quote a sheet title for A1 notation, handling apostrophes
function a1Sheet(title) {
  return `'${String(title).replace(/'/g, "''")}'!`;
}

// Format join date as: 2025-09-22 13:34:19.825000+00:00 (UTC)
function formatJoinDateUTC(date) {
  const d = new Date(date);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const HH = String(d.getUTCHours()).padStart(2, "0");
  const MM = String(d.getUTCMinutes()).padStart(2, "0");
  const SS = String(d.getUTCSeconds()).padStart(2, "0");
  const ms = String(d.getUTCMilliseconds()).padStart(3, "0");
  const micro = ms + "000"; // .SSS000
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}.${micro}+00:00`;
}

// Build role label like: [Server Booster,Member,Officer] (excludes @everyone, sorted by position desc)
function rolesToLabel(member) {
  const roles = member.roles.cache
    .filter(r => r.name !== "@everyone")
    .sort((a, b) => b.position - a.position)
    .map(r => r.name);
  return `[${roles.join(",")}]`;
}

// Permission check: member must have a role named exactly "Officer"
function hasOfficerRole(member) {
  return member.roles.cache.some(r => r.name === "Officer");
}

// Ensure the target sheet exists (create if missing)
async function ensureRawSheetExists() {
  const meta = await withRetry(
    () => sheets.spreadsheets.get({ spreadsheetId: cfg.google.sheetId }),
    "ensureRawSheetExists.get"
  );
  const found = meta.data.sheets?.find(s => s.properties?.title === RAW_SHEET_NAME);
  if (found) return;
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: cfg.google.sheetId,
    requestBody: {
      requests: [{ addSheet: { properties: { title: RAW_SHEET_NAME } } }]
    }
  }), "ensureRawSheetExists.addSheet");
}

export async function handleRosterExport(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "roster") return false;
  const sub = interaction.options.getSubcommand(false);
  if (sub !== "export") return false;

  if (!hasOfficerRole(interaction.member)) {
    await interaction.reply({ content: "You need the **Officer** role to run this command.", flags: MessageFlags.Ephemeral });
    return true;
  }

  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    if (err?.code === 10062) {
      console.warn("[export] Interaction expired before deferReply");
      return true;
    }
    throw err;
  }

  try {
    await interaction.guild.members.fetch(); // requires GuildMembers intent + Server Members Intent
  } catch {
    await interaction.editReply({
      content: "Cannot fetch guild members. Enable **Server Members Intent** in the Developer Portal and add `GuildMembers` intent to the client."
    });
    return true;
  }

  const header = ["ID","Username","Display Name","Roles","User Type","Join Date"];
  const rows = [];
  for (const m of interaction.guild.members.cache.values()) {
    const id = String(m.user.id);
    const username = String(m.user.username || "");
    const display = String(m.displayName || "");
    const roles = String(rolesToLabel(m));
    const userType = m.user.bot ? "Bot" : "Human";
    const joined = m.joinedAt ? formatJoinDateUTC(m.joinedAt) : "";
    rows.push([id, username, display, roles, userType, joined]);
  }

  rows.sort((a, b) => (a[5] || "").localeCompare(b[5] || ""));

  await ensureRawSheetExists();

  try {
    await withRetry(() => sheets.spreadsheets.values.clear({
      spreadsheetId: cfg.google.sheetId,
      range: `${a1Sheet(RAW_SHEET_NAME)}A:Z`
    }), "exportRoster.clear");

    await withRetry(() => sheets.spreadsheets.values.update({
      spreadsheetId: cfg.google.sheetId,
      range: `${a1Sheet(RAW_SHEET_NAME)}A1`,
      valueInputOption: "RAW", // plain text
      requestBody: { values: [header, ...rows] }
    }), "exportRoster.update");

    await interaction.editReply({ content: `Exported ${rows.length} members to '${RAW_SHEET_NAME}'.` });
  } catch (err) {
    await interaction.editReply({ content: `Export failed: ${String(err?.message || err)}` });
  }

  return true;
}
