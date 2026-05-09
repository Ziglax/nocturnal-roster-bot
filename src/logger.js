import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_PATH = path.resolve(__dirname, "..", "log.txt");

function fmtVal(v) {
  if (v instanceof Error) return JSON.stringify(v.stack || v.message || String(v));
  return JSON.stringify(v);
}

function fmtCtx(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  const parts = [];
  for (const [k, v] of Object.entries(ctx)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${k}=${fmtVal(v)}`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

function write(level, msg, ctx) {
  const line = `${new Date().toISOString()} ${level.padEnd(5)} ${msg}${fmtCtx(ctx)}`;
  console.log(line);
  fs.appendFile(LOG_PATH, line + "\n", (err) => {
    if (err) console.error("[logger] write failed:", err.message);
  });
}

export const log = {
  info:  (msg, ctx) => write("INFO",  msg, ctx),
  warn:  (msg, ctx) => write("WARN",  msg, ctx),
  error: (msg, ctx) => write("ERROR", msg, ctx),
  event: (name, ctx) => write("EVENT", name, ctx),
};
