import 'dotenv/config';
import http from 'http';
import { Client, GatewayIntentBits, Events, ChannelType } from 'discord.js';
import { classify } from './services/router.js';
import { chatSimple, chatWithTools, SYSTEM_SIMPLE, buildSystemWithTools } from './services/deepseek.js';
import { buildConversationHistory } from './services/historyBuilder.js';
import { planSearch } from './services/planner.js';
import { finalizeResponse } from './services/finalizer.js';

const PORT = parseInt(process.env.PORT || '8080', 10);
http.createServer((req, res) => res.end('ok')).listen(PORT);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

// ai- で始まるチャンネルをすべてAIチャットチャンネルとして扱う
const AI_CHANNEL_PREFIX = process.env.AI_CHANNEL_PREFIX || 'ai-';
const aiChannelIds = new Set();

function isAiChatChannel(channel) {
  return channel.type === ChannelType.GuildText && channel.name.startsWith(AI_CHANNEL_PREFIX);
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Ready! Logged in as ${c.user.tag}`);
  for (const [, guild] of c.guilds.cache) {
    // 既存の ai-* チャンネルをすべて登録
    for (const [, channel] of guild.channels.cache) {
      if (isAiChatChannel(channel)) {
        aiChannelIds.add(channel.id);
        console.log(`AI channel registered: #${channel.name} (${channel.id})`);
      }
    }
    await ensureDefaultChannel(guild);
  }
});

// ai-* チャンネルが新規作成されたら自動登録
client.on(Events.ChannelCreate, (channel) => {
  if (isAiChatChannel(channel)) {
    aiChannelIds.add(channel.id);
    console.log(`AI channel registered: #${channel.name} (${channel.id})`);
  }
});

// ai-* チャンネルが削除されたら登録解除
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

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (!aiChannelIds.has(message.channelId)) return;

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
    const { type, reason } = await classify(message.content, serverInfo);
    statusLines.push(`> 🔍 **[Router]** \`${type}\` — ${reason}`);
    await statusMsg.edit(formatStatus([...statusLines, '> ⏳ **[History]** 会話履歴を取得中...']));

    // ── Step 2: 会話履歴取得（チャンネルごとに独立）──────
    const history = await buildConversationHistory(
      message.channel,
      message.id,
      client.user.id
    );
    statusLines.push(`> 💬 **[History]** 直近 ${history.length} 件の会話を参照`);
    await statusMsg.edit(formatStatus([...statusLines, '> ⏳ **[Pipeline]** 次のステップへ...']));

    const model = 'deepseek-v4-flash';
    let response;

    if (type === 'complex') {
      // AIチャットチャンネル以外を操作対象として渡す
      const textChannels = message.guild.channels.cache.filter(
        (c) => c.type === ChannelType.GuildText && !aiChannelIds.has(c.id)
      );
      const channelList = textChannels
        .map((c) => `#${c.name} [ID:${c.id}]${c.topic ? ` (${c.topic})` : ''}`)
        .join('\n');

      // ── Step 3: Plan ──────────────────────────────────────
      statusLines.push('> 🗺️ **[Plan]** 調査計画を立案中...');
      await statusMsg.edit(formatStatus(statusLines));

      const plan = await planSearch(message.content, channelList, history);
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

      // ── Step 4: Tool calls（並列実行）────────────────────
      statusLines.push(`> ✍️ **[AI]** 調査中... \`${model}\``);
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
      });

      // ── Step 5: Finalize（整形 + 品質チェック + Retry）──────
      response = answer;
      const MAX_RETRIES = 2;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        statusLines.push(`> ✨ **[Finalize]** 整形中...`);
        await statusMsg.edit(formatStatus(statusLines));

        const { ok, answer: finalAnswer, feedback } = await finalizeResponse(message.content, response, history);

        if (ok) {
          response = finalAnswer;
          statusLines[statusLines.length - 1] = `> ✨ **[Finalize]** 完了`;
          break;
        }

        const shortFeedback = feedback.replace(/\\n/g, ' ').replace(/\n/g, ' ').slice(0, 80);
        statusLines[statusLines.length - 1] = `> 🔄 **[Retry ${attempt + 1}]** ${shortFeedback}`;
        await statusMsg.edit(formatStatus(statusLines));

        if (attempt === MAX_RETRIES) {
          statusLines.push(`> ⚠️ **[Finalize]** リトライ上限到達`);
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
        });
        response = retryAnswer;
      }
    } else {
      // ── Simple path ───────────────────────────────────────
      statusLines.push(`> ✍️ **[AI]** 生成中... \`${model}\``);
      await statusMsg.edit(formatStatus(statusLines));

      const msgs = [
        { role: 'system', content: `${timeContext}\n\n${SYSTEM_SIMPLE}` },
        ...history,
        { role: 'user', content: message.content },
      ];
      response = await chatSimple(msgs);
    }

    // ── 送信 ─────────────────────────────────────────────
    const chunks = (response ?? '').match(/.{1,2000}/gs) ?? [];
    for (const chunk of chunks) {
      await message.channel.send(chunk);
    }

    if (type !== 'complex') {
      statusLines[statusLines.length - 1] = `> ✅ **[AI]** 生成完了 \`${model}\``;
    }
    await statusMsg.edit(formatStatus(statusLines));

  } catch (e) {
    console.error('Error:', e.message);
    statusLines.push(`> ❌ **[Error]** ${e.message}`);
    await statusMsg.edit(formatStatus(statusLines));
  }
});

client.login(process.env.DISCORD_TOKEN);
