import { TOOLS, executeTool, toolLabel } from './tools.js';
import { createAgentSession } from './provider.js';
import { buildSystemPrompt } from './prompt.js';
import { getPersonaConfig, getMemoryDigest } from './personaConfig.js';

const MAX_ITERATIONS = 15;

// 単一ループエージェント。モデル自身がツール使用・調査計画・品質を判断する。
// Router/Planner/Finalizerの多段パイプラインはここに置き換えられた。
export async function runAgent({
  settings = {},
  guild,
  member = null,
  aiChannelIds,
  seed,
  onToolCall,
  onAnswerDelta,
  mode,
  maxIterations = MAX_ITERATIONS,
}) {
  const custom = await getPersonaConfig(guild);
  const memoryDigest = await getMemoryDigest(guild);
  const system = buildSystemPrompt(guild, aiChannelIds, { mode, custom, memoryDigest });
  const session = createAgentSession({
    provider: settings.provider,
    model: settings.model,
    effort: settings.effort,
    system,
    tools: TOOLS,
    seed,
  });

  for (let i = 0; i < maxIterations; i++) {
    const { text, toolCalls } = await session.step({ onTextDelta: onAnswerDelta });

    if (!toolCalls?.length) {
      if (text && text.trim()) return text;
      // 空応答: 1回だけnudgeして最終回答を強制
      await session.addUserText('ツールの実行結果を踏まえて、ユーザーへの回答を生成してください。');
      const retry = await session.step({ noTools: true, onTextDelta: onAnswerDelta });
      return retry.text || '';
    }

    const results = await Promise.all(
      toolCalls.map((tc) => executeTool(tc.name, tc.arguments, guild, aiChannelIds, member))
    );

    if (onToolCall) {
      for (let j = 0; j < results.length; j++) {
        await onToolCall(toolLabel(toolCalls[j].name, toolCalls[j].arguments, results[j].text)).catch(() => {});
      }
    }

    await session.addToolResults(
      toolCalls.map((tc, j) => ({ id: tc.id, text: results[j].text, images: results[j].images }))
    );
  }

  // ループ上限到達: ツールなしで最終回答を強制
  await session.addUserText('収集した情報をもとに、最初の質問に最終回答してください。');
  const final = await session.step({ noTools: true, onTextDelta: onAnswerDelta });
  return final.text || '';
}
