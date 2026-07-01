import { ChannelType } from 'discord.js';
import { callText, callWithTools as providerCallWithTools } from './provider.js';
import { extractImageUrls } from './attachments.js';

const MAX_ITERATIONS = 10;

export const SYSTEM_SIMPLE = `あなたはDiscordサーバーのAIアシスタントです。
messages配列には過去の会話履歴が含まれています。それを参照しながら最後のuserメッセージに答えてください。
ユーザーと同じ言語で回答してください。`;

export const buildSystemWithTools = (channelList) =>
  `あなたはDiscordサーバーのAIアシスタントです。
messages配列には過去の会話履歴が含まれています。
ツールを使ってチャンネルの読み書きや管理を行ってから回答してください。
ユーザーと同じ言語で回答してください。

【重要】新しいAIチャットスペース（会話用チャンネル）を作成する場合は、チャンネル名を必ず "ai-" で始めること（例: ai-general, ai-work）。
"ai-" で始まるチャンネルは自動的にAIチャットチャンネルとして認識され、そこでもAIと会話できるようになる。

【Discordのフォーマットルール】
- ユーザーメンション: <@数字ID> ← 必ず数字ID。<@ユーザー名> は機能しない
- チャンネルリンク: <#チャンネルID> ← クリッカブルになる。チャンネルIDは下記リストに記載
- メッセージリンク: https://discord.com/channels/{サーバーID}/{チャンネルID}/{メッセージID}
- ロールメンション: <@&ロールID>
- ユーザー/チャンネルのIDは必ずツール結果か下記リストから取得すること。推測・捏造禁止

利用可能なチャンネル:
${channelList}`;

const WEB_SEARCH_ENABLED = process.env.WEB_SEARCH_ENABLED !== 'false';

const DISCORD_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_channel',
      description: 'Discordの指定チャンネルの最近のメッセージ履歴を読む',
      parameters: {
        type: 'object',
        properties: {
          channel_name: { type: 'string', description: 'チャンネル名（#なし、例: general）' },
        },
        required: ['channel_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_message',
      description: '指定したDiscordチャンネルにメッセージを送信する',
      parameters: {
        type: 'object',
        properties: {
          channel_name: { type: 'string', description: '送信先チャンネル名' },
          content: { type: 'string', description: '送信するメッセージ内容' },
        },
        required: ['channel_name', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_channel',
      description: 'Discordに新しいテキストチャンネルを作成する',
      parameters: {
        type: 'object',
        properties: {
          channel_name: { type: 'string', description: 'チャンネル名（英数字とハイフン）' },
          topic: { type: 'string', description: 'チャンネルの説明（省略可）' },
          category: { type: 'string', description: '所属させるカテゴリ名（省略可）' },
        },
        required: ['channel_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_channel',
      description: 'Discordの既存チャンネルを編集する（名前・トピック・カテゴリ変更）',
      parameters: {
        type: 'object',
        properties: {
          channel_name: { type: 'string', description: '編集対象のチャンネル名' },
          new_name: { type: 'string', description: '新しいチャンネル名（省略可）' },
          topic: { type: 'string', description: '新しいトピック（省略可）' },
          category: { type: 'string', description: '移動先のカテゴリ名。空文字でカテゴリなしに（省略可）' },
        },
        required: ['channel_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_category',
      description: 'Discordに新しいカテゴリを作成する',
      parameters: {
        type: 'object',
        properties: {
          category_name: { type: 'string', description: 'カテゴリ名' },
        },
        required: ['category_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_category',
      description: 'Discordの既存カテゴリを編集する（名前変更）',
      parameters: {
        type: 'object',
        properties: {
          category_name: { type: 'string', description: '編集対象のカテゴリ名' },
          new_name: { type: 'string', description: '新しいカテゴリ名' },
        },
        required: ['category_name', 'new_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_category',
      description: 'Discordの指定カテゴリを削除する（中のチャンネルはカテゴリなしになる）',
      parameters: {
        type: 'object',
        properties: {
          category_name: { type: 'string', description: '削除するカテゴリ名' },
        },
        required: ['category_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_message',
      description: '指定チャンネルの特定メッセージを編集する（ボット自身のメッセージのみ編集可能）',
      parameters: {
        type: 'object',
        properties: {
          channel_name: { type: 'string', description: 'チャンネル名' },
          message_id: { type: 'string', description: '編集するメッセージのID（read_channelで取得）' },
          new_content: { type: 'string', description: '新しいメッセージ内容' },
        },
        required: ['channel_name', 'message_id', 'new_content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_channel',
      description: 'Discordの指定チャンネルを削除する',
      parameters: {
        type: 'object',
        properties: {
          channel_name: { type: 'string', description: '削除するチャンネル名' },
        },
        required: ['channel_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_message',
      description: 'Discordのメッセージリンク（https://discord.com/channels/...）からメッセージ内容を取得する',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Discordメッセージリンク（チャンネルリンクも可）' },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_members',
      description: 'Discordサーバーのメンバー一覧を取得する。メンション用のIDも含む',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_member',
      description: '名前（表示名・ユーザー名）でメンバーを検索し、メンション文字列（<@ID>）を返す',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '検索するメンバー名（部分一致）' },
        },
        required: ['name'],
      },
    },
  },
];

const WEB_TOOLS_DEFS = [
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: 'Bingでウェブ検索を行い、結果テキストを返す',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '検索クエリ' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: '指定URLのページ本文テキストを取得する',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '取得するURL' },
        },
        required: ['url'],
      },
    },
  },
];

const TOOLS = WEB_SEARCH_ENABLED ? [...DISCORD_TOOLS, ...WEB_TOOLS_DEFS] : DISCORD_TOOLS;

const WINDOWS_API = `http://${process.env.WINDOWS_API_HOST || 'localhost'}:7654`;

const ADMIN_TOOLS = new Set([
  'create_channel', 'edit_channel',
  'create_category', 'edit_category',
]);

async function executeTool(name, args, guild, aiChannelIds, member) {
  console.log(`[tool] ${name} ${JSON.stringify(args)}`);
  if (ADMIN_TOOLS.has(name) && member && !member.permissions.has('Administrator')) {
    console.log(`[tool] ${name} blocked — user ${member.user.username} is not admin`);
    return { text: `権限エラー: \`${name}\` は管理者のみ実行できます。`, images: [] };
  }
  let result;
  try {
    result = await executeToolInner(name, args, guild, aiChannelIds);
  } catch (e) {
    result = `エラー: ${e.message}`;
  }
  const normalized = typeof result === 'string' ? { text: result, images: [] } : result;
  console.log(`[tool] ${name} → ${normalized.text.slice(0, 100)}`);
  return normalized;
}

async function executeToolInner(name, args, guild, aiChannelIds) {
  switch (name) {
    case 'read_channel': {
      const channel = guild.channels.cache.find(
        (c) => c.name === args.channel_name && c.type === ChannelType.GuildText && !aiChannelIds.has(c.id)
      );
      if (!channel) return `チャンネル #${args.channel_name} が見つかりませんでした。`;
      const fetched = await channel.messages.fetch({ limit: 50 });
      const msgList = [...fetched.values()].reverse();
      const lines = msgList
        .filter((m) => m.content.trim())
        .map((m) => `[${m.id}] ${m.author.username}(メンション:<@${m.author.id}>): ${m.content}`)
        .join('\n');
      const images = msgList.flatMap((m) => extractImageUrls(m));
      return { text: lines || '(メッセージなし)', images };
    }

    case 'send_message': {
      const channel = guild.channels.cache.find(
        (c) => c.name === args.channel_name && c.type === ChannelType.GuildText && !aiChannelIds.has(c.id)
      );
      if (!channel) return `チャンネル #${args.channel_name} が見つかりませんでした。`;
      try {
        await channel.send(args.content);
        return `#${args.channel_name} にメッセージを送信しました。`;
      } catch (e) {
        return `送信失敗: ${e.message}`;
      }
    }

    case 'create_channel': {
      const existing = guild.channels.cache.find(
        (c) => c.name === args.channel_name && c.type === ChannelType.GuildText
      );
      if (existing) return `チャンネル #${args.channel_name} はすでに存在します。`;
      try {
        const options = { name: args.channel_name, type: ChannelType.GuildText };
        if (args.topic) options.topic = args.topic;
        if (args.category) {
          const cat = guild.channels.cache.find(
            (c) => c.name === args.category && c.type === ChannelType.GuildCategory
          );
          if (cat) options.parent = cat.id;
        }
        await guild.channels.create(options);
        return `チャンネル #${args.channel_name} を作成しました。${args.category ? `（カテゴリ: ${args.category}）` : ''}`;
      } catch (e) {
        return `作成失敗: ${e.message}`;
      }
    }

    case 'edit_channel': {
      const channel = guild.channels.cache.find(
        (c) => c.name === args.channel_name && c.type === ChannelType.GuildText && !aiChannelIds.has(c.id)
      );
      if (!channel) return `チャンネル #${args.channel_name} が見つかりませんでした。`;
      try {
        const options = {};
        if (args.new_name) options.name = args.new_name;
        if (args.topic !== undefined) options.topic = args.topic;
        if (args.category !== undefined) {
          if (args.category === '') {
            options.parent = null;
          } else {
            const cat = guild.channels.cache.find(
              (c) => c.name === args.category && c.type === ChannelType.GuildCategory
            );
            if (!cat) return `カテゴリ "${args.category}" が見つかりませんでした。`;
            options.parent = cat.id;
          }
        }
        await channel.edit(options);
        return `#${args.channel_name} を更新しました。`;
      } catch (e) {
        return `編集失敗: ${e.message}`;
      }
    }

    case 'create_category': {
      const existing = guild.channels.cache.find(
        (c) => c.name === args.category_name && c.type === ChannelType.GuildCategory
      );
      if (existing) return `カテゴリ "${args.category_name}" はすでに存在します。`;
      try {
        await guild.channels.create({ name: args.category_name, type: ChannelType.GuildCategory });
        return `カテゴリ "${args.category_name}" を作成しました。`;
      } catch (e) {
        return `作成失敗: ${e.message}`;
      }
    }

    case 'edit_category': {
      const cat = guild.channels.cache.find(
        (c) => c.name === args.category_name && c.type === ChannelType.GuildCategory
      );
      if (!cat) return `カテゴリ "${args.category_name}" が見つかりませんでした。`;
      try {
        await cat.edit({ name: args.new_name });
        return `カテゴリ "${args.category_name}" を "${args.new_name}" に変更しました。`;
      } catch (e) {
        return `編集失敗: ${e.message}`;
      }
    }

    case 'delete_category': {
      const cat = guild.channels.cache.find(
        (c) => c.name === args.category_name && c.type === ChannelType.GuildCategory
      );
      if (!cat) return `カテゴリ "${args.category_name}" が見つかりませんでした。`;
      try {
        await cat.delete();
        return `カテゴリ "${args.category_name}" を削除しました。（チャンネルはカテゴリなしになります）`;
      } catch (e) {
        return `削除失敗: ${e.message}`;
      }
    }

    case 'edit_message': {
      const channel = guild.channels.cache.find(
        (c) => c.name === args.channel_name && c.type === ChannelType.GuildText
      );
      if (!channel) return `チャンネル #${args.channel_name} が見つかりませんでした。`;
      try {
        const msg = await channel.messages.fetch(args.message_id);
        await msg.edit(args.new_content);
        return `メッセージ ${args.message_id} を編集しました。`;
      } catch (e) {
        return `編集失敗: ${e.message}`;
      }
    }

    case 'delete_channel': {
      const channel = guild.channels.cache.find(
        (c) => c.name === args.channel_name && c.type === ChannelType.GuildText && !aiChannelIds.has(c.id)
      );
      if (!channel) return `チャンネル #${args.channel_name} が見つかりませんでした。`;
      try {
        await channel.delete();
        return `#${args.channel_name} を削除しました。`;
      } catch (e) {
        return `削除失敗: ${e.message}`;
      }
    }

    case 'fetch_message': {
      const match = args.url.match(/channels\/(\d+)\/(\d+)(?:\/(\d+))?/);
      if (!match) return 'URLの形式が正しくありません。discord.com/channels/... の形式で指定してください。';
      const [, , channelId, messageId] = match;
      const channel = guild.channels.cache.get(channelId);
      if (!channel) return `チャンネルID ${channelId} が見つかりませんでした。`;
      if (!messageId) {
        const fetched = await channel.messages.fetch({ limit: 20 });
        const msgList = [...fetched.values()].reverse();
        const lines = msgList
          .filter((m) => m.content.trim())
          .map((m) => `[${m.id}] ${m.author.username}(メンション:<@${m.author.id}>): ${m.content}`)
          .join('\n');
        const images = msgList.flatMap((m) => extractImageUrls(m));
        return { text: `#${channel.name} の最近のメッセージ:\n${lines || '(メッセージなし)'}`, images };
      }
      try {
        const msg = await channel.messages.fetch(messageId);
        const images = extractImageUrls(msg);
        return {
          text: `チャンネル: #${channel.name}\n送信者: ${msg.author.username}(メンション:<@${msg.author.id}>)\n内容: ${msg.content}\nリンク: https://discord.com/channels/${guild.id}/${channelId}/${messageId}`,
          images,
        };
      } catch (e) {
        return `メッセージ取得失敗: ${e.message}`;
      }
    }

    case 'list_members': {
      try { await guild.members.fetch(); } catch { /* キャッシュのみで続行 */ }
      const members = guild.members.cache
        .filter((m) => !m.user.bot)
        .map((m) => `${m.displayName}(@${m.user.username}) メンション:<@${m.user.id}>`)
        .join('\n');
      return members || 'メンバーが見つかりませんでした。';
    }

    case 'find_member': {
      try { await guild.members.fetch(); } catch { /* キャッシュのみで続行 */ }
      const query = args.name.toLowerCase();
      const found = guild.members.cache.filter(
        (m) =>
          !m.user.bot &&
          (m.displayName.toLowerCase().includes(query) || m.user.username.toLowerCase().includes(query))
      );
      if (found.size === 0) return `"${args.name}" に一致するメンバーが見つかりませんでした。`;
      return found.map((m) => `${m.displayName}(@${m.user.username}) メンション:<@${m.user.id}>`).join('\n');
    }

    case 'search_web': {
      try {
        const res = await fetch(`${WINDOWS_API}/search?q=${encodeURIComponent(args.query)}`, {
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { results } = await res.json();
        if (!results?.length) return '検索結果なし';
        return results.map((r) => `【${r.title}】\n${r.snippet}\n${r.url}`).join('\n\n');
      } catch (e) {
        return `検索失敗: ${e.message}`;
      }
    }

    case 'fetch_url': {
      try {
        const res = await fetch(`${WINDOWS_API}/fetch?url=${encodeURIComponent(args.url)}`, {
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { text } = await res.json();
        return text || '(コンテンツなし)';
      } catch (e) {
        return `取得失敗: ${e.message}`;
      }
    }

    default:
      return `未知のツール: ${name}`;
  }
}

function toolLabel(name, args, result) {
  switch (name) {
    case 'read_channel': return `\`read_channel("${args.channel_name}")\` → ${result.split('\n').filter(Boolean).length}件`;
    case 'send_message': return `\`send_message("${args.channel_name}")\` → 送信完了`;
    case 'create_channel': return `\`create_channel("${args.channel_name}")\` → 作成完了`;
    case 'edit_channel': return `\`edit_channel("${args.channel_name}")\` → 更新完了`;
    case 'edit_message': return `\`edit_message("${args.channel_name}", ${args.message_id})\` → 編集完了`;
    case 'delete_channel': return `\`delete_channel("${args.channel_name}")\` → 削除完了`;
    case 'create_category': return `\`create_category("${args.category_name}")\` → 作成完了`;
    case 'edit_category': return `\`edit_category("${args.category_name}")\` → "${args.new_name}" に変更`;
    case 'delete_category': return `\`delete_category("${args.category_name}")\` → 削除完了`;
    case 'fetch_message': return `\`fetch_message("${args.url.slice(0, 60)}...")\` → 取得完了`;
    case 'list_members': return `\`list_members()\` → ${result.split('\n').filter(Boolean).length}人`;
    case 'find_member': return `\`find_member("${args.name}")\` → ${result.split('\n').length}件`;
    case 'search_web': return `\`search_web("${args.query}")\``;
    case 'fetch_url': return `\`fetch_url("${args.url.slice(0, 50)}...")\``;
    default: return `\`${name}\` → ${result}`;
  }
}

// settings: { provider, model } — optional, falls back to env vars
export async function chatSimple(messages, settings = {}) {
  return callText(messages, { provider: settings.provider, model: settings.model, effort: settings.effort });
}

export async function chatWithTools(messages, { guild, aiChannelIds, onToolCall, settings = {}, member = null }) {
  const msgs = [...messages];
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    const { content, toolCalls, rawMessage } = await providerCallWithTools(msgs, TOOLS, {
      provider: settings.provider,
      model: settings.model,
      effort: settings.effort,
    });

    if (toolCalls) {
      msgs.push(rawMessage);

      const toolResults = await Promise.all(
        toolCalls.map(async (tc) => {
          const result = await executeTool(tc.name, tc.arguments, guild, aiChannelIds, member);
          await onToolCall(toolLabel(tc.name, tc.arguments, result.text)).catch(() => {});
          return { tc, result };
        })
      );

      for (const { tc, result } of toolResults) {
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: result.text });
      }

      const roundImages = toolResults.flatMap(({ result }) => result.images || []).slice(0, 4);
      if (roundImages.length > 0) {
        msgs.push({ role: 'user', content: '(上記ツール結果に含まれる添付画像)', images: roundImages });
      }

      iterations += 1;
    } else {
      if (!content || !content.trim()) {
        msgs.push({ role: 'user', content: 'ツールの実行結果を踏まえて、ユーザーへの回答を生成してください。' });
        const followUp = await callText(msgs, { provider: settings.provider, model: settings.model, effort: settings.effort });
        return { answer: followUp, msgs };
      }
      return { answer: content, msgs };
    }
  }

  msgs.push({ role: 'user', content: '収集した情報をもとに、最初の質問に答えてください。' });
  const answer = await callText(msgs, { provider: settings.provider, model: settings.model, effort: settings.effort });
  return { answer, msgs };
}

export async function generateFinal(messages, settings = {}) {
  return callText(messages, { provider: settings.provider, model: settings.model, effort: settings.effort });
}
