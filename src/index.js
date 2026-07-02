import 'dotenv/config';
import http from 'http';
import { Client, GatewayIntentBits, Events, ChannelType, REST, Routes } from 'discord.js';
import { runAgent } from './services/agent.js';
import { buildConversationHistory } from './services/historyBuilder.js';
import { extractImageUrls } from './services/attachments.js';
import { createStreamReply } from './services/streamReply.js';
import {
  getGuildSettings,
  updateGuildSettings,
  resetGuildSettings,
  resolveModel,
  resolveEffort,
  MODEL_DEFAULTS,
} from './services/settings.js';

const PORT = process.env.PORT || 8080;
http.createServer((req, res) => res.end('ok')).listen(PORT);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ── スラッシュコマンド定義 ─────────────────────────────────────────────
const AI_COMMAND = {
  name: 'ai',
  description: 'AIプロバイダー・モデルの設定（管理者のみ）',
  default_member_permissions: '8', // Administrator
  options: [
    {
      type: 1, // SUB_COMMAND
      name: 'status',
      description: '現在のAI設定を表示',
    },
    {
      type: 1,
      name: 'model',
      description: 'メインAIのモデルを変更（プロバイダーも自動切替）',
      options: [{
        type: 3,
        name: 'value',
        description: 'モデルを選択',
        required: true,
        choices: [
          { name: 'Claude: Fable 5 (Max)',     value: 'claude-fable-5' },
          { name: 'Claude: Opus 4.8 (Max)',    value: 'claude-opus-4-8' },
          { name: 'Claude: Sonnet 5 (Max)',    value: 'claude-sonnet-5' },
          { name: 'Claude: Sonnet 4.6 (Max)',  value: 'claude-sonnet-4-6' },
          { name: 'Claude: Haiku 4.5 (Max)',   value: 'claude-haiku-4-5-20251001' },
          { name: 'OpenAI: gpt-5.5',          value: 'gpt-5.5' },
          { name: 'OpenAI: gpt-5.4',          value: 'gpt-5.4' },
          { name: 'OpenAI: gpt-5.4-mini',     value: 'gpt-5.4-mini' },
          { name: 'OpenAI: gpt-5.4-nano',     value: 'gpt-5.4-nano' },
          { name: 'OpenAI: gpt-5-mini',       value: 'gpt-5-mini' },
          { name: 'OpenAI: gpt-4o',           value: 'gpt-4o' },
          { name: 'OpenAI: gpt-4o-mini',      value: 'gpt-4o-mini' },
          { name: 'Gemini: 3.1-pro (preview)', value: 'gemini-3.1-pro-preview' },
          { name: 'Gemini: 3.5-flash',         value: 'gemini-3.5-flash' },
          { name: 'Gemini: 3-flash (preview)', value: 'gemini-3-flash-preview' },
          { name: 'Gemini: 2.5-flash',         value: 'gemini-2.5-flash' },
          { name: 'Gemini: 2.5-flash-lite',    value: 'gemini-2.5-flash-lite' },
          { name: 'DeepSeek: v4-pro',         value: 'deepseek-v4-pro' },
          { name: 'DeepSeek: v4-flash',       value: 'deepseek-v4-flash' },
          { name: '— デフォルトに戻す —',       value: 'default' },
        ],
      }],
    },
    {
      type: 1,
      name: 'effort',
      description: 'Claude使用時の思考の深さを変更（他プロバイダーでは無視されます）',
      options: [{
        type: 3,
        name: 'value',
        description: 'エフォートレベル',
        required: true,
        choices: [
          { name: 'low（高速・低コスト）', value: 'low' },
          { name: 'medium', value: 'medium' },
          { name: 'high', value: 'high' },
          { name: 'max（最高品質・デフォルト）', value: 'max' },
          { name: '— デフォルトに戻す —', value: 'default' },
        ],
      }],
    },
    {
      type: 1,
      name: 'reset',
      description: 'すべての設定を環境変数のデフォルトに戻す',
    },
  ],
};

const RESEARCH_COMMAND = {
  name: 'research',
  description: 'ウェブ検索を使った深掘りリサーチを実行',
  options: [{
    type: 3,
    name: 'query',
    description: '調べたいこと',
    required: true,
  }],
};

async function registerCommands(clientId, guildId) {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [AI_COMMAND, RESEARCH_COMMAND] });
    console.log(`[commands] Registered /ai for guild ${guildId}`);
  } catch (e) {
    console.error(`[commands] Failed to register for guild ${guildId}:`, e.message);
  }
}

// ── ギルドフィルター ──────────────────────────────────────────────────
// ALLOWED_GUILDS=id1,id2  → 指定ギルドのみ応答
// IGNORED_GUILDS=id1,id2  → 指定ギルドを無視
const ALLOWED_GUILDS = process.env.ALLOWED_GUILDS
  ? new Set(process.env.ALLOWED_GUILDS.split(',').map((s) => s.trim()))
  : null;
const IGNORED_GUILDS = process.env.IGNORED_GUILDS
  ? new Set(process.env.IGNORED_GUILDS.split(',').map((s) => s.trim()))
  : null;

function isGuildAllowed(guildId) {
  if (ALLOWED_GUILDS && !ALLOWED_GUILDS.has(guildId)) return false;
  if (IGNORED_GUILDS && IGNORED_GUILDS.has(guildId)) return false;
  return true;
}

// ── AI_CHANNEL_PREFIX ────────────────────────────────────────────────
const AI_CHANNEL_PREFIX = process.env.AI_CHANNEL_PREFIX || 'ai-';
// #ai-memory はbotの長期記憶専用チャンネル特例。"ai-"プレフィックスに
// マッチしても自動登録せず（＝会話に反応しない）、プロンプト側からの
// 自主参照・自主書き込み専用にする（prompt.js / tools.js側の対応と対）。
const AI_MEMORY_CHANNEL_NAME = 'ai-memory';
const aiChannelIds = new Set();

// 純関数（チャンネル名だけを見る）。登録箇所（起動時スキャン・GuildCreate・
// ChannelCreate）を全てこれに統一し、ユニットテスト可能にする。
export function isAiChatChannel(name) {
  return name.startsWith(AI_CHANNEL_PREFIX) && name !== AI_MEMORY_CHANNEL_NAME;
}

function isAiChannelCandidate(channel) {
  return channel.type === ChannelType.GuildText && isAiChatChannel(channel.name);
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Ready! Logged in as ${c.user.tag}`);
  if (ALLOWED_GUILDS) console.log(`[filter] ALLOWED_GUILDS: ${[...ALLOWED_GUILDS].join(', ')}`);
  if (IGNORED_GUILDS) console.log(`[filter] IGNORED_GUILDS: ${[...IGNORED_GUILDS].join(', ')}`);
  for (const [, guild] of c.guilds.cache) {
    if (!isGuildAllowed(guild.id)) {
      console.log(`[filter] Skipping guild ${guild.name} (${guild.id})`);
      continue;
    }
    for (const [, channel] of guild.channels.cache) {
      if (isAiChannelCandidate(channel)) {
        aiChannelIds.add(channel.id);
        console.log(`AI channel registered: #${channel.name} (${channel.id})`);
      }
    }
    await ensureDefaultChannel(guild);
    await registerCommands(c.user.id, guild.id);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  // Scan AI channels for newly joined guild
  for (const [, channel] of guild.channels.cache) {
    if (isAiChannelCandidate(channel)) {
      aiChannelIds.add(channel.id);
      console.log(`AI channel registered: #${channel.name} (${channel.id})`);
    }
  }
  await ensureDefaultChannel(guild);
  await registerCommands(client.user.id, guild.id);
});

client.on(Events.ChannelCreate, (channel) => {
  if (isAiChannelCandidate(channel)) {
    aiChannelIds.add(channel.id);
    console.log(`AI channel registered: #${channel.name} (${channel.id})`);
  }
});

client.on(Events.ChannelDelete, (channel) => {
  if (aiChannelIds.has(channel.id)) {
    aiChannelIds.delete(channel.id);
    console.log(`AI channel unregistered: #${channel.name} (${channel.id})`);
  }
});

client.on(Events.Error, (err) => {
  console.error('Discord client error:', err.message);
});

client.on(Events.ShardDisconnect, (event, id) => {
  console.error(`Shard ${id} disconnected (code: ${event.code}).`);
  const noReconnectCodes = [4004, 4010, 4011, 4012, 4013, 4014];
  if (noReconnectCodes.includes(event.code)) {
    console.error('Non-resumable disconnect. Exiting for restart.');
    process.exit(1);
  }
});

setInterval(() => {
  if (!client.isReady()) {
    console.error('Client is not ready. Exiting for restart.');
    process.exit(1);
  }
  console.log(`[heartbeat] ok — ping: ${client.ws.ping}ms`);
}, 5 * 60 * 1000);

async function ensureDefaultChannel(guild) {
  const defaultName = process.env.AI_CHANNEL_NAME || 'ai-chat';
  // ai-memory等、AIチャットチャンネルにできない名前は自動作成・登録の対象外
  if (!isAiChatChannel(defaultName)) {
    console.warn(`[config] AI_CHANNEL_NAME="${defaultName}" はAIチャットチャンネル名にできないため自動作成しません`);
    return;
  }
  const existing = guild.channels.cache.find(
    (ch) => ch.name === defaultName && ch.type === ChannelType.GuildText
  );
  if (existing) return;
  try {
    const created = await guild.channels.create({
      name: defaultName,
      type: ChannelType.GuildText,
      topic: 'AIチャットチャンネル',
    });
    aiChannelIds.add(created.id);
    console.log(`AI channel created: #${defaultName} (${created.id})`);
    await created.send('準備できました。ここにメッセージを送ると、AIが答えます。');
  } catch (e) {
    console.error('Failed to create AI channel:', e.message);
  }
}

// ── メッセージ分割（2000字以内・段落境界優先） ──────────────────────────
const MAX_CHUNK = 2000;

function splitByLimit(text, separators) {
  if (text.length <= MAX_CHUNK) return [text];
  const [sep, ...rest] = separators;
  // 区切りを使い切ったら文字単位で切る（コードポイント単位・現行の正規表現を踏襲）
  if (!sep) return text.match(/.{1,2000}/gsu) ?? [];
  const out = [];
  let current = '';
  for (const part of text.split(sep)) {
    const candidate = current ? current + sep + part : part;
    if (candidate.length <= MAX_CHUNK) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    if (part.length <= MAX_CHUNK) {
      current = part;
    } else {
      out.push(...splitByLimit(part, rest));
      current = '';
    }
  }
  if (current) out.push(current);
  return out;
}

// 段落境界(\n\n)優先で2000字以内のチャンクに分割する。
// 段落単体が2000超なら行(\n)、それも超えるなら文字で切る。
export function chunkMessage(text) {
  const t = (text ?? '').trim();
  if (!t) return [];
  return splitByLimit(t, ['\n\n', '\n']).map((c) => c.trim()).filter(Boolean);
}

const renderStatus = (lines) => lines.join('\n').slice(0, 2000);

// ── スラッシュコマンドハンドラー ──────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'ai') return;
  if (!interaction.guild || !isGuildAllowed(interaction.guild.id)) return;

  const guildId = interaction.guild.id;
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    const s = getGuildSettings(guildId);
    const mainModel = resolveModel(s.provider, s.model);
    const modelLabel = s.model ? `\`${s.model}\`` : `\`${mainModel}\` (デフォルト)`;
    await interaction.reply({
      content: [
        '**現在のAI設定**',
        `メインAI : \`${s.provider}\` / モデル: ${modelLabel}`,
        `Effort   : \`${s.effort}\`（Claude使用時のみ有効）`,
      ].join('\n'),
      ephemeral: true,
    });
    return;
  }

  if (sub === 'model') {
    const value = interaction.options.getString('value');
    if (value === 'default') {
      updateGuildSettings(guildId, { model: null });
      const s = getGuildSettings(guildId);
      await interaction.reply({
        content: `✅ モデルをデフォルト (\`${MODEL_DEFAULTS[s.provider] ?? '?'}\`) にリセットしました。`,
        ephemeral: true,
      });
    } else {
      // モデル名からプロバイダーを自動推定
      let autoProvider = null;
      if (/^claude-/.test(value)) autoProvider = 'claude';
      else if (/^gpt-|^o1|^o3|^o4/.test(value)) autoProvider = 'openai';
      else if (/^gemini-/.test(value)) autoProvider = 'gemini';
      else if (/^deepseek/.test(value)) autoProvider = 'deepseek';

      const prevSettings = getGuildSettings(guildId);
      const patch = { model: value };
      if (autoProvider && autoProvider !== prevSettings.provider) patch.provider = autoProvider;
      updateGuildSettings(guildId, patch);

      const s = getGuildSettings(guildId);
      const providerNote = patch.provider
        ? `\nプロバイダーも \`${patch.provider}\` に自動変更しました。`
        : `\n現在のプロバイダー: \`${s.provider}\``;
      await interaction.reply({
        content: `✅ モデルを \`${value}\` に変更しました。${providerNote}`,
        ephemeral: true,
      });
    }
    return;
  }

  if (sub === 'effort') {
    const value = interaction.options.getString('value');
    if (value === 'default') {
      updateGuildSettings(guildId, { effort: null });
      await interaction.reply({
        content: `✅ Effortをデフォルト (\`${resolveEffort(null)}\`) にリセットしました。`,
        ephemeral: true,
      });
    } else {
      updateGuildSettings(guildId, { effort: value });
      await interaction.reply({
        content: `✅ Effortを \`${value}\` に変更しました。（Claude使用時のみ有効。Haikuモデルでは自動的に無視されます）`,
        ephemeral: true,
      });
    }
    return;
  }

  if (sub === 'reset') {
    const s = resetGuildSettings(guildId);
    await interaction.reply({
      content: [
        '✅ 設定を環境変数のデフォルトに戻しました。',
        `メインAI : \`${s.provider}\` / モデル: \`${resolveModel(s.provider, s.model)}\``,
        `Effort   : \`${resolveEffort(s.effort)}\``,
      ].join('\n'),
      ephemeral: true,
    });
  }
});

// ── /research ハンドラー ───────────────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'research') return;
  if (!interaction.guild || !isGuildAllowed(interaction.guild.id)) return;

  const query = interaction.options.getString('query');
  const settings = getGuildSettings(interaction.guild.id);
  const modelDisplay = `${settings.provider}/${resolveModel(settings.provider, settings.model)}`;

  // 即応答（Deferred — リサーチに時間がかかるため）
  await interaction.deferReply();

  const statusLines = [`> 🔬 **[Research]** \`${query}\` — ${modelDisplay}`];

  try {
    await interaction.editReply(renderStatus(statusLines));

    const history = await buildConversationHistory(interaction.channel, null, client.user.id);
    const authorName = interaction.member?.displayName ?? interaction.user.username;
    const seed = [
      ...history,
      { role: 'user', content: `${authorName}: [リサーチ依頼] ${query}` },
    ];

    const report = await runAgent({
      settings,
      guild: interaction.guild,
      member: interaction.member,
      aiChannelIds,
      seed,
      mode: 'research',
      maxIterations: 25,
      onToolCall: async (label) => {
        statusLines.push(`> 🔧 ${label}`);
        await interaction.editReply(renderStatus(statusLines));
      },
    });

    statusLines.push('> ✅ **[Research]** 完了');
    await interaction.editReply(renderStatus(statusLines));

    // レポートを分割送信
    const chunks = chunkMessage(report);
    if (chunks.length === 0) chunks.push('レポート生成に失敗しました。');
    await interaction.followUp({ content: chunks[0] });
    for (let i = 1; i < chunks.length; i++) {
      await interaction.channel.send(chunks[i]);
    }
  } catch (e) {
    console.error('Research error:', e.message, '\n', e.stack);
    statusLines.push(`> ❌ **[Error]** ${e.message}`);
    await interaction.editReply(renderStatus(statusLines)).catch(() => {});
  }
});

// ── メッセージハンドラー ───────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild || !isGuildAllowed(message.guild.id)) return;
  if (!aiChannelIds.has(message.channelId)) return;

  const userImages = extractImageUrls(message);
  const settings = getGuildSettings(message.guild.id);
  const modelDisplay = `${settings.provider}/${resolveModel(settings.provider, settings.model)}`;

  const statusMsg = await message.reply('> ⏳ 考え中...');
  const statusLines = [];
  const reply = createStreamReply(message.channel);
  let streamedAny = false;

  try {
    const history = await buildConversationHistory(
      message.channel,
      message.id,
      client.user.id
    );

    const authorName = message.member?.displayName ?? message.author.username;
    const seed = [
      ...history,
      {
        role: 'user',
        content: `${authorName}: ${message.content}`,
        ...(userImages.length ? { images: userImages } : {}),
      },
    ];

    const answer = await runAgent({
      settings,
      guild: message.guild,
      member: message.member,
      aiChannelIds,
      seed,
      onAnswerDelta: async (text) => {
        streamedAny = true;
        await reply.update(text);
      },
      onToolCall: async (label) => {
        // このstepはtool_useで終わった＝直前までストリームした本文は最終回答
        // ではない。作りかけのメッセージを撤退させ、次stepはまっさらから。
        await reply.reset();
        statusLines.push(`> 🔧 ${label}`);
        await statusMsg.edit(renderStatus(statusLines));
      },
    });

    if (streamedAny) {
      await reply.finalize(answer);
    } else {
      for (const chunk of chunkMessage(answer)) {
        await message.channel.send(chunk);
      }
    }

    const finalLines = statusLines.length
      ? [...statusLines, `> ✅ 完了 (${modelDisplay})`]
      : [`> ✅ (${modelDisplay})`];
    await statusMsg.edit(renderStatus(finalLines));
  } catch (e) {
    console.error('Error:', e.message);
    statusLines.push(`> ❌ **[Error]** ${e.message}`);
    await statusMsg.edit(renderStatus(statusLines)).catch(() => {});
  }
});

client.login(process.env.DISCORD_TOKEN);
