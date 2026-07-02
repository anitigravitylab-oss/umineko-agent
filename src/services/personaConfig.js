import { ChannelType } from 'discord.js';

// #ai-config チャンネルのトピック＋ピン留めメッセージを、サーバー管理者による
// ペルソナ上書き設定としてsystemプロンプトに注入するための取得元（prompt.js
// buildSystemPrompt / agent.js runAgent 側の対応と対）。
// トピック変更は「チャンネルの管理」、ピン留めは「メッセージの管理」権限が
// 要るため、実質サーバー管理側だけがこの内容を制御できる。
const AI_CONFIG_CHANNEL_NAME = 'ai-config';
const MAX_CHARS = 4000;
const TRUNCATE_SUFFIX = '…(省略)';
const TTL_MS = 5 * 60 * 1000; // 5分

// guild.id → { value: string|null, expiresAt: number }
// ピン取得はAPIコールなので毎メッセージ叩かないようTTLキャッシュする。
const cache = new Map();

function truncate(text) {
  if (text.length <= MAX_CHARS) return text;
  return text.slice(0, MAX_CHARS - TRUNCATE_SUFFIX.length) + TRUNCATE_SUFFIX;
}

async function fetchPersonaConfig(guild) {
  const channel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === AI_CONFIG_CHANNEL_NAME
  );
  if (!channel) return null;

  const parts = [];
  if (channel.topic && channel.topic.trim()) parts.push(channel.topic.trim());

  try {
    const pinned = await channel.messages.fetchPinned();
    const sorted = [...pinned.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const m of sorted) {
      if (m.content && m.content.trim()) parts.push(m.content.trim());
    }
  } catch (e) {
    // 権限不足等でピン取得が失敗しても、設定なし扱いにして落ちない。
    console.warn(`[personaConfig] fetchPinned failed for guild ${guild.id}: ${e.message}`);
    return null;
  }

  if (parts.length === 0) return null;
  return truncate(parts.join('\n\n'));
}

// #ai-config チャンネルのペルソナ設定文字列を返す（なければnull）。
// guild.id単位でTTL 5分キャッシュする。
export async function getPersonaConfig(guild) {
  if (!guild?.channels?.cache) return null;

  const now = Date.now();
  const cached = cache.get(guild.id);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = await fetchPersonaConfig(guild);
  cache.set(guild.id, { value, expiresAt: now + TTL_MS });
  return value;
}

// ピン留め/トピック変更時にTTLを待たず即反映するためのキャッシュ破棄。
export function clearPersonaConfigCache(guildId) {
  cache.delete(guildId);
}
