import { callText } from './provider.js';

const SYSTEM = `あなたはDiscordサーバーのAIアシスタントのプランナーです。
ユーザーの指示を実行するための計画を立ててください。

- 情報収集が必要な場合のみ channels に読むべきチャンネル名を列挙する
- チャンネルの作成・送信・編集など書き込み系の指示で読む必要がなければ channels は空配列にする
- approach には一文で実行方針を書く

必ず以下のJSON形式のみで返してください:
{"channels":["channel-name"],"approach":"一文で実行方針"}
情報収集不要な例: {"channels":[],"approach":"指定チャンネルにメッセージを送信する"}`;

export async function planSearch(userMessage, channelList, history = [], settings = {}) {
  const recentHistory = history.slice(-10);
  const historyText = recentHistory.length > 0
    ? '## 直近の会話履歴\n' +
      recentHistory.map((m) => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content}`).join('\n') +
      '\n\n'
    : '';

  try {
    const raw = await callText([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `${historyText}## 利用可能なチャンネル\n${channelList}\n\n## 今回の指示\n${userMessage}` },
    ], { maxTokens: 300, provider: settings.provider, model: settings.model, effort: settings.effort });

    const channelsMatch = raw.match(/"channels"\s*:\s*\[([^\]]*)\]/);
    const channels = channelsMatch
      ? [...channelsMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
      : [];

    const approachMatch = raw.match(/"approach"\s*:\s*"([^"]+)"/);
    const approach = approachMatch?.[1] ?? '';

    console.log(`[planner] channels=[${channels.join(', ')}] approach=${approach}`);
    return { channels, approach };
  } catch (e) {
    console.warn(`[planner] failed: ${e.message}`);
    return { channels: [], approach: '' };
  }
}
