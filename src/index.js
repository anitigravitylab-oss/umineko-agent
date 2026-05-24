import 'dotenv/config';
import http from 'http';
import { Client, GatewayIntentBits, Events, ChannelType, REST, Routes } from 'discord.js';
import { classify } from './services/router.js';
import { chatSimple, chatWithTools, SYSTEM_SIMPLE, buildSystemWithTools } from './services/llm.js';
import { buildConversationHistory } from './services/historyBuilder.js';
import { planSearch } from './services/planner.js';
import { finalizeResponse } from './services/finalizer.js';
import {
  getGuildSettings,
  updateGuildSettings,
  resetGuildSettings,
  resolveModel,
  resolveRouterModel,
  MODEL_DEFAULTS,
  ROUTER_MODEL_DEFAULTS,
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
      name: 'router',
      description: 'simple/complex 判定に使うプロバイダーを変更',
      options: [{
        type: 3,
        name: 'value',
        description: 'プロバイダー名',
        required: true,
        choices: [
          { name: 'Gemini（デフォルト・高速）', value: 'gemini' },
          { name: 'DeepSeek', value: 'deepseek' },
          { name: 'OpenAI', value: 'openai' },
        ],
      }],
    },
    {
      type: 1,
      name: 'router-model',
      description: 'ルーターのモデル名を変更（"default" でリセット）',
      options: [{
        type: 3,
        name: 'value',
        description: 'モデル名（例: gemini-2.5-flash-lite, gpt-4o-mini）',
        required: true,
      }],
    },
    {
      type: 1,
      name: 'reset',
      description: 'すべての設定を環境変数のデフォルトに戻す',
    },
  ],
};

async function registerCommands(clientId, guildId) {
  const rest = new REST().setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [AI_COMMAND] });
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
const aiChannelIds = new Set();

function isAiChatChannel(channel) {
  return channel.type === ChannelType.GuildText && channel.name.startsWith(AI_CHANNEL_PREFIX);
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
      if (isAiChatChannel(channel)) {
        aiChannelIds.add(channel.id);
        console.log(`AI channel registered: #${channel.name} (${channel.id})`);
      }
    }
    await ensureDefaultChannel(guild);
    await registerCommands(c.user.id, guild.id);
  }
});

client.on(Events.GuildCreate, async (guild) => {
  await registerCommands(client.user.id, guild.id);
});

client.on(Events.ChannelCreate, (channel) => {
  if (isAiChatChannel(channel)) {
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

function formatStatus(lines) {
  return lines.join('\n');
}

function buildServerInfo(guild) {
  const channels = guild.channels.cache
    .filter((c) => c.type === ChannelType.GuildText && !aiChannelIds.has(c.id))
    .map((c) => `#${c.name}`)
    .join(', ');
  return `サーバー名: ${guild.name}\nチャンネル一覧: ${channels}`;
}

// ── スラッシュコマンドハンドラー ──────────────────────────────────────
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== 'ai') return;
  if (!interaction.guild || !isGuildAllowed(interaction.guild.id)) return;

  const guildId = interaction.guild.id;
  const sub = interaction.options.getSubcommand();

  if (sub === 'status') {
    const s = getGuildSettings(guildId);
    const mainModel = resolveModel(s.provider, s.model);
    const routerModel = resolveRouterModel(s.routerProvider, s.routerModel);
    const modelLabel = s.model ? `\`${s.model}\`` : `\`${mainModel}\` (デフォルト)`;
    const routerModelLabel = s.routerModel ? `\`${s.routerModel}\`` : `\`${routerModel}\` (デフォルト)`;
    await interaction.reply({
      content: [
        '**現在のAI設定**',
        `メインAI : \`${s.provider}\` / モデル: ${modelLabel}`,
        `ルーター  : \`${s.routerProvider}\` / モデル: ${routerModelLabel}`,
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
      if (/^gpt-|^o1|^o3|^o4/.test(value)) autoProvider = 'openai';
      else if (/^gemini-/.test(value)) autoProvider = 'gemini';
      else if (/^deepseek/.test(value)) autoProvider = 'deepseek';

      const prevSettings = getGuildSettings(guildId);
      const patch = { model: value };
      if (autoProvider && autoProvider !== prevSettings.provider) patch.provider = autoProvider;
      updateGuildSettings(guildId, patch);

      const s = getGuildSettings(guildId);
      const providerNote = patch.provider
        ? `\nプロバイダーも \`${patch.provider}\` に自動変更しました。`
        : `\n現在のプロバイダー: \`${s.provider}\`（変更は \`/ai provider\` で）`;
      await interaction.reply({
        content: `✅ モデルを \`${value}\` に変更しました。${providerNote}`,
        ephemeral: true,
      });
    }
    return;
  }

  if (sub === 'router') {
    const value = interaction.options.getString('value');
    updateGuildSettings(guildId, { routerProvider: value, routerModel: null });
    const defaultModel = ROUTER_MODEL_DEFAULTS[value] ?? '?';
    await interaction.reply({
      content: `✅ ルーターを \`${value}\` に変更しました。\nデフォルトモデル: \`${defaultModel}\``,
      ephemeral: true,
    });
    return;
  }

  if (sub === 'router-model') {
    const value = interaction.options.getString('value');
    if (value === 'default') {
      updateGuildSettings(guildId, { routerModel: null });
      const s = getGuildSettings(guildId);
      await interaction.reply({
        content: `✅ ルーターモデルをデフォルト (\`${ROUTER_MODEL_DEFAULTS[s.routerProvider] ?? '?'}\`) にリセットしました。`,
        ephemeral: true,
      });
    } else {
      updateGuildSettings(guildId, { routerModel: value });
      await interaction.reply({
        content: `✅ ルーターのモデルを \`${value}\` に変更しました。`,
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
        `ルーター  : \`${s.routerProvider}\` / モデル: \`${resolveRouterModel(s.routerProvider, s.routerModel)}\``,
      ].join('\n'),
      ephemeral: true,
    });
  }
});

// ── メッセージハンドラー ───────────────────────────────────────────────
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!message.guild || !isGuildAllowed(message.guild.id)) return;
  if (!aiChannelIds.has(message.channelId)) return;

  const settings = getGuildSettings(message.guild.id);
  const modelDisplay = `${settings.provider}/${resolveModel(settings.provider, settings.model)}`;

  const statusMsg = await message.reply('> ⏳ **[Router]** 判定中...');
  const statusLines = [];

  const now = message.createdAt.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const timeContext = `現在時刻: ${now} (JST)`;

  try {
    // ── Step 1: ルーティング判定 ──────────────────────────
    const serverInfo = buildServerInfo(message.guild);
    const { type, reason } = await classify(message.content, serverInfo, {
      routerProvider: settings.routerProvider,
      routerModel: settings.routerModel,
    });
    statusLines.push(`> 🔍 **[Router]** \`${type}\` — ${reason}`);
    await statusMsg.edit(formatStatus([...statusLines, '> ⏳ **[History]** 会話履歴を取得中...']));

    // ── Step 2: 会話履歴取得 ──────────────────────────────
    const history = await buildConversationHistory(
      message.channel,
      message.id,
      client.user.id
    );
    statusLines.push(`> 💬 **[History]** 直近 ${history.length} 件の会話を参照`);
    await statusMsg.edit(formatStatus([...statusLines, '> ⏳ **[Pipeline]** 次のステップへ...']));

    let response;

    if (type === 'complex') {
      const textChannels = message.guild.channels.cache.filter(
        (c) => c.type === ChannelType.GuildText && !aiChannelIds.has(c.id)
      );
      const channelList = textChannels
        .map((c) => `#${c.name} [ID:${c.id}]${c.topic ? ` (${c.topic})` : ''}`)
        .join('\n');

      // ── Step 3: Plan ──────────────────────────────────────
      statusLines.push('> 🗺️ **[Plan]** 調査計画を立案中...');
      await statusMsg.edit(formatStatus(statusLines));

      const plan = await planSearch(message.content, channelList, history, settings);
      const planLabel = [
        plan.channels.length > 0 ? plan.channels.map((c) => `#${c}`).join(', ') : null,
        plan.approach || null,
      ].filter(Boolean).join(' — ') || 'AIに委任';
      statusLines[statusLines.length - 1] = `> 🗺️ **[Plan]** ${planLabel}`;

      const systemPrompt = plan.channels.length > 0
        ? buildSystemWithTools(channelList) +
          `\n\n## 調査計画\nまず以下のチャンネルから読み始めてください:\n${plan.channels.map((c) => `- #${c}`).join('\n')}` +
          (plan.approach ? `\n方針: ${plan.approach}` : '')
        : buildSystemWithTools(channelList);

      // ── Step 4: Tool calls ────────────────────────────────
      statusLines.push(`> ✍️ **[AI]** 調査中... \`${modelDisplay}\``);
      await statusMsg.edit(formatStatus(statusLines));

      const msgs = [
        { role: 'system', content: `${timeContext}\n\n${systemPrompt}` },
        ...history,
        { role: 'user', content: message.content },
      ];

      const onToolCall = async (label) => {
        statusLines.push(`> 🔧 **[Tool]** ${label}`);
        await statusMsg.edit(formatStatus([...statusLines, '> ⏳ **[AI]** 処理中...']));
      };

      let { answer, msgs: contextMsgs } = await chatWithTools(msgs, {
        guild: message.guild,
        aiChannelIds,
        onToolCall,
        settings,
      });

      // ── Step 5: Finalize ──────────────────────────────────
      response = answer;
      const MAX_RETRIES = 2;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        statusLines.push('> ✨ **[Finalize]** 整形中...');
        await statusMsg.edit(formatStatus(statusLines));

        const { ok, answer: finalAnswer, feedback } = await finalizeResponse(
          message.content, response, history, settings
        );

        if (ok) {
          response = finalAnswer;
          statusLines[statusLines.length - 1] = '> ✨ **[Finalize]** 完了';
          break;
        }

        const shortFeedback = feedback.replace(/\\n/g, ' ').replace(/\n/g, ' ').slice(0, 80);
        statusLines[statusLines.length - 1] = `> 🔄 **[Retry ${attempt + 1}]** ${shortFeedback}`;
        await statusMsg.edit(formatStatus(statusLines));

        if (attempt === MAX_RETRIES) {
          statusLines.push('> ⚠️ **[Finalize]** リトライ上限到達');
          break;
        }

        contextMsgs.push({ role: 'assistant', content: response });
        contextMsgs.push({ role: 'system', content: `[内部指示] ${feedback}` });
        const { answer: retryAnswer } = await chatWithTools(contextMsgs, {
          guild: message.guild,
          aiChannelIds,
          onToolCall: async (label) => {
            statusLines.push(`> 🔧 **[Tool]** ${label}`);
            await statusMsg.edit(formatStatus([...statusLines, '> ⏳ **[AI]** 処理中...']));
          },
          settings,
        });
        response = retryAnswer;
      }
    } else {
      // ── Simple path ───────────────────────────────────────
      statusLines.push(`> ✍️ **[AI]** 生成中... \`${modelDisplay}\``);
      await statusMsg.edit(formatStatus(statusLines));

      const msgs = [
        { role: 'system', content: `${timeContext}\n\n${SYSTEM_SIMPLE}` },
        ...history,
        { role: 'user', content: message.content },
      ];
      response = await chatSimple(msgs, settings);
    }

    // ── 送信 ─────────────────────────────────────────────
    const chunks = (response ?? '').match(/.{1,2000}/gs) ?? [];
    for (const chunk of chunks) {
      await message.channel.send(chunk);
    }

    if (type !== 'complex') {
      statusLines[statusLines.length - 1] = `> ✅ **[AI]** 生成完了 \`${modelDisplay}\``;
    }
    await statusMsg.edit(formatStatus(statusLines));

  } catch (e) {
    console.error('Error:', e.message);
    statusLines.push(`> ❌ **[Error]** ${e.message}`);
    await statusMsg.edit(formatStatus(statusLines));
  }
});

client.login(process.env.DISCORD_TOKEN);
