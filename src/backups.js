// Backs up .json/.zip attachments from a target Discord channel to Google Drive.

import fs from "fs";
import axios from "axios";
import { drive } from "./googleClients.js";
import { cfg } from "./config.js";
import { log } from "./logger.js";

const channelIds = new Set(cfg.discord.channelIds);
const driveFolderId = cfg.google.driveFolderId;
const delayMs = cfg.backups.delayMs;

// --- Deduplication state ---
const processedAttachments = new Set();

// --- Google Drive upload helper ---
async function uploadToDrive(filePath, fileName) {
  try {
    const timestamp = new Date().toISOString().replace(/[-:T.]/g, "").slice(0, 14);
    const baseName = fileName.split(".")[0];
    const extension = fileName.split(".").pop();
    const newFileName = `${baseName}_${timestamp}.${extension}`;

    const fileMetadata = { name: newFileName, parents: [driveFolderId] };
    const media = {
      mimeType: extension === "zip" ? "application/zip" : "application/json",
      body: fs.createReadStream(filePath),
    };

    const response = await drive.files.create({
      requestBody: fileMetadata,
      media,
      fields: "id",
    });

    log.event("backup.uploaded", { file: newFileName, driveId: response.data.id });
    return true;
  } catch (err) {
    log.error("backup.uploadFailed", { file: fileName, error: err.message });
    return false;
  }
}

// --- Single attachment processing (download → upload → cleanup) ---
async function processAttachment(attachment, channel) {
  if (processedAttachments.has(attachment.id)) {
    log.info("backup.skipDuplicate", { file: attachment.name, attachmentId: attachment.id });
    return false;
  }
  processedAttachments.add(attachment.id);

  if (!attachment.name.endsWith(".zip") && !attachment.name.endsWith(".json")) {
    log.info("backup.skipUnsupported", { file: attachment.name });
    return false;
  }

  const filePath = `./${attachment.name}`;
  try {
    log.event("backup.detected", { file: attachment.name, attachmentId: attachment.id });

    const writer = fs.createWriteStream(filePath);
    const response = await axios.get(attachment.url, { responseType: "stream" });
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
    log.info("backup.downloaded", { file: attachment.name });

    const ok = await uploadToDrive(filePath, attachment.name);
    fs.unlink(filePath, () => {});
    if (ok) channel.send(`✅ Uploaded **${attachment.name}** to Drive.`).catch(() => {});
    return ok;
  } catch (err) {
    log.error("backup.processFailed", { file: attachment.name, error: err.message });
    try { fs.unlinkSync(filePath); } catch {}
    return false;
  }
}

// --- Public: attach listeners to a Discord client ---
export function attachBackups(client) {
  if (!channelIds.size) {
    log.warn("backup.disabled", { reason: "No DISCORD_CHANNEL_ID configured" });
    return;
  }
  if (!driveFolderId) {
    log.warn("backup.misconfigured", { reason: "No GDRIVE_FOLDER_ID configured; uploads will fail" });
  }

  client.on("messageCreate", (message) => {
    if (!channelIds.has(message.channel.id)) return;
    setTimeout(async () => {
      for (const attachment of message.attachments.values()) {
        await processAttachment(attachment, message.channel);
      }
    }, delayMs);
  });

  client.on("messageUpdate", async (oldMessage, newMessage) => {
    if (!channelIds.has(newMessage.channel.id)) return;

    if (oldMessage.partial) oldMessage = await oldMessage.fetch();
    if (newMessage.partial) newMessage = await newMessage.fetch();

    const oldIds = new Set(oldMessage.attachments.keys());
    for (const [id, attachment] of newMessage.attachments) {
      if (!oldIds.has(id)) {
        await processAttachment(attachment, newMessage.channel);
      }
    }
  });

  log.info("backup.watching", { channels: [...channelIds].join(","), delayMs });
}
