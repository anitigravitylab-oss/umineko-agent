# 合格基準（rubric）— umineko v2 単一ループ化

実装の経緯は見ずに、現在のコードと実際の動作だけで以下を機械的に照合すること。曖昧な場合は不合格側に倒す。`.env`の実トークンを使い、一時スクリプトはプロジェクト直下に作成し実行後削除すること（モック禁止。ただしDiscordのguild/channel/memberはフェイクオブジェクトでよい）。

## 1. 構成
- [ ] 新規: `src/services/agent.js`（`runAgent`をexport）, `src/services/prompt.js`（`buildSystemPrompt`をexport）, `src/services/tools.js`（`TOOLS`/`executeTool`/`toolLabel`をexport）が存在
- [ ] 削除済み: `src/services/router.js`, `planner.js`, `finalizer.js`, `research.js`, `llm.js`, `deepseek.js`, `contextBuilder.js`, `channelSelector.js` が存在しない
- [ ] `grep -rn "router\.js\|planner\.js\|finalizer\.js\|research\.js\|llm\.js" src/` でimportが残っていない
- [ ] `provider.js` が `callText`/`callWithTools` をexportしていない（`createAgentSession`のみ）
- [ ] `.gitignore` に `settings.json` がある
- [ ] 全srcファイルが `node --check` を通る

## 2. 起動と基本動作
- [ ] `node src/index.js` を15秒起動し `Ready! Logged in as umineko-agent#3789` が出て、起動エラーがない
- [ ] `/ai` コマンド定義に `router` / `router-model` サブコマンドが存在しない（index.jsのAI_COMMAND定義を確認）

## 3. コア動作（実API・フェイクguild）
- [ ] **雑談（ツール不使用）**: `runAgent` に「こんにちは」相当のseedを渡し、ツール呼び出しゼロで応答が返る（claude-haiku で可）
- [ ] **調査（ツール使用）**: フェイクguildの`read_channel`に既知の内容を仕込み、「#generalの話題を教えて」で read_channel が呼ばれ、内容を踏まえた応答が返る
- [ ] **管理者ゲート**: 非管理者member（`permissions.has: ()=>false`）で create_channel を依頼→権限エラーがツール結果として返り、応答にその旨が反映される
- [ ] **ループ上限**: maxIterations を 2 に絞り、ツールを呼び続けるよう誘導した場合でも最終回答が文字列で返る（無限ループしない）

## 4. Claude品質修復の実証（fetchフックでリクエストボディを捕捉）
- [ ] **thinkingブロック保存**: `claude-fable-5` で2反復以上のツールループを実行し、**2回目のAPIリクエストのmessages内にtype:"thinking"ブロックが含まれる**ことを確認（現行v1では毎回消失していた。これがこのリファクタの核心）。注意: Fable 5は自明すぎるツール呼び出しではthinkingブロックを出さないことがあるため、分析を要するタスク（例:「#generalを読んで議論の対立点を整理して」）で誘発すること。まず**1回目のレスポンスにthinkingブロックが存在すること**を前提確認し、存在するのに2回目のリクエストに含まれていない場合のみ不合格とする
- [ ] **プロンプトキャッシュ**: 同ループで2回目以降のレスポンスの `usage.cache_read_input_tokens > 0` を確認。また[usage]ログが出力される
- [ ] **時刻の位置**: リクエストのsystem配列で、cache_controlが付くpersonaブロックより**後**に時刻ブロックがある（時刻がキャッシュを壊さない配置）
- [ ] **画像のネイティブ埋め込み**: フェイクguildのread_channelで画像添付メッセージを返し、次のリクエストの `tool_result.content` 内に `type:"image"` ブロックが含まれる（旧・合成userメッセージ方式が廃止されている）。かつ実画像（猫URL可）で応答が画像内容に言及する
- [ ] **prefillガード**: seed末尾がassistantになるケース（`[user, assistant]`）でエラーにならない

## 5. 無退行（他プロバイダー）
- [ ] **Gemini**: `gemini-2.5-flash` でツールループ（フェイクguild read_channel）が1周し正常応答
- [ ] **DeepSeek**: `deepseek-chat` で雑談が正常応答（残高不足エラーの場合はその旨明記でスキップ可）
- [ ] **OpenAI**: OPENAI_API_KEY未設定ならスキップ可（明記）
- [ ] **4 Claudeモデル**: fable-5 / opus-4-8 / sonnet-5 / haiku-4-5 の一発応答（haikuはeffortが送られない=エラーにならないことも兼ねる）

## 6. 周辺
- [ ] **履歴の発言者付与**: フェイクmessage群からbuildConversationHistoryを呼び、user turnのcontentが `表示名: 内容` 形式、bot turnは素のまま
- [ ] **チャンク分割**: 2000字超のテキストがchunkMessage相当で全チャンク2000字以内かつ段落境界優先で分割される（ユニット確認）
- [ ] **/research**: index.jsの/researchハンドラーが `mode:'research'` で runAgent を呼ぶ実装になっている（コードレビューで確認。全チャンネルスキャン・プロフィール抽出コードが残っていない）
- [ ] **systemプロンプト内容**: buildSystemPromptの出力に (a)チャンネル地図 (b)「変更系ツールは明示依頼時のみ」の行動境界 (c)Discord形式規則 (d)ai-プレフィックス規則 が含まれる

## 7. 総合判定
全項目合格なら `.ai/verifier-report.md` に合格と各項目の根拠を記録。不合格項目は具体的な失敗内容を明記。
