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

function toClaudeTools(tools) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

// NOTE: Anthropic's `image.source.type: 'url'` (server-side fetch) reliably
// fails with "Unable to download the file" over this bot's OAuth/Max-subscription
// auth path (anthropic-beta: oauth-2025-04-20), even for public, reachable URLs —
// confirmed via direct API testing. Fetching the bytes ourselves and sending
// base64 works reliably, so we do that instead.
const MAX_IMAGE_FETCH_BYTES = 8 * 1024 * 1024; // 8MB safety cap

function guessImageMediaType(url) {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

async function fetchImageAsBase64(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMAGE_FETCH_BYTES) throw new Error(`image too large (${buf.length} bytes)`);
    const mediaType = res.headers.get('content-type')?.split(';')[0] || guessImageMediaType(url);
    return { mediaType, data: buf.toString('base64') };
  } catch (e) {
    console.warn(`[provider] Claude image fetch failed for ${url.slice(0, 100)}: ${e.message}`);
    return null;
  }
}

// Convert seed messages (OpenAI-style {role, content, images?}) → Anthropic messages.
// Used once when a Claude session starts; after that the session appends
// native Anthropic blocks directly.
async function toClaudeMessages(messages) {
  const raw = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    if (msg.role === 'user') {
      const text = (msg.content ?? '').toString();
      const blocks = [];
      if (text.trim()) blocks.push({ type: 'text', text });
      if (msg.images?.length) {
        const fetched = await Promise.all(msg.images.map(fetchImageAsBase64));
        for (const img of fetched) {
          if (img) blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
        }
      }
      if (blocks.length) raw.push({ role: 'user', content: blocks });
    } else if (msg.role === 'assistant') {
      const blocks = [];
      if (msg.content && msg.content.toString().trim()) {
        blocks.push({ type: 'text', text: msg.content.toString() });
      }
      if (blocks.length) raw.push({ role: 'assistant', content: blocks });
    }
  }
  // Merge adjacent same-role messages into one turn.
  const merged = [];
  for (const m of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content.push(...m.content);
    else merged.push({ role: m.role, content: [...m.content] });
  }
  // Anthropic requires the conversation to start with a user message.
  while (merged.length && merged[0].role === 'assistant') merged.shift();
  if (merged.length === 0) merged.push({ role: 'user', content: [{ type: 'text', text: '(no content)' }] });
  // Anthropic rejects a conversation ending on 'assistant' (no prefill support).
  // Anchor the conversation back onto a valid trailing user turn.
  if (merged[merged.length - 1].role === 'assistant') {
    merged.push({ role: 'user', content: [{ type: 'text', text: '続けてください。' }] });
  }
  return merged;
}

// Claude Fable 5 has more active safety classifiers than Opus/Sonnet-tier
// models and can decline benign-adjacent requests (stop_reason: "refusal").
// Anthropic recommends opting into server-side fallback by default so a
// refusal is transparently retried on Opus 4.8 within the same request.
const FABLE5_MODEL = 'claude-fable-5';

// ── SSEストリーミング（Claude） ───────────────────────────────────────
// stream:trueのレスポンスを、非ストリーミング時のres.json()と同じ形
// ({ model, content, stop_reason, usage }) に再組み立てする。こうすることで
// step()側は非ストリーミング/ストリーミングを区別せず同じ後処理で扱える。
// onTextDeltaはtext_deltaのたびに累積テキスト全体で呼ぶ（thinkingのテキスト
// は流さない）。signature_deltaを落とすと次反復のthinkingリプレイがAPIに
// 拒否されるので必ずthinkingブロックのsignatureに保存する。
async function parseClaudeSSEStream(body, onTextDelta, resetIdle) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let eventName = 'message';
  let dataLines = [];

  const blocks = [];
  let cumulativeText = '';
  let model = null;
  let stopReason = null;
  let usage = {};

  async function applyDelta(index, delta) {
    const block = blocks[index];
    if (!block || !delta) return;
    if (delta.type === 'text_delta') {
      block.text = (block.text ?? '') + delta.text;
      cumulativeText += delta.text;
      if (onTextDelta) await onTextDelta(cumulativeText);
    } else if (delta.type === 'thinking_delta') {
      block.thinking = (block.thinking ?? '') + delta.thinking;
    } else if (delta.type === 'signature_delta') {
      block.signature = (block.signature ?? '') + delta.signature;
    } else if (delta.type === 'input_json_delta') {
      block._partialJson = (block._partialJson ?? '') + (delta.partial_json ?? '');
    }
  }

  async function handleEvent(evt, dataStr) {
    if (evt === 'ping' || !dataStr) return;
    const data = JSON.parse(dataStr);
    if (evt === 'error') {
      // 既存のリトライループ（claudeFetchのattemptループ）に乗せるためthrow
      throw new Error(`Claude SSE error event: ${JSON.stringify(data).slice(0, 300)}`);
    }
    if (evt === 'message_start') {
      model = data.message?.model ?? model;
      usage = { ...usage, ...(data.message?.usage ?? {}) };
    } else if (evt === 'content_block_start') {
      blocks[data.index] = { ...data.content_block };
    } else if (evt === 'content_block_delta') {
      await applyDelta(data.index, data.delta);
    } else if (evt === 'content_block_stop') {
      const block = blocks[data.index];
      if (block && block.type === 'tool_use') {
        const raw = (block._partialJson ?? '').trim();
        block.input = raw ? JSON.parse(raw) : {};
        delete block._partialJson;
      }
    } else if (evt === 'message_delta') {
      if (data.delta?.stop_reason) stopReason = data.delta.stop_reason;
      usage = { ...usage, ...(data.usage ?? {}) };
    }
    // message_stop等は組み立てに不要なので無視
  }

  async function processLine(line) {
    if (line === '') {
      if (dataLines.length) await handleEvent(eventName, dataLines.join('\n'));
      eventName = 'message';
      dataLines = [];
      return;
    }
    if (line.startsWith(':')) return; // SSEコメント行
    const sep = line.indexOf(':');
    const field = sep === -1 ? line : line.slice(0, sep);
    let value = sep === -1 ? '' : line.slice(sep + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value?.length) resetIdle?.();
      // チャンク境界で行が割れるケースに対応するため、行単位でバッファリング
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        let line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        await processLine(line);
      }
    }
    buf += decoder.decode();
    if (buf.endsWith('\r')) buf = buf.slice(0, -1);
    if (buf) await processLine(buf);
    await processLine(''); // 末尾に空行がなかった場合の最終イベントをflush
  } finally {
    try { reader.releaseLock(); } catch { /* noop */ }
  }

  return { model, content: blocks.filter(Boolean), stop_reason: stopReason, usage };
}

async function claudeFetch(body, { onTextDelta } = {}) {
  const token = getClaudeToken();
  if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN is not set');
  const betas = ['oauth-2025-04-20'];
  if (body.model === FABLE5_MODEL) {
    betas.push('server-side-fallback-2026-06-01');
    body = { ...body, fallbacks: [{ model: 'claude-opus-4-8' }] };
  }
  const streaming = typeof onTextDelta === 'function';
  if (streaming) body = { ...body, stream: true };
  const headers = {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
    'anthropic-beta': betas.join(','),
    authorization: `Bearer ${token}`,
  };
  const MAX_RETRIES = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    let res;
    // ストリーミング時は「60秒間データが1バイトも来なければabort」のアイドル
    // タイムアウト（受信のたびにresetIdleでリセット。fetch開始時にも一度
    // セットするのでヘッダー到達待ちも60秒でタイムアウトする）。非ストリー
    // ミング経路は現行どおり全体300s固定のまま変更しない。
    let idleTimer;
    const idleController = streaming ? new AbortController() : null;
    const resetIdle = () => {
      if (!idleController) return;
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idleController.abort(new Error('Claude stream idle timeout (60s)')), 60000);
    };
    try {
      resetIdle();
      res = await fetch(`${ANTHROPIC_BASE}/v1/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        // Fable 5 / Sonnet 5 think on every call (adaptive-by-default when the
        // `thinking` param is omitted, which we always do) and can legitimately
        // take several minutes on demanding tool-loop turns — confirmed via a
        // live 16k-max_tokens request that took ~165s. 120s was killing those
        // requests mid-generation before the fix.
        signal: streaming ? idleController.signal : AbortSignal.timeout(300000),
      });
    } catch (e) {
      clearTimeout(idleTimer);
      lastErr = e;
      if (attempt < MAX_RETRIES) { await sleep(attempt * 3000); continue; }
      throw e;
    }
    if (res.ok) {
      if (!streaming) { clearTimeout(idleTimer); return res.json(); }
      try {
        const result = await parseClaudeSSEStream(res.body, onTextDelta, resetIdle);
        clearTimeout(idleTimer);
        return result;
      } catch (e) {
        clearTimeout(idleTimer);
        lastErr = e;
        if (attempt < MAX_RETRIES) { await sleep(attempt * 3000); continue; }
        throw e;
      }
    }
    clearTimeout(idleTimer);
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

const DEFAULT_CLAUDE_EFFORT = (process.env.CLAUDE_EFFORT || 'max').toLowerCase();

function resolveClaudeEffort(effort, model) {
  if (/haiku/i.test(model)) return null; // Haiku は effort 非対応。送らない
  return (effort || DEFAULT_CLAUDE_EFFORT).toLowerCase();
}

// ── ClaudeAgentSession ─────────────────────────────────────────────────
// Anthropicネイティブのmessages配列を会話状態として所有するセッション。
// - レスポンスのcontentブロック配列は一切加工せずそのまま保存する
//   （thinking / text / tool_use、signature含めて完全保存 → 次リクエストで
//   そのまま返送。Anthropicは同一モデルへのthinkingブロック返送を推奨）
// - ツール結果画像は tool_result.content 内へネイティブ埋め込み
// - プロンプトキャッシュ: persona境界 + messages末尾ブロックに cache_control
const MAX_TOOL_RESULT_IMAGES = 4; // 1ラウンドあたりの上限（現行踏襲）

class ClaudeAgentSession {
  constructor({ model, effort, system, tools, seed }) {
    this.model = model;
    this.effort = effort;
    this.system = system;
    this.tools = tools;
    this.messages = null;
    // seedの変換（画像のbase64化を含む）は非同期なので、開始時に1回だけ
    // 走らせて全公開メソッドで完了を待つ。
    this._ready = toClaudeMessages(seed).then((msgs) => { this.messages = msgs; });
  }

  // 隣接する同role発言は1ターンにまとめる（旧toClaudeMessagesのマージ挙動を維持）
  _push(role, blocks) {
    if (!blocks.length) return;
    const last = this.messages[this.messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else this.messages.push({ role, content: blocks });
  }

  // リクエスト組み立て時のみ、messages末尾のブロックに cache_control を付与。
  // 内部状態は汚さない（シャローコピー）。反復ごとに前反復までのプレフィックス
  // がcache hitする。thinkingブロックにはcache_controlを付けられないので回避。
  _requestMessages() {
    return this.messages.map((m, i) => {
      if (i !== this.messages.length - 1 || !Array.isArray(m.content) || m.content.length === 0) return m;
      const content = m.content.map((b, j) => {
        if (j !== m.content.length - 1) return b;
        if (b.type === 'thinking' || b.type === 'redacted_thinking') return b;
        return { ...b, cache_control: { type: 'ephemeral' } };
      });
      return { ...m, content };
    });
  }

  async step({ noTools = false, onTextDelta } = {}) {
    await this._ready;
    const resolvedEffort = resolveClaudeEffort(this.effort, this.model);
    const data = await claudeFetch({
      model: this.model,
      // Fable 5 / Sonnet 5 spend part of this budget on always-on/adaptive
      // thinking before writing any visible text — 16000 leaves real headroom.
      max_tokens: 16000,
      // system: identity → persona（キャッシュ境界）→ 時刻（可変部は境界の後ろ）
      system: [
        { type: 'text', text: CLAUDE_CODE_IDENTITY },
        { type: 'text', text: this.system.persona, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: this.system.time },
      ],
      ...(noTools ? {} : { tools: toClaudeTools(this.tools) }),
      messages: this._requestMessages(),
      ...(resolvedEffort ? { output_config: { effort: resolvedEffort } } : {}),
    }, { onTextDelta });
    const blocks = data.content ?? [];
    // レスポンスブロックを無加工でassistantターンとして保存
    if (blocks.length) this.messages.push({ role: 'assistant', content: blocks });
    const u = data.usage ?? {};
    console.log(`[usage] model=${data.model ?? this.model} in=${u.input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} cache_write=${u.cache_creation_input_tokens ?? 0} out=${u.output_tokens ?? 0}`);
    const toolUse = blocks.filter((b) => b.type === 'tool_use');
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('');
    if (toolUse.length === 0 && (!text || !text.trim())) {
      console.warn(`[provider] Claude step returned empty (model=${this.model}, stop=${data.stop_reason})`);
    }
    return {
      text,
      toolCalls: toolUse.length > 0
        ? toolUse.map((b) => ({ id: b.id, name: b.name, arguments: b.input ?? {} }))
        : null,
    };
  }

  // ツール結果は1つのuserターンにまとめ、各tool_resultのcontent配列に
  // textブロック + 画像のimageブロックをネイティブ埋め込みする。
  async addToolResults(results) {
    await this._ready;
    let imageBudget = MAX_TOOL_RESULT_IMAGES;
    const blocks = [];
    for (const r of results) {
      const content = [{ type: 'text', text: (r.text ?? '').toString() || '(empty)' }];
      const urls = (r.images ?? []).slice(0, Math.max(0, imageBudget));
      imageBudget -= urls.length;
      if (urls.length) {
        const fetched = await Promise.all(urls.map(fetchImageAsBase64));
        for (const img of fetched) {
          if (img) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
        }
      }
      blocks.push({ type: 'tool_result', tool_use_id: r.id, content });
    }
    this._push('user', blocks);
  }

  async addUserText(text) {
    await this._ready;
    this._push('user', [{ type: 'text', text }]);
  }
}

// ── GeminiAgentSession ─────────────────────────────────────────────────
// Geminiネイティブのcontents配列を所有。functionCallパーツ
// （thoughtSignature含む）はネイティブのまま追記する。画像は無視（現状踏襲）。
class GeminiAgentSession {
  constructor({ model, system, tools, seed }) {
    this.model = model;
    this.systemInstruction = `${system.persona}\n\n${system.time}`;
    this.tools = tools;
    this._toolNamesById = new Map();
    this.contents = seed
      .filter((msg) => msg.role === 'user' || msg.role === 'assistant')
      .map((msg) => ({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: (msg.content ?? '').toString() }],
      }));
  }

  // onTextDeltaはClaude系ストリーミング専用。Geminiは非対応なのでシグネチャ
  // 上だけ受け取って捨てる（呼び出し元のrunAgentは全プロバイダーに一律で渡す）。
  async step({ noTools = false, onTextDelta } = {}) {
    const MAX_GEMINI_RETRIES = 3;
    let lastErr;
    let response;
    for (let attempt = 1; attempt <= MAX_GEMINI_RETRIES; attempt++) {
      try {
        response = await getGemini().models.generateContent({
          model: this.model,
          contents: this.contents,
          config: noTools
            ? { systemInstruction: this.systemInstruction, maxOutputTokens: 16000 }
            : {
                systemInstruction: this.systemInstruction,
                tools: toGeminiTools(this.tools),
                maxOutputTokens: 4096,
                thinkingConfig: { thinkingBudget: 0 },
              },
        });
        break;
      } catch (e) {
        if (isGeminiRetryable(e) && attempt < MAX_GEMINI_RETRIES) {
          console.warn(`[provider] Gemini 503/429 attempt ${attempt}, retrying in ${attempt * 5}s...`);
          await sleep(attempt * 5000);
          lastErr = e;
          continue;
        }
        throw e;
      }
    }
    if (!response) throw lastErr;

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const fnParts = parts.filter((pt) => pt.functionCall);
    if (fnParts.length > 0) {
      this.contents.push({ role: 'model', parts }); // ネイティブのまま保存
      const toolCalls = fnParts.map((pt) => {
        const id = makeCallId();
        this._toolNamesById.set(id, pt.functionCall.name);
        return { id, name: pt.functionCall.name, arguments: pt.functionCall.args ?? {} };
      });
      return { text: '', toolCalls };
    }
    const text = response.text ?? '';
    if (parts.length > 0) this.contents.push({ role: 'model', parts });
    return { text, toolCalls: null };
  }

  addToolResults(results) {
    const parts = results.map((r) => ({
      functionResponse: {
        name: this._toolNamesById.get(r.id) ?? 'unknown',
        response: { output: String(r.text ?? '') },
      },
    }));
    for (const r of results) this._toolNamesById.delete(r.id);
    this.contents.push({ role: 'user', parts });
  }

  addUserText(text) {
    this.contents.push({ role: 'user', parts: [{ text }] });
  }
}

// ── OpenAICompatSession（openai / deepseek 共用） ──────────────────────
// OpenAI形式messagesを所有。imagesフィールドは送信時に除去（現状踏襲）。
class OpenAICompatSession {
  constructor({ provider, model, system, tools, seed }) {
    this.provider = provider;
    this.model = model;
    this.tools = tools;
    this.messages = [
      { role: 'system', content: `${system.persona}\n\n${system.time}` },
      ...seed.map((m) => ({ ...m })),
    ];
  }

  // onTextDeltaはClaude系ストリーミング専用。OpenAI互換は非対応なのでシグネ
  // チャ上だけ受け取って捨てる（呼び出し元のrunAgentは全プロバイダーに一律で渡す）。
  async step({ noTools = false, onTextDelta } = {}) {
    const MAX_RETRIES = 3;
    let lastError;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      let completion;
      try {
        const maxTokens = noTools ? 16000 : 4096;
        const tokenParam = this.provider === 'openai'
          ? { max_completion_tokens: maxTokens }
          : { max_tokens: maxTokens };
        completion = await getOpenAIClient(this.provider).chat.completions.create({
          model: this.model,
          messages: this.messages.map(({ images, ...rest }) => rest),
          ...(noTools ? {} : { tools: this.tools }),
          ...tokenParam,
        });
      } catch (e) {
        if (e.status === 503 && attempt < MAX_RETRIES) {
          console.warn(`[provider] ${this.provider} 503 attempt ${attempt}, retrying in ${attempt * 5}s...`);
          await sleep(attempt * 5000);
          lastError = e;
          continue;
        }
        throw e;
      }

      const choice = completion.choices[0];
      if (choice.message.tool_calls?.length) {
        this.messages.push(choice.message);
        return {
          text: choice.message.content ?? '',
          toolCalls: choice.message.tool_calls.map((tc) => ({
            id: tc.id,
            name: tc.function.name,
            arguments: JSON.parse(tc.function.arguments),
          })),
        };
      }
      const text = choice.message.content ?? '';
      if (!text.trim()) {
        console.warn(`[provider] ${this.provider} step returned empty (model=${this.model}, finish=${choice.finish_reason})`);
      }
      this.messages.push({ role: 'assistant', content: text });
      return { text, toolCalls: null };
    }
    throw lastError ?? new Error('step failed after retries');
  }

  addToolResults(results) {
    for (const r of results) {
      this.messages.push({ role: 'tool', tool_call_id: r.id, content: (r.text ?? '').toString() || '(empty)' });
    }
  }

  addUserText(text) {
    this.messages.push({ role: 'user', content: text });
  }
}

// ── createAgentSession ─────────────────────────────────────────────────
// プロバイダー別の会話状態を所有するセッションを作る。
//   system = { persona, time }（prompt.jsのbuildSystemPrompt出力）
//   tools  = OpenAI形式のツール定義配列（tools.jsのTOOLS）
//   seed   = [{ role:'user'|'assistant', content: string, images?: string[] }]
// session.step({ noTools }) → { text, toolCalls: [{id, name, arguments}]|null }
// session.addToolResults([{ id, text, images }]) / session.addUserText(text)
export function createAgentSession({ provider, model, effort, system, tools, seed = [] } = {}) {
  const { p, m } = resolveProviderModel(provider, model);
  if (p === 'claude') return new ClaudeAgentSession({ model: m, effort, system, tools, seed });
  if (p === 'gemini') return new GeminiAgentSession({ model: m, system, tools, seed });
  return new OpenAICompatSession({ provider: p, model: m, system, tools, seed });
}
