const API_URL = 'https://api.deepseek.com/chat/completions';

const SYSTEM = `あなたはWeb情報の充足性チェッカーです。
ユーザーの質問に対して、収集したWeb情報が十分かどうかを判定してください。

sufficient=true にする条件（両方満たす）:
- 質問に直接答えられる具体的な内容がある
- 「見つかりませんでした」「検索結果なし」だけで終わっていない

sufficient=false にする条件（どれか一つでも）:
- 「見つかりませんでした」「情報が見つからない」などで回答が終わっている
- 検索結果がすべて空または無関係
- 異なるキーワードで再検索すれば改善できそう

必ず以下のJSON形式のみで返してください:
{"sufficient":true} または {"sufficient":false,"feedback":"具体的に何のキーワードで再検索すべきか"}`;

export async function checkWebSufficiency(userMessage, answer) {
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
          { role: 'user', content: `質問: ${userMessage}\n\n収集した情報と現在の回答:\n${answer}` },
        ],
        max_tokens: 200,
      }),
    });

    if (!res.ok) throw new Error(`API error ${res.status}`);
    const data = await res.json();
    const raw = data.choices[0].message.content ?? '';

    const match = raw.match(/"sufficient"\s*:\s*(true|false)/);
    const sufficient = match?.[1] !== 'false';
    const feedbackMatch = raw.match(/"feedback"\s*:\s*"([^"]+)"/);
    const feedback = feedbackMatch?.[1] ?? '';

    console.log(`[webChecker] sufficient=${sufficient}${feedback ? ` feedback=${feedback}` : ''}`);
    return { sufficient, feedback };
  } catch (e) {
    console.warn(`[webChecker] failed: ${e.message}`);
    return { sufficient: true, feedback: '' };
  }
}
