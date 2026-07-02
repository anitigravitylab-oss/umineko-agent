# 独立検証レポート — umineko v2 単一ループ化

検証方法: `.ai/rubric.md` の各項目を、実際のコード（現状ワークツリー、`main`からの未コミット差分）とフェイクguild/実LLM APIによる実機テストで照合。実装の経緯・コミットメッセージ・current-task.md/failure-log.md/lessons.mdは未参照。一時テストスクリプト（`_verify_fakes.mjs`, `_verify_section3〜6.mjs`）はプロジェクト直下に作成し、実行後すべて削除済み（`git status --short`で残存なし確認済み）。

## 総合判定: **合格（全項目）**

OpenAI項目のみ、`OPENAI_API_KEY`未設定のためrubric許容のスキップ扱い。それ以外は全項目、実機根拠つきで合格。

---

## 1. 構成 — 合格

- `src/services/agent.js`（`export async function runAgent`）, `src/services/prompt.js`（`export function buildSystemPrompt`）, `src/services/tools.js`（`export const TOOLS` / `export async function executeTool` / `export function toolLabel`）すべて存在・export確認。
- `router.js` `planner.js` `finalizer.js` `research.js` `llm.js` `deepseek.js` `contextBuilder.js` `channelSelector.js` はいずれも `src/services/` に存在しない。
- `grep -rn "router\.js\|planner\.js\|finalizer\.js\|research\.js\|llm\.js" src/` → マッチなし。
- `provider.js` の `^export` は `export function createAgentSession` の1つのみ。`callText`/`callWithTools`はsrc全体でもマッチなし。
- `.gitignore` に `settings.json` の行あり（`git ls-files`でも未追跡確認）。
- `find src -name "*.js" | xargs node --check` → 9ファイル全てOK（index.js含む）。

## 2. 起動と基本動作 — 合格

- `timeout 17 node src/index.js` を実行し、`Ready! Logged in as umineko-agent#3789` が出力、以降複数ギルドのAI channel登録・コマンド登録ログが続き、起動エラーなし（`punycode`非推奨警告はNode標準の無関係な警告で起動エラーではない）。
- `src/index.js` の `AI_COMMAND.options` は `status` / `model` / `effort` / `reset` の4サブコマンドのみ。`router` / `router-model` は存在しない。

## 3. コア動作（実API・フェイクguild、claude-haiku-4-5-20251001使用） — 合格

- **雑談**: seed `[{role:'user', content:'テストユーザー: こんにちは'}]` → `toolCallCount: 0`、応答文字列あり（「こんにちは！👋…」）。
- **調査**: フェイクguildの`#general`に「ビーチバレー大会」「7/15」「雨天時の代替案」を仕込み「#generalの話題を教えて」→ `read_channel("general")` が呼ばれ、応答に「ビーチバレー」「7/15」等の内容が反映。
- **管理者ゲート**:
  - 直接 `executeTool('create_channel', ..., nonAdminMember)` → `{ text: '権限エラー: \`create_channel\` は管理者のみ実行できます。', images: [] }` を確認（tool層のゲート）。
  - フル`runAgent`ループでも同条件で実行 → ツール結果を踏まえ最終応答「申し訳ありません。チャンネル作成には管理者権限が必要ですが…」を確認（ツール結果が応答に反映）。
- **ループ上限**: `maxIterations: 2` + 「channel-a, channel-b, channel-cを順番に読んで」で誘導 → 2回ツール呼び出し(`read_channel` a, b)を消費後、例外なく文字列応答「channel-b を読み終わりました。次に channel-c を読みます。」を返して終了（無限ループなし、`ループ上限到達`フォールバックのnoTools最終ステップが実行されたことをusageログでも確認: 3回目のリクエストで`tools`未送信）。

## 4. Claude品質修復の実証（fetchフックで生リクエストボディを捕捉、claude-fable-5使用） — 合格

`globalThis.fetch`をラップし`/v1/messages`宛の生リクエストボディ・レスポンスJSONを捕捉。シナリオ: フェイク`#general`に山派/海派の対立意見＋画像添付（Wikipedia実画像 `Cat03.jpg`, 279KB, image/jpeg）を仕込み、「対立点を整理して、あと画像に何が写ってるか教えて」で2回のAnthropic APIリクエストが発生。

- **thinkingブロック保存**:
  - 1回目レスポンス（`stop_reason: tool_use`）の`content`ブロック型: `['thinking', 'tool_use']` → 前提条件（1回目に thinking が存在）を満たす。
  - 2回目リクエストの`messages`配列に、直前のassistantターンとして `blockTypes: ["thinking","tool_use"]` がそのまま含まれることを確認（無加工で再送されている）。→ **v1で毎回消失していた問題が解消**していることを直接確認。
  - 実際に応答したモデルは`data.model`ログで`claude-fable-5`と確認（server-side-fallbackでopusに切り替わっていない）。
- **プロンプトキャッシュ**: 2回目レスポンスの`usage.cache_read_input_tokens = 2896`（>0）。`[usage] model=claude-fable-5 in=2 cache_read=2896 cache_write=3702 out=798` ログも出力確認。
- **時刻の位置**: 両リクエストとも`system`配列は `[identity(cache_controlなし), persona(cache_control:{type:'ephemeral'}), time(cache_controlなし)]` の順。`time`ブロックのindexが`persona`ブロックのindexより後（2 > 1）であることを2リクエストとも確認。
- **画像のネイティブ埋め込み**: 2回目リクエストの`messages`中、`tool_result`ブロックの`content`配列に `{type:'image', source:{type:'base64', media_type:'image/jpeg', ...}}` を確認（1ブロック、実バイト列を`fetch`して base64化したもの。合成userメッセージ方式ではない）。
  - **実画像内容との照合**: 実際にWikipedia画像をダウンロードして目視確認したところ「茶トラ猫、琥珀色の目でカメラ目線、胸元は白い毛、背景はぼけたコンクリートに赤いホース状の物が横切る」構図。最終応答は「bob さんが貼った写真に写っているのは**茶トラの猫**です…黄色っぽい琥珀色の目でカメラをまっすぐ見つめている／胸元は白めの毛色／背景はぼけたコンクリートの地面で、赤いホースかコードのようなものが横切っている」と、細部まで正確に一致。ハルシネーションでなく実際の画像を見て応答していることを確認。
- **prefillガード**: seed `[{role:'user',...}, {role:'assistant',...}]`（末尾assistant）で`runAgent`（claude-haiku-4-5-20251001）を実行 → 例外なし、非空文字列応答を確認。

## 5. 無退行（他プロバイダー） — 合格（OpenAIはrubric許容のスキップ）

- **Gemini** (`gemini-2.5-flash`): フェイクguild `read_channel` ツールループが1周（`read_channel("general")`呼び出し確認）、正常応答。
- **DeepSeek** (`deepseek-chat`): 残高あり、正常応答「こんにちは！おかげさまで絶好調です…」（エラーなし）。
- **OpenAI**: `.env`に`OPENAI_API_KEY`未設定を確認 → rubric許容によりスキップ。
- **4 Claudeモデル一発応答**: `claude-fable-5` / `claude-opus-4-8` / `claude-sonnet-5` / `claude-haiku-4-5-20251001` いずれも「1+1は？」に正常応答（各々「2です。」「2です。」「2」「2です。」）。haikuモデルはeffortフィールド未送信（`resolveClaudeEffort`が`/haiku/i`にマッチしてnullを返す仕様どおり）でもエラーにならないことを確認。

## 6. 周辺 — 合格

- **履歴の発言者付与**: フェイクmessage群（alice/umineko-agent(bot)/bob）から`buildConversationHistory`を実行 → user turn contentは`アリス: こんにちは`／`ボブ: 天気を教えて`のように`表示名: 内容`形式、bot turnは`こんにちは、何かお手伝いできますか？`と素のまま。
- **チャンク分割**: `src/index.js`の`chunkMessage`をimportしユニットテスト（Discordログイン等の副作用が走る前、`ClientReady`発火前に同期的にexportを取得し即`process.exit(0)`して実運用への影響を最小化）。
  - 2926字（4段落、`\n\n`区切り、各段落500〜900字）→ 2チャンク（1712字, 1212字）、いずれも2000字以内、かつ各段落が分断されずどちらかのチャンクに丸ごと収まることを確認（段落境界優先）。
  - 区切りなし4500字（フォールバック経路）→ `[2000, 2000, 500]`で文字単位分割、結合すると元テキストと一致。
- **/research**: `src/index.js`内`/research`ハンドラーは`runAgent`を`mode: 'research'`付きで呼び出す実装（410行規模のindex.js、該当箇所1行）。`grep -rn "プロフィール\|全チャンネル\|scanAllChannels\|extractProfile\|channelSelector\|selectChannels" src/`はマッチなし＝旧research.js時代の全チャンネルスキャン・プロフィール抽出コードは残っていない。
- **systemプロンプト内容**: `prompt.js`の`buildSystemPrompt`出力に (a) `## サーバーの地図`（チャンネル一覧の動的挿入） (b) 「変更系ツール（送信・作成・編集・削除）はユーザーが明示的に依頼したときだけ使う」の行動境界文言 (c) `## Discordのフォーマットルール`（メンション/チャンネルリンク等） (d) 「チャンネル名を必ず"ai-"で始める」のai-プレフィックス規則、すべて含まれることをソース確認。

## 7. 総合判定

全チェック項目 合格。OpenAI項目のみ環境変数未設定によりrubricの許容規定に基づきスキップ。不合格項目・要修正事項なし。

### 検証時の一時ファイル
`_verify_fakes.mjs`, `_verify_section3.mjs`, `_verify_section4.mjs`, `_verify_section5.mjs`, `_verify_section6.mjs` をプロジェクト直下に作成し実機テストに使用。検証完了後すべて削除済み（`git status --short`で残存なきことを確認）。
