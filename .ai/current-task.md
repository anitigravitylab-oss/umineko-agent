# Phase 2: ストリーミング + #ai-memory（自主参照方式）

前提: v2単一ループアーキテクチャ（runAgent / createAgentSession / buildSystemPrompt / tools.js）はmainにマージ・本番稼働済み。このタスクはその上に2機能を足す。作業ブランチ: `feat/streaming-ai-memory`（main から分岐済み。コミットは親が行うので不要）。

## 機能A: Claude系ストリーミング

### A-1. ClaudeAgentSession.step() のSSE対応（src/services/provider.js）
- `step({ noTools, onTextDelta } = {})` に拡張。`onTextDelta` が渡されたときだけ `stream: true` でリクエストする（渡されなければ現行の非ストリーミングのまま）。
- SSEパース: fetchのbody ReadableStreamをTextDecoderで行単位バッファリング（チャンク境界で行が割れるケースを必ず処理）。`event:` / `data:` 行を解釈。`ping`イベントは無視。`error`イベントは例外をthrow（既存のリトライループに乗せる）。
- コンテンツブロック再組み立て: `content_block_start`/`content_block_delta`/`content_block_stop` から、非ストリーミング時と等価なblocks配列を復元する。
  - `text_delta` → textブロックに追記。追記のたびに `onTextDelta(累積テキスト全体)` を呼ぶ（差分ではなく累積を渡す）。
  - `thinking_delta` → thinkingブロックのthinkingフィールドに追記。**`signature_delta` → thinkingブロックのsignatureに格納。これを落とすと次反復のリプレイがAPIに拒否されるので絶対に落とさない。**
  - `input_json_delta` → tool_useブロックのpartial_jsonを蓄積し、`content_block_stop` で `JSON.parse` して input に格納（空文字列は `{}` 扱い）。
  - thinkingのテキストは `onTextDelta` に流さない（回答テキストのみ）。
- `message_delta` から stop_reason と usage を取得し、既存の `[usage]` ログを同形式で出す（cache_read等含む）。
- 組み立てたblocksは非ストリーミング時と同じく **verbatimで this.messages に保存**（thinking含む）。ここの挙動差ゼロが最重要。
- リクエスト成功後にのみ this.messages を変更する（ストリーム途中死→リトライで会話状態が壊れない）。
- claudeFetch のOAuthヘッダー・betas・リトライ回数・Fable5フォールバックは一切変更しない。ストリーミング時のタイムアウトのみ変更: 全体300s固定ではなく「**60秒間データが1バイトも来なければabort**」のアイドルタイムアウト（AbortController + チャンク受信ごとにタイマーリセット）。非ストリーミング経路は現行の `AbortSignal.timeout(300000)` のまま。

### A-2. runAgent の伝搬（src/services/agent.js）
- `runAgent({..., onAnswerDelta })` を追加し、各 `session.step()` に `onTextDelta: onAnswerDelta` として渡すだけ。Gemini/OpenAI/DeepSeekセッションは `onTextDelta` を無視してよい（シグネチャ上受け取って捨てる）。

### A-3. Discord逐次表示（src/services/streamReply.js 新規 + src/index.js）
- 新規モジュール `streamReply.js`: `createStreamReply(channel, { throttleMs = 2500, softLimit = 1900, now })` → `{ update(fullText), finalize(fullText), reset() }` を返す。
  - `update`: 2.5秒スロットルで「現在のメッセージ」を編集。初回テキスト到着時に最初のメッセージを `channel.send` で作る。表示中は末尾にカーソル `▌` を付ける。
  - softLimit(1900字)超過時: 段落境界(`\n\n`)優先、なければ改行、なければ強制カットで現在メッセージを確定し、残りを新しいメッセージとして継続。確定済みメッセージは以後編集しない。
  - `finalize(fullText)`: スロットル無視で最終状態に編集（カーソル除去）。全メッセージ2000字以内保証。テキスト全体が既送分＋現在分と一致するよう分割を完成させる。
  - `reset()`: 途中までストリームしたがそのstepが回答ではなかった（tool_useで終わった）場合に、作ってしまったメッセージを全削除して初期状態に戻す。
  - 時刻は `now` 関数を注入可能にしてユニットテスト可能にする（デフォルト `Date.now`）。Discordのedit/sendはawaitし、レートリミット例外はcatchして落ちないこと。
- index.js MessageCreate側: `onAnswerDelta` で streamReply.update を呼ぶ。runAgent完了後、(a)ストリーム済みなら `finalize(answer)` して chunkMessage 送信はスキップ、(b)一度もdeltaが来ていなければ現行どおり chunkMessage で送る。ステータスメッセージ（⏳/ツールラベル/✅）は現行どおり別メッセージで維持。
- 複数step間の混線対策: 各stepの累積テキストは0から始まる。stepがtool_useで終わった場合は index.js の `onToolCall` コールバック内（＝ツール実行後に必ず呼ばれる）で `streamReply.reset()` を呼ぶ。最終回答のstepだけがfinalizeに到達する。
- /research（interaction）経路はストリーミング対象外（現行のdeferReply→editReply運用のまま）。

## 機能B: #ai-memory（自主参照方式）

### B-1. ai-memory チャンネルの特例（src/index.js）
- 現行の「`ai-` で始まるチャンネルをAIチャットチャンネルとして自動登録」処理で、**チャンネル名が正確に `ai-memory` のものだけは登録しない**（= botが会話反応しない）。判定は再利用可能な純関数（例: `isAiChatChannel(name)`）として切り出し、exportしてユニットテスト可能にする。登録箇所は複数ある可能性がある（起動時スキャン・ChannelCreate・GuildCreate等）ので全箇所をこの関数に統一する。

### B-2. システムプロンプト（src/services/prompt.js）
- チャンネル地図の除外は aiChannelIds ベースなので、ai-memory は登録されなくなれば自然に地図に載る。地図上で名前が `ai-memory` のチャンネルには `(あなたの長期記憶)` の注記を付ける。
- ギルドに `ai-memory` テキストチャンネルが**存在するときだけ**、personaに「## 長期記憶 (#ai-memory)」セクションを追加:
  - サーバー固有の人物・好み・決定事項・経緯が関わる質問では、まず #ai-memory を read_channel で読む。
  - ユーザーに「覚えて」と言われたとき、または会話でサーバーに関する持続的な事実（好み・決定・役割）を得たときは、#ai-memory に send_message で保存する。1メッセージ=1事実、簡潔に。
  - 古くなった記憶は delete_message（自分のメッセージのみ可）で消してから書き直す。
  - **#ai-memory への send_message と自分のメッセージの delete_message に限り、明示依頼がなくても自律的に使ってよい**（「変更系ツールは明示依頼時のみ」の例外としてプロンプトに明記）。
- ai-memory チャンネルが存在しないギルドではこのセクションを出さない。

### B-3. delete_message ツール（src/services/tools.js）
- 新ツール `delete_message(channel_id, message_id)`: 対象メッセージをfetchし、**author.id が bot自身のときだけ削除**。他人のメッセージなら `権限エラー: 自分のメッセージ以外は削除できません。` をツール結果として返す（throwしない）。ADMIN_TOOLSには入れない。
- bot自身のIDは `guild.client.user.id` または `guild.members.me?.id` で取得（executeToolの既存引数を壊さない最小の方法を選ぶ）。
- toolLabel に delete_message 用ラベルを追加。TOOLSのdescriptionに「自分のメッセージのみ削除可。主に#ai-memoryの記憶更新に使う」旨を書く。

## 機能C（ストレッチ・失敗したら撤退）: thinking要約ステータス
- Fable 5 のthinking要約表示を**1回だけ**プローブ: `output_config: { thinking: { display: 'summarized' } }` を付けた小リクエスト（fable-5, 短いプロンプト）を試し、400なら別の妥当な形を**最大もう1回だけ**試す。通らなければ**実装せず撤退**し、プローブ結果（送ったパラメータと返ったエラー本文）を報告に書く。
- 通った場合のみ: ストリーミング中の thinking_delta（要約テキスト）を `onThinkingDelta` としてrunAgent→index.jsに流し、ステータスメッセージを `> 🧠 <要約の末尾80字>` に2.5sスロットルで編集。回答テキストが流れ始めたらステータス更新をやめる。

## 禁止事項
- claudeFetch のOAuthヘッダー・リトライ・Fable5フォールバック挙動の変更禁止（ストリーミング時のアイドルタイムアウト追加を除く）
- 画像base64方式・thinkingのverbatim保存・cache_control配置（identity→persona(cache)→time、最終メッセージ末尾ブロック）の変更禁止
- Gemini/OpenAI/DeepSeekセッションの動作変更禁止（onTextDelta無視の追加のみ可）
- git commit / push / デプロイ禁止（親がやる）
- reasonix-do / DeepSeek / 外部LLM APIの新規利用禁止（無退行確認のためのdeepseek-chat 1回実行のみ可）
- 勝手な仕様変更・大規模リファクタ・関係ない変更・長文ログ貼り付け禁止

## 検証（実装者セルフチェック。盲検verifierは別途走る）
- `find src -name "*.js" | xargs -n1 node --check`
- 実API（.envのトークン）でストリーミングstepの動作確認。**コスト注意: テストは原則 claude-haiku-4-5-20251001。fable-5 は「ストリーミング下のthinkingリプレイ確認」と機能Cプローブだけに使う**
- streamReply のユニットテスト（フェイクchannel/message + 注入クロック）
- isAiChatChannel のユニットテスト
- 15秒起動スモーク（`Ready! Logged in as` 確認）
- 一時テストスクリプトはプロジェクト直下に作り、終了後削除
