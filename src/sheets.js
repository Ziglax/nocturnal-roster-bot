import { sheets } from "./googleClients.js";
import { cfg } from "./config.js";

export const ROSTER_SHEET_NAME = "Roster";
let rosterSheetIdCache = null;

// Retry wrapper for transient Google API failures (network blips, ABORTED, rate limits).
const RETRYABLE_CODES = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENETUNREACH", "ECONNREFUSED"]);
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export async function withRetry(fn, label = "sheets", attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const code = err?.code;
      const status = err?.response?.status ?? err?.status;
      const transient = RETRYABLE_CODES.has(code) || RETRYABLE_STATUS.has(status);
      if (!transient || i === attempts - 1) throw err;
      const wait = 250 * Math.pow(2, i) + Math.floor(Math.random() * 100);
      console.warn(`[${label}] retry ${i + 1}/${attempts - 1} in ${wait}ms (code=${code ?? "-"} status=${status ?? "-"})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

export async function getRosterSheetId() {
  if (rosterSheetIdCache) return rosterSheetIdCache;
  const res = await withRetry(
    () => sheets.spreadsheets.get({ spreadsheetId: cfg.google.sheetId }),
    "getRosterSheetId"
  );
  const sheet = res.data.sheets.find(s => s.properties.title === ROSTER_SHEET_NAME);
  if (!sheet) throw new Error(`Sheet "${ROSTER_SHEET_NAME}" not found`);
  rosterSheetIdCache = sheet.properties.sheetId;
  return rosterSheetIdCache;
}

export function colIndexToA1(colIdx1) {
  let n = colIdx1, s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

export async function getColumnAValuesAndNotes() {
  const res = await withRetry(() => sheets.spreadsheets.get({
    spreadsheetId: cfg.google.sheetId,
    ranges: [`${ROSTER_SHEET_NAME}!A:A`],
    includeGridData: true,
  }), "getColumnAValuesAndNotes");
  const data = res.data.sheets?.[0]?.data?.[0]?.rowData || [];
  const out = [];
  for (let i = 0; i < data.length; i++) {
    const cell = data[i]?.values?.[0] || {};
    out.push({
      rowNumber: i + 1,
      valueText: (cell.formattedValue || "").trim(),
      noteText:  (cell.note || "").trim()
    });
  }
  return out;
}

export function getDiscordIdFromNote(note) {
  const m = (note || "").match(/^\s*Discord ID\s*:\s*(\d+)\s*$/mi);
  return m ? m[1] : null;
}

export async function findRowByDiscordIdOrDisplayName(discordId, displayName) {
  const rows = await getColumnAValuesAndNotes();
  for (const r of rows) {
    const idInNote = getDiscordIdFromNote(r.noteText);
    if (idInNote && idInNote === String(discordId)) {
      return { rowNumber: r.rowNumber, foundBy: "id" };
    }
  }
  for (const r of rows) {
    if (r.valueText && r.valueText === displayName) {
      return { rowNumber: r.rowNumber, foundBy: "name" };
    }
  }
  return { rowNumber: null, foundBy: null };
}

export async function appendRosterRow(displayName) {
  const res = await withRetry(() => sheets.spreadsheets.values.append({
    spreadsheetId: cfg.google.sheetId,
    range: `${ROSTER_SHEET_NAME}!A:A`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[displayName]] },
  }), "appendRosterRow");
  const updated = res.data.updates?.updatedRange || "";
  const m = updated.match(/!(?:[A-Z]+)(\d+):/);
  if (m) return parseInt(m[1], 10);
  const rows = await getColumnAValuesAndNotes();
  const f = rows.find(r => r.valueText === displayName);
  return f ? f.rowNumber : null;
}

export async function updateCellA1(a1, value) {
  await withRetry(() => sheets.spreadsheets.values.update({
    spreadsheetId: cfg.google.sheetId,
    range: a1,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] },
  }), "updateCellA1");
}

export async function readSingleCellNoteA1(a1) {
  const res = await withRetry(() => sheets.spreadsheets.get({
    spreadsheetId: cfg.google.sheetId,
    ranges: [a1],
    includeGridData: true,
  }), "readSingleCellNoteA1");
  const v = res.data.sheets?.[0]?.data?.[0]?.rowData?.[0]?.values?.[0];
  return (v && v.note) ? v.note : "";
}

export async function writeSingleCellNoteByRC(sheetId, row0, col0, note) {
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: cfg.google.sheetId,
    requestBody: {
      requests: [{
        updateCells: {
          range: { sheetId, startRowIndex: row0, endRowIndex: row0 + 1, startColumnIndex: col0, endColumnIndex: col0 + 1 },
          rows: [{ values: [{ note }] }],
          fields: "note"
        }
      }]
    }
  }), "writeSingleCellNoteByRC");
}

export async function readCellValueA1(a1, valueRenderOption) {
  const params = { spreadsheetId: cfg.google.sheetId, range: a1 };
  if (valueRenderOption) params.valueRenderOption = valueRenderOption;
  const res = await withRetry(() => sheets.spreadsheets.values.get(params), "readCellValueA1");
  return res.data.values?.[0]?.[0]?.toString() || "";
}

export async function readRangeValuesA1(a1) {
  const res = await withRetry(() => sheets.spreadsheets.values.get({
    spreadsheetId: cfg.google.sheetId,
    range: a1,
  }), "readRangeValuesA1");
  return res.data.values || [];
}

// Generic structural batchUpdate (updateCells, addSheet, etc.).
export async function batchUpdateCells(requests) {
  if (!requests.length) return;
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: cfg.google.sheetId,
    requestBody: { requests }
  }), "batchUpdateCells");
}

// Combined value + note in a single batchUpdate (one round-trip instead of two).
// Note: stringValue stores the value verbatim — no formula/number coercion. That's
// what we want for character names and identifiers (also blocks formula injection).
export async function writeCellValueAndNoteByRC(sheetId, row0, col0, value, note) {
  await withRetry(() => sheets.spreadsheets.batchUpdate({
    spreadsheetId: cfg.google.sheetId,
    requestBody: {
      requests: [{
        updateCells: {
          range: { sheetId, startRowIndex: row0, endRowIndex: row0 + 1, startColumnIndex: col0, endColumnIndex: col0 + 1 },
          rows: [{ values: [{ userEnteredValue: { stringValue: String(value ?? "") }, note }] }],
          fields: "userEnteredValue,note"
        }
      }]
    }
  }), "writeCellValueAndNoteByRC");
}

// Updates a "Key: value\nKey: value" note.
// - undefined → leave the key unchanged (skip)
// - null or ""  → delete the key from the note
// - otherwise   → set the key to the stringified value
export function upsertNoteLines(existingNote, kv) {
  const lines = (existingNote || "").split(/\r?\n/).filter(Boolean);
  const map = new Map();
  for (const line of lines) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) map.set(m[1].trim(), m[2]); else map.set(line, "");
  }
  for (const [k, v] of Object.entries(kv)) {
    if (v === undefined) continue;
    if (v === null || v === "") map.delete(k);
    else map.set(k, String(v));
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}: ${v}`).join("\n");
}

export async function ensureIdentityOnColumnA(rowNumber, currentDisplayName, discordId) {
  const sheetId = await getRosterSheetId();
  const a1 = `${ROSTER_SHEET_NAME}!A${rowNumber}:A${rowNumber}`;
  const existingANote = await readSingleCellNoteA1(a1);
  const newNote = upsertNoteLines(existingANote, { "Discord ID": discordId });
  await writeCellValueAndNoteByRC(sheetId, rowNumber - 1, 0, currentDisplayName, newNote);
}
