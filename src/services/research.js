import { chatWithTools, buildSystemWithTools } from './llm.js';

const SYSTEM_RESEARCH = `あなたはDiscordサーバーのリサーチアシスタントです。
与えられたクエリについて、Discordチャンネルの内部情報とウェブ検索の両方を使って深掘りリサーチを行い、包括的なレポートを作成してください。

【手順】
1. まずDiscordの関連チャンネルを読んで、サーバー内の既存知識を集める
2. クエリを複数のサブ質問に分解し、それぞれをウェブ検索する
3. 検索結果の上位を fetch_url で実際に読み、内容を確認する
4. 情報が不足している場合は、異なるキーワードや角度から追加検索する
5. 十分な情報が集まったら、最終レポートを作成する

【重要なルール】
- 最低5回以上、異なる検索クエリで調べること
- サーバー内情報とウェブ情報の両方を参照すること
- 得られた情報には必ず引用元（URL または Discord チャンネル名）を記載すること
- 矛盾する情報があれば両論を併記すること
- 日本語で回答すること`;

export async function runResearch(query, contextText, { guild, aiChannelIds, onToolCall, settings = {} }) {
  const channelList = guild
    ? guild.channels.cache
        .filter((c) => c.type === 0 && !aiChannelIds.has(c.id))
        .map((c) => `#${c.name} [ID:${c.id}]${c.topic ? ` (${c.topic})` : ''}`)
        .join('\n')
    : '';

  const systemPrompt = channelList
    ? buildSystemWithTools(channelList) + '\n\n' + SYSTEM_RESEARCH
    : SYSTEM_RESEARCH;

  const messages = [
    { role: 'system', content: systemPrompt },
  ];

  if (contextText) {
    messages.push({
      role: 'system',
      content: `## 会話の背景（参考）\n以下はリサーチクエリに関連する過去の会話から抽出された情報です。\nリサーチの方向性を決める参考にしてください:\n\n${contextText}`,
    });
  }

  messages.push({ role: 'user', content: `以下のリサーチクエリについて、深掘り調査を実行し、包括的なレポートを作成してください。\n\nリサーチクエリ: ${query}` });

  const { answer } = await chatWithTools(messages, {
    guild,
    aiChannelIds,
    onToolCall: async (label) => {
      await onToolCall(`🔍 ${label}`).catch(() => {});
    },
    settings,
  });

  return answer;
}
