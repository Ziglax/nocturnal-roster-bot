// Roster management: /roster add|edit|remove|export
// - Column A stores the user's current Discord display name (text).
// - Column A note stores: "Discord ID: <id>" (primary key).
// - Class columns (D..R) store "Name (Level)" or "Name (M-<Level>)" / "Name (M2-<Level>)".
//   When a URL is provided, the cell is stored as =HYPERLINK("url","Name (Level)") so the
//   displayed name is clickable in Sheets.
// - Class-cell note stores "AA: <n>" and "Access: <csv>".
// - Access labels are loaded from access.txt; selection is done via an ephemeral multi-select menu with action buttons.
// - /roster export replaces the "Raw Discord Data" sheet with guild members data (handled in exportRoster.js).

import {
  ROSTER_SHEET_NAME, colIndexToA1,
  findRowByDiscordIdOrDisplayName, appendRosterRow,
  readSingleCellNoteA1, writeSingleCellNoteByRC, updateCellA1,
  upsertNoteLines, ensureIdentityOnColumnA, getRosterSheetId,
  readCellValueA1, readRangeValuesA1, batchUpdateCells
} from "./sheets.js";
import { cfg } from "./config.js";
import {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags
} from "discord.js";
import { handleRosterExport } from "./exportRoster.js";
import { log } from "./logger.js";

// ---- Constants ----
const CLASS_LIST = [
  "Bard","Cleric","Druid","Enchanter","Magician","Monk","Necromancer","Paladin",
  "Ranger","Rogue","Shadow Knight","Shaman","Warrior","Wizard","Beastlord"
];

// ---- Slash command schema ----
export const rosterCommandJSON = new SlashCommandBuilder()
  .setName("roster")
  .setDescription("Manage your guild roster")
  // add
  .addSubcommand(sub => sub
    .setName("add")
    .setDescription("Add or upsert a character in your roster row")
    .addStringOption(o => o.setName("name").setDescription("Character name").setRequired(true))
    .addStringOption(o => o.setName("class").setDescription("Class").setRequired(true)
      .addChoices(...CLASS_LIST.map(c => ({ name: c, value: c }))))
    .addIntegerOption(o => o.setName("level").setDescription("Level 1–65").setRequired(true).setMinValue(1).setMaxValue(65))
    .addIntegerOption(o => o.setName("aa").setDescription("Alternate Abilities 1–1000").setRequired(false).setMinValue(1).setMaxValue(1000))
    .addStringOption(o => o.setName("quarmy_link").setDescription("Quarmy character page (must start with https://quarmy.com) — makes the cell name clickable").setRequired(false))
  )
  // edit
  .addSubcommand(sub => sub
    .setName("edit")
    .setDescription("Edit an existing character in your roster row")
    .addStringOption(o => o.setName("name").setDescription("Character name").setRequired(true))
    .addStringOption(o => o.setName("class").setDescription("Class").setRequired(true)
      .addChoices(...CLASS_LIST.map(c => ({ name: c, value: c }))))
    .addIntegerOption(o => o.setName("level").setDescription("Level 1–65").setRequired(true).setMinValue(1).setMaxValue(65))
    .addIntegerOption(o => o.setName("aa").setDescription("Alternate Abilities 1–1000").setRequired(false).setMinValue(1).setMaxValue(1000))
    .addStringOption(o => o.setName("quarmy_link").setDescription("Quarmy character page (https://quarmy.com/...). Leave empty to keep the existing one").setRequired(false))
  )
  // remove
  .addSubcommand(sub => sub
    .setName("remove")
    .setDescription("Remove a character from your roster row")
    .addStringOption(o => o.setName("name").setDescription("Character name").setRequired(true))
  )
  // export
  .addSubcommand(sub => sub
    .setName("export")
    .setDescription("Replace 'Raw Discord Data' with current guild members"))
  .toJSON();

// ---- Access helpers ----
function parseAccessFromNote(note) {
  const m = (note || "").match(/^\s*Access\s*:\s*(.+)\s*$/mi);
  if (!m) return [];
  return m[1].split(",").map(s => s.trim()).filter(Boolean);
}

// ---- URL helpers ----
const QUARMY_HOST = "quarmy.com";

function validateQuarmyLink(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return { error: "Link must use https." };
    // Strict host equality to avoid e.g. quarmy.com.malicious.tld passing a startsWith check.
    if (u.host !== QUARMY_HOST) return { error: `Link must start with https://${QUARMY_HOST}/` };
    return { url: u.toString() };
  } catch {
    return { error: "Not a valid URL." };
  }
}

// Cell formula: =HYPERLINK("url","display"). Quotes inside Sheets formula strings
// are escaped by doubling them.
function escapeForFormula(s) {
  return String(s).replace(/"/g, '""');
}

function composeCellValue(charName, level, modPrefix, url) {
  const text = `${charName} (${modPrefix || ""}${level})`;
  if (!url) return text;
  return `=HYPERLINK("${escapeForFormula(url)}","${escapeForFormula(text)}")`;
}

// Parses a class cell raw value (read with valueRenderOption=FORMULA).
// Returns { displayText, url, modPrefix }.
function parseClassCellRaw(raw) {
  const linkMatch = (raw || "").match(/^=HYPERLINK\(\s*"((?:[^"]|"")*)"\s*,\s*"((?:[^"]|"")*)"\s*\)\s*$/i);
  let displayText, url = null;
  if (linkMatch) {
    url = linkMatch[1].replace(/""/g, '"');
    displayText = linkMatch[2].replace(/""/g, '"');
  } else {
    displayText = raw || "";
  }
  const m = displayText.match(/^\s*.*?\s*\(\s*(M2?-)?(\d{1,3})\s*\)\s*$/i);
  const modPrefix = (m && m[1]) ? m[1] : "";
  return { displayText, url, modPrefix };
}

// Ephemeral multi-select with action buttons: Save / Keep current / Clear.
// Uses a persistent collector (not awaitMessageComponent) so rapid successive clicks
// are queued instead of dropped between iterations.
//
// Returns:
//   - "save"  → returns the array selected at click time (may be empty → Access cleared)
//   - "keep"  → returns the original preselected array
//   - "clear" then "save" → returns []
//   - timeout → returns the original preselected array, sentinel { _timedOut: true } on the array
//
// The caller distinguishes "Save with empty" (explicit clear) from timeout by checking
// the returned array's _timedOut flag.
async function askAccessMenu(interaction, preselected = []) {
  const buildSelectComponent = (selected) => {
    const options = cfg.access.list.map(label => {
      const opt = new StringSelectMenuOptionBuilder().setLabel(label).setValue(label);
      if (selected.includes(label)) opt.setDefault(true);
      return opt;
    });
    return new StringSelectMenuBuilder()
      .setCustomId("access-select")
      .setPlaceholder("Select access labels (optional)")
      .setMinValues(0)
      .setMaxValues(Math.max(1, Math.min(options.length, 25)))
      .setOptions(options);
  };

  const btnSave  = new ButtonBuilder().setCustomId("access-save").setLabel("Save").setStyle(ButtonStyle.Primary);
  const btnKeep  = new ButtonBuilder().setCustomId("access-keep").setLabel("Keep current").setStyle(ButtonStyle.Secondary);
  const btnClear = new ButtonBuilder().setCustomId("access-clear").setLabel("Clear").setStyle(ButtonStyle.Danger);

  const renderRows = (selected) => [
    new ActionRowBuilder().addComponents(buildSelectComponent(selected)),
    new ActionRowBuilder().addComponents(btnSave, btnKeep, btnClear),
  ];

  let current = [...preselected];

  const msg = await interaction.followUp({
    content: "Access selection:",
    components: renderRows(current),
    flags: MessageFlags.Ephemeral
  });

  return await new Promise((resolve) => {
    let settled = false;

    const safeAck = async (i, payload) => {
      // already handled by another path → just try to refresh the message visually
      if (i.replied || i.deferred) {
        if (payload) { try { await msg.edit(payload); } catch {} }
        return;
      }
      try {
        if (payload) await i.update(payload);
        else await i.deferUpdate();
      } catch (err) {
        const stale = err?.code === 10062 || err?.code === 40060;
        if (!stale) console.warn("[access-menu] ack failed:", err?.message || err);
        else console.warn(`[access-menu] interaction stale (${err.code}) — falling back to msg.edit`);
        if (payload) { try { await msg.edit(payload); } catch {} }
      }
    };

    const collector = msg.createMessageComponentCollector({
      filter: (i) => i.user.id === interaction.user.id,
      time: 60_000,
    });

    const settle = (value) => {
      if (settled) return;
      settled = true;
      collector.stop("settled");
      resolve(value);
    };

    collector.on("collect", async (i) => {
      try {
        if (settled) { await safeAck(i); return; }

        if (i.componentType === ComponentType.StringSelect && i.customId === "access-select") {
          current = i.values;
          await safeAck(i);
          return;
        }

        if (i.componentType === ComponentType.Button) {
          if (i.customId === "access-save") {
            const n = current.length;
            await safeAck(i, {
              content: n ? `Access captured (${n} label${n > 1 ? "s" : ""}).` : "Access cleared.",
              components: []
            });
            settle(current);
            return;
          }
          if (i.customId === "access-keep") {
            await safeAck(i, { content: "Access unchanged.", components: [] });
            settle(preselected);
            return;
          }
          if (i.customId === "access-clear") {
            current = [];
            await safeAck(i, {
              content: "Access selection: (cleared) — click **Save** to confirm.",
              components: renderRows(current)
            });
            return;
          }
        }
      } catch (err) {
        console.error("[access-menu] handler error:", err);
      }
    });

    collector.on("end", async () => {
      if (settled) return;
      settled = true;
      try { await msg.edit({ content: "Access selection timed out — no change applied.", components: [] }); } catch {}
      const out = [...preselected];
      out._timedOut = true;
      resolve(out);
    });
  });
}

// ---- Cell payload builder (preserves M-/M2- and URL on edit) ----
// urlOpt: string (provided this command, overrides existing) | null (not provided, preserve existing on edit)
// Returns: { cellValue, displayLabel, url }
async function buildCellPayload(classCol, rowNumber, charName, level, isEdit, urlOpt) {
  let modPrefix = "";
  let url = urlOpt;

  if (isEdit) {
    const a1 = `${ROSTER_SHEET_NAME}!${classCol}${rowNumber}:${classCol}${rowNumber}`;
    // FORMULA mode is required to detect an existing =HYPERLINK(...) cell.
    const raw = await readCellValueA1(a1, "FORMULA");
    const parsed = parseClassCellRaw(raw);
    modPrefix = parsed.modPrefix;
    if (urlOpt === null) url = parsed.url; // user didn't provide one this time → preserve
  }

  const displayLabel = `${charName} (${modPrefix}${level})`;
  return {
    cellValue: composeCellValue(charName, level, modPrefix, url),
    displayLabel,
    url: url || null,
  };
}

// ---- Handler ----
export async function handleRosterInteraction(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "roster") return;

  const sub = interaction.options.getSubcommand();

  // Delegate export early (it gère son propre deferReply)
  if (sub === "export") {
    const handled = await handleRosterExport(interaction);
    if (handled) return;
  }

  // Defer immediately to avoid Unknown interaction if operations take >3s
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
  } catch (err) {
    if (err?.code === 10062) { // Unknown interaction
      console.warn("[roster] Interaction expired before deferReply");
      return;
    }
    throw err;
  }

  if (sub === "add" || sub === "edit") {
    const displayName = (interaction.member?.displayName || interaction.user.username).trim();
    const discordId   = interaction.user.id;

    let { rowNumber } = await findRowByDiscordIdOrDisplayName(discordId, displayName);

    if (!rowNumber) {
      if (sub === "add") {
        rowNumber = await appendRosterRow(displayName);
      } else {
        await interaction.editReply({ content: "No row found. Use `/roster add`." });
        return;
      }
    }

    await ensureIdentityOnColumnA(rowNumber, displayName, discordId);

    const charName = interaction.options.getString("name", true);
    const klass = interaction.options.getString("class", true);
    const level = interaction.options.getInteger("level", true);
    const linkInput = interaction.options.getString("quarmy_link");

    let urlOpt = null; // null = "not provided this command"
    if (linkInput !== null) {
      const v = validateQuarmyLink(linkInput);
      if (v?.error) {
        await interaction.editReply({ content: `Invalid Quarmy link: ${v.error}` });
        return;
      }
      urlOpt = v.url;
    }

    const classIndex1 = 4 + CLASS_LIST.indexOf(klass);
    if (classIndex1 < 4) {
      await interaction.editReply({ content: `Class "${klass}" is not recognized.` });
      return;
    }
    const classCol = colIndexToA1(classIndex1);

    const { cellValue, displayLabel, url: finalUrl } =
      await buildCellPayload(classCol, rowNumber, charName, level, sub === "edit", urlOpt);
    await updateCellA1(`${ROSTER_SHEET_NAME}!${classCol}${rowNumber}`, cellValue);

    const oldClassNote = await readSingleCellNoteA1(`${ROSTER_SHEET_NAME}!${classCol}${rowNumber}:${classCol}${rowNumber}`);
    const aa = interaction.options.getInteger("aa") || null;

    const preselected = sub === "edit" ? parseAccessFromNote(oldClassNote) : [];
    const picked = await askAccessMenu(interaction, preselected);
    const accessJoined = picked.join(", ");

    // Build note. AA: omit from kv if not provided this command (preserve existing).
    // Access: if user clicked Save with empty selection → null deletes the line.
    //         If timeout → preserve existing (preselected was returned).
    const noteKv = {};
    if (aa) noteKv["AA"] = aa;
    if (picked._timedOut) {
      // timeout → don't touch Access at all
    } else if (picked.length) {
      noteKv["Access"] = accessJoined;
    } else {
      noteKv["Access"] = null; // explicit clear
    }
    const newClassNote = upsertNoteLines(oldClassNote, noteKv);

    const sheetId = await getRosterSheetId();
    await writeSingleCellNoteByRC(sheetId, rowNumber - 1, classIndex1 - 1, newClassNote);

    log.event(`roster.${sub}`, {
      user: displayName,
      userId: discordId,
      row: rowNumber,
      char: charName,
      class: klass,
      level,
      aa: aa || undefined,
      access: picked.length ? picked.join(",") : undefined,
      url: finalUrl || undefined,
    });

    const linkInfo = finalUrl ? ` • <${finalUrl}>` : "";
    await interaction.editReply({
      content: `${sub === "add" ? "Saved" : "Updated"} • ${klass}: \`${displayLabel}\`${linkInfo}${aa ? ` • AA=${aa}` : ""}${picked.length ? ` • Access=[${accessJoined}]` : ""}`
    });
    return;
  }

  if (sub === "remove") {
    const displayName = (interaction.member?.displayName || interaction.user.username).trim();
    const discordId   = interaction.user.id;

    let { rowNumber } = await findRowByDiscordIdOrDisplayName(discordId, displayName);
    if (!rowNumber) {
      await interaction.editReply({ content: "No row found." });
      return;
    }
    await ensureIdentityOnColumnA(rowNumber, displayName, discordId);

    const name = interaction.options.getString("name", true);
    const vals = await readRangeValuesA1(`${ROSTER_SHEET_NAME}!D${rowNumber}:R${rowNumber}`);
    const rowVals = vals[0] || [];
    const sheetId = await getRosterSheetId();
    const row0 = rowNumber - 1;
    const requests = [];
    for (let i = 0; i < CLASS_LIST.length; i++) {
      const val = (rowVals[i] || "").trim();
      if (val.toLowerCase().startsWith((name + " (").toLowerCase())) {
        const col0 = 3 + i; // D = column index 3 (0-based)
        requests.push({
          updateCells: {
            range: { sheetId, startRowIndex: row0, endRowIndex: row0 + 1, startColumnIndex: col0, endColumnIndex: col0 + 1 },
            // Empty userEnteredValue + empty note clears both in one round-trip.
            rows: [{ values: [{ userEnteredValue: {}, note: "" }] }],
            fields: "userEnteredValue,note"
          }
        });
      }
    }
    if (!requests.length) {
      await interaction.editReply({ content: `Nothing to remove for **${name}**.` });
      return;
    }
    await batchUpdateCells(requests);

    log.event("roster.remove", {
      user: displayName,
      userId: discordId,
      row: rowNumber,
      char: name,
      cellsCleared: requests.length,
    });

    await interaction.editReply({ content: `Removed **${name}** from your row (${requests.length} cell${requests.length > 1 ? "s" : ""} cleared, notes included).` });
    return;
  }
}
