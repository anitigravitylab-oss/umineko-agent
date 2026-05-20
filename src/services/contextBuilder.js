import { ChannelType } from 'discord.js';

const MESSAGES_PER_CHANNEL = 50;
const MAX_TOTAL_CHARS = 40000;

export async function buildServerContext(guild, excludeChannelId, selectedChannelNames = null) {
  const allChannels = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildText && c.id !== excludeChannelId
  );

  const textChannels = selectedChannelNames
    ? allChannels.filter((c) => selectedChannelNames.includes(c.name))
    : allChannels;

  const parts = [];
  let totalMessages = 0;

  for (const [, channel] of textChannels) {
    try {
      const fetched = await channel.messages.fetch({ limit: MESSAGES_PER_CHANNEL });
      const lines = [...fetched.values()]
        .reverse()
        .filter((m) => !m.author.bot && m.content.trim().length > 0)
        .map((m) => `${m.author.username}: ${m.content}`);

      if (lines.length > 0) {
        parts.push(`=== #${channel.name} ===\n${lines.join('\n')}`);
        totalMessages += lines.length;
      }
    } catch {
      // 読み取り権限がないチャンネルはスキップ
    }
  }

  let text = parts.join('\n\n');
  if (text.length > MAX_TOTAL_CHARS) {
    text = text.slice(-MAX_TOTAL_CHARS);
  }

  return {
    text,
    channelCount: parts.length,
    messageCount: totalMessages,
  };
}
