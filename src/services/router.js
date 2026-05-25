import { GoogleGenAI } from '@google/genai';
import { callText } from './provider.js';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MAX_RETRIES = 3;

const SYSTEM_PROMPT = `あなたはタスク分類器です。ユーザーのメッセージを "simple" か "complex" に分類してください。

simple: 「今日の天気は？」「JavaScriptとは？」のような、誰でも知っている一般常識・雑談のみ
complex: それ以外すべて。固有名詞・プロジェクト名・人名・サービス名・「〜とは？」という質問・サーバー内の出来事など、少しでもサーバー固有の情報が必要かもしれない場合は必ず complex にすること

判断に迷ったら complex にしてください。

必ず以下のJSON形式のみで返してください:
{"type":"simple","reason":"理由"} または {"type":"complex","reason":"理由"}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function classifyOnce(userMessage, serverInfo, routerProvider, routerModel) {
  const systemWithContext = serverInfo
    ? `${SYSTEM_PROMPT}\n\n--- このサーバーの情報（参考） ---\n${serverInfo}\n---`
    : SYSTEM_PROMPT;

  let raw;
  if (routerProvider === 'gemini') {
    // Gemini SDK with JSON mode for guaranteed JSON output
    const response = await ai.models.generateContent({
      model: routerModel || 'gemini-2.5-flash-lite',
      contents: userMessage,
      config: {
        systemInstruction: systemWithContext,
        responseMimeType: 'application/json',
        maxOutputTokens: 150,
      },
    });
    raw = response.text ?? '';
  } else {
    raw = await callText(
      [
        { role: 'system', content: systemWithContext },
        { role: 'user', content: userMessage },
      ],
      { provider: routerProvider, model: routerModel, maxTokens: 150 }
    );
  }

  // まず JSON.parse を試みる
  try {
    const parsed = JSON.parse(raw);
    if (parsed.type === 'simple' || parsed.type === 'complex') {
      return { type: parsed.type, reason: parsed.reason ?? parsed.type };
    }
  } catch (_) {
    // JSON.parse 失敗時は正規表現フォールバック
  }

  // 正規表現で type と reason を個別に抽出
  const typeMatch = raw.match(/"type"\s*:\s*"(simple|complex)"/i);
  if (!typeMatch) throw new Error(`No valid type in response: ${raw.slice(0, 100)}`);
  const reasonMatch = raw.match(/"reason"\s*:\s*"([^"]*)"/i);

  return { type: typeMatch[1].toLowerCase(), reason: reasonMatch?.[1] ?? typeMatch[1].toLowerCase() };
}

export async function classify(
  userMessage,
  serverInfo = '',
  { routerProvider = 'gemini', routerModel = null } = {}
) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await classifyOnce(userMessage, serverInfo, routerProvider, routerModel);
      console.log(`[router] ${result.type} via ${routerProvider} (attempt ${attempt})`);
      return result;
    } catch (e) {
      lastError = e;
      console.warn(`[router] attempt ${attempt} failed: ${e.message}`);
      if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
    }
  }

  console.warn('[router] All retries failed, defaulting to complex');
  return { type: 'complex', reason: 'fallback' };
}
