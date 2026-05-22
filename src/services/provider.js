import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';
import { MODEL_DEFAULTS } from './constants.js';

// ── OpenAI-compatible clients (keyed by provider name) ────────────────
const openaiClients = {};

function getOpenAIClient(provider) {
  if (!openaiClients[provider]) {
    openaiClients[provider] = provider === 'deepseek'
      ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com' })
      : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClients[provider];
}

// ── Gemini client ──────────────────────────────────────────────────────
let _gemini = null;
function getGemini() {
  if (!_gemini) _gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return _gemini;
}

function resolveProviderModel(provider, model) {
  const p = provider || (process.env.AI_PROVIDER || 'deepseek').toLowerCase();
  const m = model || process.env.AI_MODEL || MODEL_DEFAULTS[p] || 'deepseek-chat';
  return { p, m };
}

// ── Gemini format converters ───────────────────────────────────────────
function toGeminiTools(tools) {
  return [{
    functionDeclarations: tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    })),
  }];
}

function findToolName(messages, toolCallId) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const tc = messages[i].tool_calls?.find((t) => t.id === toolCallId);
    if (tc) return tc.function.name;
  }
  return 'unknown';
}

function toGeminiContents(messages) {
  const contents = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: msg.content ?? '' }] });
    } else if (msg.role === 'assistant') {
      if (msg.tool_calls?.length) {
        contents.push({
          role: 'model',
          parts: msg.tool_calls.map((tc) => ({
            functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments) },
          })),
        });
      } else {
        contents.push({ role: 'model', parts: [{ text: msg.content ?? '' }] });
      }
    } else if (msg.role === 'tool') {
      const name = findToolName(messages, msg.tool_call_id);
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: { output: msg.content } } }],
      });
    }
  }
  return contents;
}

function makeCallId() {
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}

// ── callText: simple text completion, returns string ───────────────────
// provider/model are optional — fall back to env vars if omitted
export async function callText(messages, { maxTokens = 4096, provider, model } = {}) {
  const { p, m } = resolveProviderModel(provider, model);
  const systemMsg = messages.find((ms) => ms.role === 'system');

  if (p === 'gemini') {
    const response = await getGemini().models.generateContent({
      model: m,
      contents: toGeminiContents(messages),
      config: { systemInstruction: systemMsg?.content, maxOutputTokens: maxTokens },
    });
    return response.text ?? '';
  }

  const completion = await getOpenAIClient(p).chat.completions.create({
    model: m,
    messages,
    max_tokens: maxTokens,
  });
  return completion.choices[0].message.content ?? '';
}

// ── callWithTools: tool-use completion ────────────────────────────────
// Returns { content, toolCalls, rawMessage }
// toolCalls: [{id, name, arguments: object}] | null
// rawMessage: OpenAI-format assistant message to push into msgs
export async function callWithTools(messages, tools, { provider, model } = {}) {
  const { p, m } = resolveProviderModel(provider, model);

  if (p === 'gemini') {
    const systemMsg = messages.find((ms) => ms.role === 'system');
    const response = await getGemini().models.generateContent({
      model: m,
      contents: toGeminiContents(messages),
      config: {
        systemInstruction: systemMsg?.content,
        tools: toGeminiTools(tools),
        maxOutputTokens: 4096,
      },
    });

    const fnCalls = response.functionCalls?.() ?? [];
    if (fnCalls.length > 0) {
      const toolCalls = fnCalls.map((fc) => ({
        id: makeCallId(),
        name: fc.name,
        arguments: fc.args,
      }));
      const rawMessage = {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        })),
      };
      return { content: null, toolCalls, rawMessage };
    }

    return { content: response.text ?? '', toolCalls: null, rawMessage: null };
  }

  // DeepSeek / OpenAI — with retry for 503
  const MAX_RETRIES = 3;
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let completion;
    try {
      completion = await getOpenAIClient(p).chat.completions.create({
        model: m,
        messages,
        tools,
        max_tokens: 4096,
      });
    } catch (e) {
      if (e.status === 503 && attempt < MAX_RETRIES) {
        console.warn(`[provider] 503 attempt ${attempt}, retrying in ${attempt * 5}s...`);
        await new Promise((r) => setTimeout(r, attempt * 5000));
        lastError = e;
        continue;
      }
      throw e;
    }

    const choice = completion.choices[0];
    if (choice.finish_reason === 'tool_calls') {
      return {
        content: null,
        toolCalls: choice.message.tool_calls.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments),
        })),
        rawMessage: choice.message,
      };
    }
    return { content: choice.message.content ?? '', toolCalls: null, rawMessage: null };
  }
  throw lastError ?? new Error('callWithTools failed after retries');
}
