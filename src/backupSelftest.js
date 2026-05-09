// Slash command /backup test: validates channel access and send-permission for the target backup channel.

import { SlashCommandBuilder, ChannelType, PermissionFlagsBits, MessageFlags } from "discord.js";

export const backupSelftestCommandJSON = new SlashCommandBuilder()
  .setName("backup")
  .setDescription("Backup utilities")
  .addSubcommand(sub => sub
    .setName("test")
    .setDescription("Validate backup channel access and permissions"))
  .toJSON();

function hasOfficerRole(member) {
  return !!member?.roles?.cache?.some(r => r.name === "Officer");
}

export async function handleBackupSelftest(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "backup" || interaction.options.getSubcommand() !== "test") return;

  if (!hasOfficerRole(interaction.member)) {
    await interaction.reply({ content: "You need the **Officer** role to run this command.", flags: MessageFlags.Ephemeral });
    return;
  }

  const targetId = process.env.DISCORD_CHANNEL_ID || "";
  if (!targetId) {
    await interaction.reply({ content: "DISCORD_CHANNEL_ID is not set.", flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const ch = await interaction.client.channels.fetch(targetId);
    if (!ch) {
      await interaction.editReply("Channel not found by ID. The bot may not have access to it.");
      return;
    }

    const typeLabel =
      ch.type === ChannelType.GuildText ? "GuildText" :
      ch.type === ChannelType.PublicThread ? "PublicThread" :
      ch.type === ChannelType.PrivateThread ? "PrivateThread" :
      ch.type === ChannelType.GuildForum ? "GuildForum" :
      `type=${ch.type}`;

    // Permission checks for the bot in this channel
    const me = interaction.guild.members.me;
    const perms = ch.permissionsFor(me);

    const need = {
      ViewChannel: perms?.has(PermissionFlagsBits.ViewChannel) || false,
      SendMessages: perms?.has(PermissionFlagsBits.SendMessages) || false,
      ReadMessageHistory: perms?.has(PermissionFlagsBits.ReadMessageHistory) || false,
    };

    // Try to post a test message (only if allowed)
    let postResult = "skipped (no SendMessages)";
    if (need.ViewChannel && need.SendMessages) {
      try {
        await ch.send("🔎 Backup self-test: the bot can post here.");
        postResult = "ok";
      } catch (e) {
        postResult = `failed: ${e.message}`;
      }
    }

    const lines = [
      `Target channel: \`${ch.id}\` (${typeLabel})`,
      `Permissions: ViewChannel=${need.ViewChannel} • SendMessages=${need.SendMessages} • ReadMessageHistory=${need.ReadMessageHistory}`,
      `Post test: ${postResult}`,
      `Reminder: backups watch **only** this channel ID; posting in a thread requires setting the thread ID.`,
    ];

    await interaction.editReply(lines.join("\n"));
  } catch (e) {
    await interaction.editReply(`Error: ${e?.message || e}`);
  }
}
