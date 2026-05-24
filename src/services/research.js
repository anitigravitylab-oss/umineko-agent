import { callText, callWithTools } from './provider.js';

const MAX_ITERATIONS = 15;

const WEB_ONLY_TOOLS = [
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

const SYSTEM_RESEARCH = `あなたはDiscordサーバーのリサーチアシスタントです。
与えられたクエリについて、ウェブ検索を使って深掘りリサーチを行い、包括的なレポートを作成してください。

【手順】
1. クエリを複数のサブ質問に分解し、それぞれについて検索する
2. 検索結果の上位を fetch_url で実際に読み、内容を確認する
3. 情報が不足している場合は、異なるキーワードや角度から追加検索する
4. 十分な情報が集まったら、最終レポートを作成する

【重要なルール】
- 最低5回以上、異なる検索クエリで調べること
- 得られた情報には必ず引用元URLを記載すること
- 矛盾する情報があれば両論を併記すること
- 日本語で回答すること`;

async function executeTool(name, args) {
  console.log(`[research:tool] ${name} ${JSON.stringify(args)}`);
  const WINDOWS_API = `http://${process.env.WINDOWS_API_HOST || 'localhost'}:7654`;
  let result;
  try {
    switch (name) {
      case 'search_web': {
        const res = await fetch(`${WINDOWS_API}/search?q=${encodeURIComponent(args.query)}`, {
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { results } = await res.json();
        if (!results?.length) return '検索結果なし';
        result = results.map((r) => `【${r.title}】\n${r.snippet}\n${r.url}`).join('\n\n');
        break;
      }
      case 'fetch_url': {
        const res = await fetch(`${WINDOWS_API}/fetch?url=${encodeURIComponent(args.url)}`, {
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const { text } = await res.json();
        result = text || '(コンテンツなし)';
        break;
      }
      default:
        result = `未知のツール: ${name}`;
    }
  } catch (e) {
    result = `エラー: ${e.message}`;
  }
  const preview = (result ?? '').slice(0, 120);
  console.log(`[research:tool] ${name} → ${preview}`);
  return result;
}

function toolLabel(name, args) {
  switch (name) {
    case 'search_web': return `検索: "${args.query}"`;
    case 'fetch_url': return `取得: ${args.url.slice(0, 60)}...`;
    default: return name;
  }
}

// settings: { provider, model }
export async function runResearch(query, contextText, settings = {}, onStatus = async () => {}) {
  const msgs = [
    { role: 'system', content: SYSTEM_RESEARCH },
  ];

  if (contextText) {
    msgs.push({
      role: 'system',
      content: `## 会話の背景（参考）\n以下はリサーチクエリに関連する過去の会話から抽出された情報です。\nリサーチの方向性を決める参考にしてください:\n\n${contextText}`,
    });
  }

  msgs.push({ role: 'user', content: `以下のリサーチクエリについて、深掘り調査を実行し、包括的なレポートを作成してください。\n\nリサーチクエリ: ${query}` });

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    const { content, toolCalls, rawMessage } = await callWithTools(msgs, WEB_ONLY_TOOLS, {
      provider: settings.provider,
      model: settings.model,
    });

    if (toolCalls) {
      msgs.push(rawMessage);

      const toolResults = await Promise.all(
        toolCalls.map(async (tc) => {
          const result = await executeTool(tc.name, tc.arguments);
          await onStatus(`🔍 ${toolLabel(tc.name, tc.arguments)}`).catch(() => {});
          return { tc, result };
        })
      );

      for (const { tc, result } of toolResults) {
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      iterations += 1;
    } else {
      return content || '';
    }
  }

  // 上限到達: 集めた情報で最終レポートを生成
  msgs.push({
    role: 'user',
    content: 'ここまで集めた情報をもとに、包括的な最終レポートを作成してください。引用元URLを必ず記載すること。',
  });
  const finalReport = await callText(msgs, {
    maxTokens: 8192,
    provider: settings.provider,
    model: settings.model,
  });
  return finalReport;
}
