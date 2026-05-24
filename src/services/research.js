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

const PROMPT_EXTRACT_USER = `あなたはユーザー分析の専門家です。
以下はDiscord上での特定ユーザーの全発言履歴です。

この発言履歴から、以下の項目をできるだけ詳細に抽出してください:

1. **興味・関心領域**: どんな技術・分野・話題に繰り返し言及しているか
2. **スキル・知識**: どの分野に詳しそうか、どんな技術スタックを持っているか
3. **進行中のプロジェクト**: 何を作っているか、どんな課題に取り組んでいるか
4. **価値観・こだわり**: 判断や選択の基準、よく使うフレーズ、思想的な傾向
5. **経歴・文脈**: 発言から推測できる経歴、所属、やってきたこと
6. **人間関係**: 誰とよく話しているか、メンションの傾向（IDはそのまま記載）

各項目について、具体的な発言内容を引用しながら記述してください。
最大2000文字。情報がない項目は「不明」と記載すること。`;

const PROMPT_PLAN = `あなたはリサーチ計画の立案者です。
与えられたクエリと、事前に収集したDiscordチャンネルの情報をもとに、ウェブ検索の調査計画を立ててください。

以下のJSON形式で返してください:
{
  "subQuestions": ["サブ質問1", "サブ質問2", ...],
  "searchQueries": ["検索キーワード1", "検索キーワード2", ...],
  "angles": ["調査の観点1", "調査の観点2", ...]
}

- subQuestions: リサーチクエリを分解した具体的なサブ質問（3〜7個）
- searchQueries: 実際に検索に使うキーワード（5〜10個、多角的に）
- angles: 調査すべき観点や切り口（例: 歴史的背景、技術仕様、賛否両論など）
- Discord情報が得られている場合は、それを補完するような検索キーワードを含めること`;

const SYSTEM_RESEARCH = `あなたはリサーチアシスタントです。
与えられた調査計画に沿って、ウェブ検索を使って深掘りリサーチを行い、包括的なレポートを作成してください。

【手順】
1. 調査計画の各サブ質問について、対応する検索キーワードで検索する
2. 検索結果の上位を fetch_url で実際に読み、内容を確認する
3. 情報が不足している場合は、計画になかった角度からも追加検索する
4. すべての観点をカバーできたら、最終レポートを作成する

【重要なルール】
- 調査計画の全サブ質問と全観点をカバーすること
- 得られた情報には必ず引用元URLを記載すること
- Discordから得た情報とWebの情報を統合して回答すること
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

// userMessages: [{channel, content}, ...]
export async function extractUserContext(userMessages, settings = {}) {
  if (!userMessages || userMessages.length === 0) return '';

  const text = userMessages
    .map((m) => `[#${m.channel}] ${m.content}`)
    .join('\n');

  try {
    const summary = await callText([
      { role: 'system', content: PROMPT_EXTRACT_USER },
      { role: 'user', content: `## ユーザーの全発言履歴\n${text}` },
    ], { maxTokens: 2500, provider: settings.provider, model: settings.model });

    if (!summary || !summary.trim()) {
      console.warn(`[research:user] callText returned empty (${userMessages.length} messages, ${text.length} chars)`);
      return '';
    }
    console.log(`[research:user] extracted profile: ${summary.slice(0, 150)}...`);
    return summary;
  } catch (e) {
    console.warn(`[research:user] failed: ${e.message}`);
    return '';
  }
}

// settings: { provider, model }
export async function planResearch(query, channelContext, settings = {}) {
  const prompt = [
    `## リサーチクエリ\n${query}`,
    channelContext ? `## Discordチャンネルから収集した情報\n${channelContext}` : '',
    '上記をもとに、ウェブ検索の調査計画を立ててください。',
  ].filter(Boolean).join('\n\n');

  try {
    const raw = await callText([
      { role: 'system', content: PROMPT_PLAN },
      { role: 'user', content: prompt },
    ], { maxTokens: 1500, provider: settings.provider, model: settings.model });

    // JSONを抽出
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const plan = JSON.parse(jsonMatch[0]);
      console.log(`[research:plan] subQuestions=${plan.subQuestions?.length ?? 0} searchQueries=${plan.searchQueries?.length ?? 0} angles=${plan.angles?.length ?? 0}`);
      return plan;
    }
    // JSONパース失敗時は生テキストを返す
    console.warn(`[research:plan] JSON parse failed, returning rawPlan (${raw.length} chars)`);
    return { rawPlan: raw };
  } catch (e) {
    console.warn(`[research:plan] failed: ${e.message}`, e.stack);
    return {};
  }
}

// settings: { provider, model }
export async function runResearch(query, contextText, settings = {}, onStatus = async () => {}) {
  // 調査計画を contextText から取り出す（planResearchの結果がJSONとして渡される想定）
  let researchPlan = '';
  if (contextText) {
    researchPlan = `## 事前収集情報と調査計画\n${contextText}`;
  }

  const msgs = [
    { role: 'system', content: SYSTEM_RESEARCH },
  ];

  if (researchPlan) {
    msgs.push({ role: 'system', content: researchPlan });
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
