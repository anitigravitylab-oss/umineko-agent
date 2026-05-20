const API_URL = 'https://api.deepseek.com/chat/completions';

const SYSTEM = `あなたは回答品質チェッカーです。
ユーザーの質問に対して回答が十分かどうか判定してください。
「わかりません」「情報がありません」「確認できませんでした」など実質的に答えられていない場合のみ ok=false。
回答に何らかの具体的な情報があれば ok=true。
必ず以下のJSON形式のみで返してください:
{"ok":true} または {"ok":false,"feedback":"不足している点と改善指示"}`;

export async function verifyAnswer(question, answer) {
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `質問: ${question}\n\n回答:\n${answer}` },
        ],
        max_tokens: 200,
      }),
    });

    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    const raw = data.choices[0].message.content ?? '';

    const okMatch = raw.match(/"ok"\s*:\s*(true|false)/);
    const ok = okMatch?.[1] !== 'false';
    const feedbackMatch = raw.match(/"feedback"\s*:\s*"([^"]+)"/);
    const feedback = feedbackMatch?.[1] ?? '';
    console.log(`[verifier] ok=${ok}${feedback ? ` feedback=${feedback}` : ''}`);
    return { ok, feedback };
  } catch (e) {
    console.warn(`[verifier] failed: ${e.message}`);
    return { ok: true, feedback: '' };
  }
}
