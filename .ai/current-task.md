# タスク: umineko v2 — 単一ループエージェント化（Phase 1本丸）

## 目的
Router → Planner → Tool Loop → Finalizer の多段パイプラインを廃止し、「1つのsystemプロンプト + 1本のエージェントループ」に置き換える。モデル自身がツール使用・調査計画・品質を判断する。同時に、Claude経路のthinkingブロック保存・プロンプトキャッシュ・履歴の発言者付与を実装する。

## 背景（なぜやるか）
- Router(Gemini)は503障害の単一障害点で、出力はほぼ常に"complex"
- PlannerはFable5/Sonnet5でthinkingがmaxTokens:300を食い尽くし毎回no-op
- Finalizerはインフラ障害を品質問題と誤診して高価な全ループ再実行を起こした実績あり
- 現在の内部形式(OpenAI互換)への毎反復変換で、Claudeのthinkingブロックが毎回捨てられている（Anthropicは同一モデルでのthinkingブロック返送を推奨）
- プロンプトキャッシュ未使用＋systemプロンプト先頭に毎分変わる時刻（キャッシュバスター）

## 最終的なファイル構成

```
src/
  index.js            … 書き換え（ハンドラー簡素化・/ai router系削除・/research新実装）
  services/
    agent.js          … 【新規】ループ駆動
    prompt.js         … 【新規】systemプロンプト組み立て
    provider.js       … 【大改修】createAgentSession（プロバイダー別セッション）
    tools.js          … 【新規】llm.jsからツール定義・executeTool・toolLabel・ADMIN_TOOLSを移設
    historyBuilder.js … 【小改修】発言者名付与
    attachments.js    … 変更なし
    settings.js       … router系削除
    constants.js      … ROUTER_MODEL_DEFAULTS削除
  ※削除: router.js / planner.js / finalizer.js / research.js / llm.js
  ※削除（死骸）: deepseek.js / contextBuilder.js / channelSelector.js
.gitignore            … settings.json を追加
```

## 詳細設計

### 1. `src/services/prompt.js`（新規）

```js
export function buildSystemPrompt(guild, aiChannelIds, { mode } = {}) {
  // 戻り値: { persona: string, time: string }
}
```

- `persona`（安定部・キャッシュ対象）:
  - アイデンティティ: 「あなたは「umineko」— このDiscordサーバーに常駐するAIエージェント。サーバーのチャンネル群があなたの記憶でありデータベースです。」
  - サーバーの地図: サーバー名 + テキストチャンネル一覧（`#name [ID:xxx] (topic)`形式、ai-チャンネル=aiChannelIds は除外）
  - 行動原則:
    - サーバー固有の話題（人物・プロジェクト・過去の経緯・タスク）は推測せず、まず関連チャンネルを read_channel で読む。複数チャンネルは並列で読んでよい
    - 一般知識・雑談はツールなしで直接答える。最新情報が答えを変える話題は search_web を使う
    - 変更系ツール（送信・作成・編集・削除）はユーザーが明示的に依頼したときだけ使う。質問や相談には調査と提案で応じ、勝手に実行しない
    - AI会話チャンネルの新設は名前を "ai-" で始める（自動的にAIチャンネルとして認識される）
  - Discord形式規則（現行buildSystemWithToolsから移植）: メンション `<@数字ID>`・チャンネルリンク `<#ID>`・メッセージリンク形式・IDはツール結果か地図から取得し捏造禁止
  - 出力規則: ユーザーと同じ言語 / 結論から / ツール実行中の途中経過ナレーション不要 / 内部処理(ツール・リトライ)に言及しない / 履歴の「名前:」プレフィックスは表示上の属性なので自分の発言には付けない
- `mode: 'research'` のとき persona に追記: 「深掘りリサーチモード: search_web と fetch_url を徹底的に使い、複数の情報源を読み比べ、必ず引用元URLを付した包括的レポートを書く。Discordチャンネルの情報も必要なら読む。」
- `time`（可変部・キャッシュ境界の後）: `現在時刻: {ja-JP, Asia/Tokyo, 分解像度} (JST)`

### 2. `src/services/provider.js`（大改修）

**既存の`callText`/`callWithTools`エクスポートは削除**し、以下に置き換える:

```js
export function createAgentSession({ provider, model, effort, system, tools, seed })
// system = { persona, time }
// tools = OpenAI形式のツール定義配列（tools.jsのTOOLS）
// seed  = [{ role:'user'|'assistant', content: string, images?: string[] }]
// 戻り値: session

session.step({ noTools = false } = {})
// → Promise<{ text: string, toolCalls: [{id, name, arguments}]|null }>
// noTools: 最終回答強制時にツールを渡さない

session.addToolResults([{ id, text, images }])
session.addUserText(text)  // nudge・最終回答要求用
```

プロバイダー解決は既存の`resolveProviderModel`を流用（provider未指定時はenvフォールバック）。

**ClaudeAgentSession**（本命）:
- 内部状態: Anthropicネイティブのmessages配列。seedは既存の`toClaudeMessages`ロジック（画像のbase64化含む）で**開始時に1回だけ**変換
- `step()`: 既存`claudeFetch`（リトライ・Fable5フォールバック・300秒タイムアウト・effort/Haikuガードすべて現状維持）を呼ぶ。**レスポンスの`content`ブロック配列を一切加工せずそのまま**assistant turnとして内部配列にpush（thinking/text/tool_useブロック、signature含めて完全保存）。tool_useブロックがあれば`toolCalls`として返す
- `addToolResults()`: 1つのuser turnにまとめ、各`{type:'tool_result', tool_use_id, content: [...]}` の content 配列に text ブロック + 画像があれば**imageブロックをネイティブ埋め込み**（画像は既存fetchImageAsBase64でbase64化）。現行の「合成userメッセージ」ハックは廃止
- **プロンプトキャッシュ**: リクエストボディ組み立て時に（内部状態は汚さずシャローコピーで）
  - system: `[identityブロック, personaブロック(cache_control: {type:'ephemeral'}), timeブロック]` の順。時刻はキャッシュ境界の後ろ
  - messages末尾のブロックにも `cache_control: {type:'ephemeral'}` を付与（反復ごとに前反復までのプレフィックスがcache hitする）
- **usageログ**: 毎step後に `console.log('[usage] model=... in=... cache_read=... cache_write=... out=...')`
- 会話終端ガード（assistant終わり→`続けてください。`user挿入）は現行維持
- prefill禁止対応・空応答warnログも現行維持

**GeminiAgentSession**:
- 内部状態: Geminiネイティブの`contents`配列。seedを既存`toGeminiContents`相当で1回変換、以降は`functionCall`パーツ（thoughtSignature含む）を**ネイティブのまま**追記
- systemInstruction = persona + time 結合
- 画像は無視（現状踏襲）。503/429リトライは現行維持

**OpenAICompatSession**（openai / deepseek 共用）:
- 内部状態: OpenAI形式messages（現行と同じ）。imagesフィールドは除去して送信（現状踏襲）
- 503リトライ・max_completion_tokens/max_tokensの分岐は現行維持

### 3. `src/services/tools.js`（新規 = llm.jsから移設）
- `TOOLS`（DISCORD_TOOLS + WEB_TOOLS_DEFS、WEB_SEARCH_ENABLED分岐含む）
- `executeTool(name, args, guild, aiChannelIds, member)`（ADMIN_TOOLSゲート含む・現行そのまま）
- `executeToolInner`（全ケース現行そのまま。read_channel/fetch_messageの`{text, images}`戻り値も維持）
- `toolLabel`
- エクスポート: `TOOLS`, `executeTool`, `toolLabel`

### 4. `src/services/agent.js`（新規）

```js
import { TOOLS, executeTool, toolLabel } from './tools.js';
import { createAgentSession } from './provider.js';
import { buildSystemPrompt } from './prompt.js';

const MAX_ITERATIONS = 15;

export async function runAgent({ settings, guild, member, aiChannelIds, seed, onToolCall, mode, maxIterations = MAX_ITERATIONS }) {
  const system = buildSystemPrompt(guild, aiChannelIds, { mode });
  const session = createAgentSession({
    provider: settings.provider, model: settings.model, effort: settings.effort,
    system, tools: TOOLS, seed,
  });
  for (let i = 0; i < maxIterations; i++) {
    const { text, toolCalls } = await session.step();
    if (!toolCalls?.length) {
      if (text && text.trim()) return text;
      // 空応答: 1回だけnudge
      session.addUserText('ツールの実行結果を踏まえて、ユーザーへの回答を生成してください。');
      const retry = await session.step({ noTools: true });
      return retry.text || '';
    }
    const results = await Promise.all(
      toolCalls.map((tc) => executeTool(tc.name, tc.arguments, guild, aiChannelIds, member))
    );
    results.forEach((r, j) => onToolCall?.(toolLabel(toolCalls[j].name, toolCalls[j].arguments, r.text)).catch?.(() => {}));
    session.addToolResults(toolCalls.map((tc, j) => ({ id: tc.id, text: results[j].text, images: results[j].images })));
  }
  session.addUserText('収集した情報をもとに、最初の質問に最終回答してください。');
  const final = await session.step({ noTools: true });
  return final.text || '';
}
```
（onToolCallがasyncな点の扱いは現行llm.jsの`await onToolCall(...).catch(()=>{})`パターンに合わせて良い）

### 5. `src/services/historyBuilder.js`（小改修）
- user発言（bot以外）の`content`を `${m.member?.displayName ?? m.author.username}: ${m.content}` に変更
- bot自身（assistant）は現行どおり素のcontent
- 画像・"> "フィルタ・50件は現行維持

### 6. `src/index.js`（書き換え）

**メッセージハンドラー**（MessageCreate）:
```
userImages = extractImageUrls(message)
statusMsg = message.reply('> ⏳ 考え中...')
history = buildConversationHistory(channel, message.id, client.user.id)
authorName = message.member?.displayName ?? message.author.username
seed = [...history, { role:'user', content: `${authorName}: ${message.content}`, ...(userImages.length ? {images:userImages} : {}) }]
statusLines = []
answer = await runAgent({ settings, guild: message.guild, member: message.member, aiChannelIds, seed,
  onToolCall: async (label) => { statusLines.push(`> 🔧 ${label}`); await statusMsg.edit(...); } })
statusMsg最終編集: statusLinesがあれば維持+`> ✅ 完了 (provider/model)`、なければ`> ✅ (provider/model)`
answerを2000字以内チャンクで送信。チャンク分割は段落境界(\n\n)優先で自然に切る（新ヘルパーchunkMessage(text)をindex.js内に実装。段落単体が2000超の場合は行、それも超えるなら文字で切る）
```
- Router/History/Plan/Finalizeのステータス行と分岐はすべて削除
- timeContextの組み立てはprompt.jsに移ったのでハンドラーから削除
- try/catchでの`❌ [Error]`表示は現行維持

**/research ハンドラー**（置き換え）:
```
deferReply → history取得 → seed = [...history, {role:'user', content:`${authorName}: [リサーチ依頼] ${query}`}]
runAgent({ ..., mode:'research', maxIterations: 25, onToolCall: editReplyでステータス行追加 })
結果をchunkMessageで分割し、最初のchunkをfollowUp、残りをchannel.send（現行踏襲）
```
- 全チャンネルユーザー発言スキャン（Step2）・プロフィール抽出（Step3）・planResearch（Step4）は**廃止**（ユーザー確認済み）

**/ai コマンド**:
- `router` / `router-model` サブコマンド定義とハンドラーを削除
- `status`: ルーター行を削除（メインAI・Effortのみ）
- `reset`: ルーター行を削除
- それ以外（model / effort / reset本体）は現状維持

**import整理**: classify / planSearch / finalizeResponse / runResearch / planResearch / extractUserContext / chatSimple / chatWithTools / SYSTEM_SIMPLE / buildSystemWithTools / resolveRouterModel / ROUTER_MODEL_DEFAULTS を削除し、runAgent / buildConversationHistory / extractImageUrls / settings系のみに

### 7. `src/services/settings.js` / `constants.js`
- settings: ENV_DEFAULTSから`routerProvider`/`routerModel`削除、`resolveRouterModel`削除、re-exportからROUTER_MODEL_DEFAULTS削除
- constants: `ROUTER_MODEL_DEFAULTS`削除（MODEL_DEFAULTS・PROVIDERS・EFFORT_LEVELSは維持）
- settings.jsonに残る旧キー（routerProvider等）は無視されるだけなので移行処理不要

### 8. 削除
`git rm`: `src/services/router.js`, `planner.js`, `finalizer.js`, `research.js`, `llm.js`, `deepseek.js`, `contextBuilder.js`, `channelSelector.js`
`.gitignore`に`settings.json`を追加

## 変更してよい範囲
上記に列挙したファイルのみ。`windows-search-api/`・`.env`・`Dockerfile`・`scripts/deploy.sh`は触らない。

## 禁止事項
- 既存の`claudeFetch`の挙動（OAuth認証ヘッダー・リトライ・Fable5フォールバック・タイムアウト300s・effort/Haikuガード・max_tokens 16000）を変えない
- 画像のbase64方式（URL直接方式はこのOAuth経路で400になる。.ai/lessons.md参照）を変えない
- デプロイしない（親エージェントが行う）。コミットもしない
- reasonix-do / DeepSeek系外部LLMへの新規連携追加禁止

## 実装のヒント
- `.env`に実トークンあり。統合テストは実APIで行う（モック禁止）。一時スクリプトはプロジェクト直下に置き、終了後削除
- リクエストボディの検証は `globalThis.fetch` をラップして捕捉するパターンが使える（過去の検証で実績あり）
- 着手前に `.ai/lessons.md` を必ず読むこと

## 失敗時
`.ai/failure-log.md`に1行追記。
