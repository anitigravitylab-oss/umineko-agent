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
        const parts = [];
        if (msg.content) parts.push({ text: msg.content });
        for (const tc of msg.tool_calls) {
          const part = {
            functionCall: { name: tc.function.name, args: JSON.parse(tc.function.arguments) },
          };
          if (tc._thoughtSignature) part.thoughtSignature = tc._thoughtSignature;
          parts.push(part);
        }
        contents.push({ role: 'model', parts });
      } else {
        contents.push({ role: 'model', parts: [{ text: msg.content ?? '' }] });
      }
    } else if (msg.role === 'tool') {
      const name = findToolName(messages, msg.tool_call_id);
      contents.push({
        role: 'user',
        parts: [{ functionResponse: { name, response: { output: String(msg.content ?? '') } } }],
      });
    }
  }
  return contents;
}

function isGeminiRetryable(e) {
  return e.status === 503 || e.status === 429 ||
    (typeof e.message === 'string' && (e.message.includes('UNAVAILABLE') || e.message.includes('overloaded')));
}

function makeCallId() {
  return `call_${Math.random().toString(36).slice(2, 10)}`;
}

// ── Claude (Anthropic) via Max-subscription OAuth token ─────────────────
// Uses the Messages API with an OAuth bearer token (sk-ant-oat01-...) instead
// of an API key. Requires the Claude Code identity as the first system block.
const ANTHROPIC_BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getClaudeToken() {
  const raw = process.env.CLAUDE_CODE_OAUTH_TOKEN
    || process.env.CLAUDE_OAUTH_TOKEN
    || process.env.ANTHROPIC_OAUTH_TOKEN
    || '';
  return raw.replace(/\s+/g, ''); // tokens are pasted with stray spaces sometimes
}

function isClaudeRetryable(status) {
  return status === 429 || status === 500 || status === 503 || status === 529;
}

// Build the Anthropic `system` param: Claude Code identity first, then the
// app's own system prompt(s) joined together.
function buildClaudeSystem(messages) {
  const sys = messages
    .filter((ms) => ms.role === 'system')
    .map((ms) => ms.content)
    .filter(Boolean)
    .join('\n\n');
  const blocks = [{ type: 'text', text: CLAUDE_CODE_IDENTITY }];
  if (sys) blocks.push({ type: 'text', text: sys });
  return blocks;
}

function toClaudeTools(tools) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

// Convert OpenAI-format messages → Anthropic messages.
// - system messages are handled separately (buildClaudeSystem)
// - assistant tool_calls → tool_use content blocks
// - tool results → user message with tool_result blocks
function toClaudeMessages(messages) {
  const raw = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      const text = (msg.content ?? '').toString();
      if (text.trim()) raw.push({ role: 'user', content: [{ type: 'text', text }] });
    } else if (msg.role === 'assistant') {
      const blocks = [];
      if (msg.content && msg.content.toString().trim()) {
        blocks.push({ type: 'text', text: msg.content.toString() });
      }
      if (msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = {}; }
          blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
      }
      if (blocks.length) raw.push({ role: 'assistant', content: blocks });
    } else if (msg.role === 'tool') {
      const content = (msg.content ?? '').toString() || '(empty)';
      raw.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: msg.tool_call_id, content }] });
    }
  }
  // Merge adjacent same-role messages (tool_result blocks must share one user turn).
  const merged = [];
  for (const m of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content.push(...m.content);
    else merged.push({ role: m.role, content: [...m.content] });
  }
  // Anthropic requires the conversation to start with a user message.
  while (merged.length && merged[0].role === 'assistant') merged.shift();
  if (merged.length === 0) merged.push({ role: 'user', content: [{ type: 'text', text: '(no content)' }] });
  return merged;
}

async function claudeFetch(body) {
  const token = getClaudeToken();
  if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is not set');
  const MAX_RETRIES = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      lastErr = e;
      if (attempt < MAX_RETRIES) { await sleep(attempt * 3000); continue; }
      throw e;
    }
    if (res.ok) return res.json();
    const errText = await res.text().catch(() => '');
    if (isClaudeRetryable(res.status) && attempt < MAX_RETRIES) {
      console.warn(`[provider] Claude ${res.status} attempt ${attempt}, retrying in ${attempt * 3}s...`);
      lastErr = new Error(`Claude HTTP ${res.status}: ${errText.slice(0, 200)}`);
      await sleep(attempt * 3000);
      continue;
    }
    throw new Error(`Claude HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  throw lastErr ?? new Error('claudeFetch failed after retries');
}

async function claudeCallText(messages, { maxTokens, model }) {
  const data = await claudeFetch({
    model,
    max_tokens: maxTokens,
    system: buildClaudeSystem(messages),
    messages: toClaudeMessages(messages),
  });
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text || !text.trim()) {
    console.warn(`[provider] Claude callText returned empty (model=${model}, stop=${data.stop_reason})`);
  }
  return text;
}

async function claudeCallWithTools(messages, tools, { model }) {
  const data = await claudeFetch({
    model,
    max_tokens: 4096,
    system: buildClaudeSystem(messages),
    tools: toClaudeTools(tools),
    messages: toClaudeMessages(messages),
  });
  const blocks = data.content ?? [];
  const toolUse = blocks.filter((b) => b.type === 'tool_use');
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');

  if (toolUse.length > 0) {
    const toolCalls = toolUse.map((b) => ({ id: b.id, name: b.name, arguments: b.input ?? {} }));
    const rawMessage = {
      role: 'assistant',
      content: text || null,
      tool_calls: toolUse.map((b) => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      })),
    };
    return { content: text || null, toolCalls, rawMessage };
  }
  return { content: text, toolCalls: null, rawMessage: null };
}

// ── callText: simple text completion, returns string ───────────────────
// provider/model are optional — fall back to env vars if omitted
export async function callText(messages, { maxTokens = 4096, provider, model } = {}) {
  const { p, m } = resolveProviderModel(provider, model);
  // Collect ALL system messages (not just the first one)
  const systemMsgs = messages.filter((ms) => ms.role === 'system');
  const systemInstruction = systemMsgs.map((ms) => ms.content).join('\n\n') || undefined;

  if (p === 'claude') {
    return claudeCallText(messages, { maxTokens, model: m });
  }

  if (p === 'gemini') {
    const MAX_GEMINI_RETRIES = 3;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_GEMINI_RETRIES; attempt++) {
      try {
        const response = await getGemini().models.generateContent({
          model: m,
          contents: toGeminiContents(messages),
          config: { systemInstruction, maxOutputTokens: maxTokens },
        });
        return response.text ?? '';
      } catch (e) {
        if (isGeminiRetryable(e) && attempt < MAX_GEMINI_RETRIES) {
          console.warn(`[provider] Gemini callText 503/429 attempt ${attempt}, retrying in ${attempt * 5}s...`);
          await new Promise((r) => setTimeout(r, attempt * 5000));
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    throw lastErr;
  }

  const tokenParam = p === 'openai' ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
  const completion = await getOpenAIClient(p).chat.completions.create({
    model: m,
    messages,
    ...tokenParam,
  });
  const content = completion.choices?.[0]?.message?.content ?? '';
  if (!content || !content.trim()) {
    console.warn(`[provider] callText returned empty/null content (model=${m}, finish=${completion.choices?.[0]?.finish_reason})`);
  }
  return content;
}

// ── callWithTools: tool-use completion ────────────────────────────────
// Returns { content, toolCalls, rawMessage }
// toolCalls: [{id, name, arguments: object}] | null
// rawMessage: OpenAI-format assistant message to push into msgs
export async function callWithTools(messages, tools, { provider, model } = {}) {
  const { p, m } = resolveProviderModel(provider, model);

  if (p === 'claude') {
    return claudeCallWithTools(messages, tools, { model: m });
  }

  if (p === 'gemini') {
    const systemInstruction = messages
      .filter((ms) => ms.role === 'system')
      .map((ms) => ms.content)
      .join('\n\n') || undefined;
    const MAX_GEMINI_RETRIES = 3;
    let lastErr;
    let response;
    for (let attempt = 1; attempt <= MAX_GEMINI_RETRIES; attempt++) {
      try {
        response = await getGemini().models.generateContent({
          model: m,
          contents: toGeminiContents(messages),
          config: {
            systemInstruction,
            tools: toGeminiTools(tools),
            maxOutputTokens: 4096,
            thinkingConfig: { thinkingBudget: 0 },
          },
        });
        break;
      } catch (e) {
        if (isGeminiRetryable(e) && attempt < MAX_GEMINI_RETRIES) {
          console.warn(`[provider] Gemini callWithTools 503/429 attempt ${attempt}, retrying in ${attempt * 5}s...`);
          await new Promise((r) => setTimeout(r, attempt * 5000));
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    if (!response) throw lastErr;

    const respParts = response.candidates?.[0]?.content?.parts ?? [];
    const fnParts = respParts.filter((p) => p.functionCall);
    if (fnParts.length > 0) {
      const toolCalls = fnParts.map((p) => ({
        id: makeCallId(),
        name: p.functionCall.name,
        arguments: p.functionCall.args,
        _thoughtSignature: p.thoughtSignature,
      }));
      const rawMessage = {
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
          _thoughtSignature: tc._thoughtSignature,
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
      const tokenParam = p === 'openai' ? { max_completion_tokens: 4096 } : { max_tokens: 4096 };
      completion = await getOpenAIClient(p).chat.completions.create({
        model: m,
        messages,
        tools,
        ...tokenParam,
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
