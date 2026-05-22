import { callText } from './provider.js';

const SYSTEM = `あなたはDiscordチャットボットの回答整形・品質チェック担当です。
以下の作業を行ってください:

1. 【整形】以下を除去・修正する
   - ツール呼び出しの生マークアップ（<｜｜DSML｜｜...> など）
   - 「念のため確認します」「ツールで〜しました」などの内部処理への言及
   - 「おっしゃる通り、前回の回答では〜」のような不自然な謝罪前置き
   - ユーザーには関係ない作業ログ的な記述

2. 【品質チェック】整形後の回答がユーザーの指示・質問に対して適切か判定する
   - アクション系の指示（送信・記録・作成・編集・削除など）: 「〜しました」「〜に記録しました」など実行完了を伝えていれば ok=true。送信した内容の詳細を回答に含める必要はない
   - 質問の場合: 具体的な情報で答えているか
   - 「わかりません」「確認できません」だけで終わっている場合は ok=false
   - 絵文字や短い締めの文句があっても、アクションの完了が伝わっていれば ok=true

必ず以下のJSON形式のみで返してください:
{"ok":true,"answer":"整形済みの最終回答"}
または
{"ok":false,"feedback":"問題点と改善指示"}`;

export async function finalizeResponse(userMessage, rawAnswer, history = []) {
  const cleaned = rawAnswer?.trim() ?? '';

  if (!cleaned) {
    return { ok: false, feedback: '回答が空です。ユーザーの指示に対して適切な回答を生成してください。' };
  }

  try {
    const raw = await callText([
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: [
          history.length > 0
            ? '## 直近の会話履歴\n' +
              history.slice(-10).map((m) => `${m.role === 'user' ? 'ユーザー' : 'AI'}: ${m.content}`).join('\n')
            : null,
          `## 今回のユーザーの指示\n${userMessage}`,
          `## 回答\n${cleaned}`,
        ].filter(Boolean).join('\n\n'),
      },
    ], { maxTokens: 2000 });

    const okMatch = raw.match(/"ok"\s*:\s*(true|false)/);
    const ok = okMatch?.[1] !== 'false';

    if (ok) {
      const answerMatch = raw.match(/"answer"\s*:\s*"([\s\S]+?)"\s*[,}]/);
      // JSON全体をパースして answer を取得
      try {
        const parsed = JSON.parse(raw);
        return { ok: true, answer: parsed.answer ?? cleaned };
      } catch {
        return { ok: true, answer: cleaned };
      }
    } else {
      const feedbackMatch = raw.match(/"feedback"\s*:\s*"([^"]+)"/);
      return { ok: false, feedback: feedbackMatch?.[1] ?? '回答が不十分です' };
    }
  } catch (e) {
    console.warn(`[finalizer] failed: ${e.message}`);
    return { ok: true, answer: cleaned };
  }
}
