import { extractImageUrls } from './attachments.js';

const HISTORY_LIMIT = 50;

export async function buildConversationHistory(channel, currentMessageId, botUserId) {
  // 現在のメッセージより前を最大70件取得（フィルタ後に50件確保するため余裕を持つ）
  const fetched = await channel.messages.fetch({ limit: 70, before: currentMessageId });

  const history = [...fetched.values()]
    .reverse() // 古い順に並べ直す
    .filter((m) => {
      // ステータスメッセージ（> で始まる）は除外
      if (m.author.id === botUserId && m.content.startsWith('> ')) return false;
      // 空メッセージは除外
      if (m.content.trim().length === 0) return false;
      return true;
    })
    .slice(-HISTORY_LIMIT)
    .map((m) => {
      const images = extractImageUrls(m);
      return {
        role: m.author.id === botUserId ? 'assistant' : 'user',
        content: m.content,
        ...(images.length ? { images } : {}),
      };
    });

  return history;
}
