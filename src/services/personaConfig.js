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
// トピックもピン留めも無いときだけ使うフォールバックの直近メッセージ件数。
// 「書いた/編集しただけでピン留めし忘れる」実運用障害への対策
// （2026-07-04、親エージェントの追加指示により導入）。
const FALLBACK_FETCH_LIMIT = 3;

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
  const topic = channel.topic && channel.topic.trim() ? channel.topic.trim() : '';
  if (topic) parts.push(topic);

  let pinnedSize = 0;
  try {
    const pinned = await channel.messages.fetchPinned();
    pinnedSize = pinned.size;
    const sorted = [...pinned.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    for (const m of sorted) {
      if (m.content && m.content.trim()) parts.push(m.content.trim());
    }
  } catch (e) {
    // 権限不足等でピン取得が失敗しても、設定なし扱いにして落ちない。
    console.warn(`[personaConfig] fetchPinned failed for guild ${guild.id}: ${e.message}`);
    return null;
  }

  // トピックもピン留めも1つも無いときだけ、直近メッセージへフォールバックする。
  // 管理者が意図的に設定した内容（トピック/ピン留め）が1つでもあれば、
  // 一般メンバーの雑談メッセージで薄めない・上書きしないためフォールバックは使わない。
  if (!topic && pinnedSize === 0) {
    try {
      const recent = await channel.messages.fetch({ limit: FALLBACK_FETCH_LIMIT });
      const sorted = [...recent.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
      for (const m of sorted) {
        if (m.content && m.content.trim()) parts.push(m.content.trim());
      }
    } catch (e) {
      // フォールバック取得の失敗は致命的ではない（設定なし扱いで継続）。
      console.warn(`[personaConfig] fallback fetch failed for guild ${guild.id}: ${e.message}`);
    }
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

// ── #ai-memory の自動ダイジェスト ───────────────────────────────────────
// #ai-memory の最近のメッセージを、モデルの read_channel 呼び出し判断に頼らず
// 毎回systemプロンプトへ自動で埋め込むための取得元（prompt.js buildSystemPrompt
// / agent.js runAgent 側の対応と対）。read_channel による深掘りは別途維持する。
const AI_MEMORY_CHANNEL_NAME = 'ai-memory';
const MEMORY_MAX_CHARS = 4000;
const MEMORY_TRUNCATE_PREFIX = '…(古い記憶は省略)\n';
const MEMORY_TTL_MS = 5 * 60 * 1000; // 5分
const MEMORY_FETCH_LIMIT = 50; // read_channelと同じ取得件数

// guild.id → { value: string|null, expiresAt: number }
const memoryCache = new Map();

// 超過分は古い方（先頭）から捨て、新しい記憶を優先して残す。
// getPersonaConfigのtruncate（末尾を捨てて末尾にサフィックス）と対称の方針。
function truncateMemory(text) {
  if (text.length <= MEMORY_MAX_CHARS) return text;
  const budget = MEMORY_MAX_CHARS - MEMORY_TRUNCATE_PREFIX.length;
  return MEMORY_TRUNCATE_PREFIX + text.slice(text.length - budget);
}

async function fetchMemoryDigest(guild) {
  const channel = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === AI_MEMORY_CHANNEL_NAME
  );
  if (!channel) return null;

  try {
    const fetched = await channel.messages.fetch({ limit: MEMORY_FETCH_LIMIT });
    const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const lines = sorted
      .filter((m) => m.content && m.content.trim())
      .map((m) => `${m.author.username}: ${m.content.trim()}`);
    if (lines.length === 0) return null;
    return truncateMemory(lines.join('\n'));
  } catch (e) {
    // fetch失敗（権限不足等）でも記憶なし扱いにして落ちない。
    console.warn(`[personaConfig] fetchMemoryDigest failed for guild ${guild.id}: ${e.message}`);
    return null;
  }
}

// #ai-memory の内容をダイジェスト化した文字列を返す（なければnull）。
// guild.id単位でTTL 5分キャッシュする。
export async function getMemoryDigest(guild) {
  if (!guild?.channels?.cache) return null;

  const now = Date.now();
  const cached = memoryCache.get(guild.id);
  if (cached && cached.expiresAt > now) return cached.value;

  const value = await fetchMemoryDigest(guild);
  memoryCache.set(guild.id, { value, expiresAt: now + MEMORY_TTL_MS });
  return value;
}

// #ai-memory への書き込み検知時にTTLを待たず即反映するためのキャッシュ破棄。
export function clearMemoryDigestCache(guildId) {
  memoryCache.delete(guildId);
}
