# 合格基準（rubric）— Phase 2: ストリーミング + #ai-memory

実装の経緯は見ずに、現在のコード（mainとの差分）と実際の動作だけで機械的に照合すること。曖昧な場合は不合格側に倒す。`.env`の実トークンを使い、一時スクリプトはプロジェクト直下に作成し実行後削除（LLM APIのモック禁止。Discordのguild/channel/message/memberはフェイクでよい）。コスト注意: 実APIテストは原則 `claude-haiku-4-5-20251001`。`claude-fable-5` は項目2-4（thinkingリプレイ）のみに使う。

## 1. 構成
- [ ] `src/services/streamReply.js` が存在し、update/finalize/reset 相当を提供
- [ ] `runAgent` が `onAnswerDelta` を受け取り session.step に伝搬する
- [ ] `tools.js` の TOOLS に `delete_message` があり、ADMIN_TOOLS には含まれない
- [ ] `index.js` が AIチャットチャンネル判定の純関数（`isAiChatChannel` 相当）をexportし、全登録箇所で使っている
- [ ] 全srcファイルが `node --check` を通る
- [ ] `timeout 17 node src/index.js` で `Ready! Logged in as umineko-agent#3789`、起動エラーなし

## 2. ストリーミング（実API・fetchフックで生リクエスト/レスポンス捕捉）
- [ ] **逐次コールバック**: ClaudeAgentSession（haiku可）で `step({onTextDelta})` を呼ぶと、`stream:true` がリクエストボディに載り、onTextDelta が2回以上・単調増加する累積テキストで呼ばれ、最終的な step 戻り値 text と最後のコールバック値が一致する
- [ ] **非ストリーミング経路の温存**: onTextDelta を渡さない step は `stream` を送らない（従来動作）
- [ ] **ツールループがストリーミングで完走**: フェイクguild read_channel を仕込み、onTextDelta ありで2反復以上のループが完走し、tool_use の input が正しく組み立てられている（input_json_delta の再組み立て）
- [ ] **thinkingリプレイ（fable-5・このrubricの核心）**: 分析を要するタスク（複数チャンネルの突き合わせ等）を onTextDelta ありで実行。1回目のレスポンスに thinking ブロックがあることを前提確認した上で、**2回目のリクエストの messages に thinking ブロックが signature 付きで含まれ、APIが400を返さない**こと（SSE再組み立てで signature_delta が保存されている証拠）。thinking のテキストが onTextDelta に混入しないことも確認
- [ ] **キャッシュ無退行**: 同ループで2回目レスポンスの cache_read_input_tokens > 0、[usage]ログが出る
- [ ] **アイドルタイムアウト**: ストリーミング経路に「無通信60秒でabort」の実装がある（コードレビューで確認。タイマーがチャンク受信ごとにリセットされる構造であること）

## 3. Discord逐次表示（ユニット・フェイクchannel + 注入クロック）
- [ ] 初回 update でメッセージが send され、スロットル窓内の連続 update は edit を発生させない（注入クロックで検証）
- [ ] 2.5秒経過後の update で edit が走り、表示中テキスト末尾にカーソル（▌）が付く
- [ ] 1900字超で段落境界優先の分割が起き、確定メッセージ＋新メッセージに継続。finalize 後の全メッセージを結合すると最終テキストと一致し、各メッセージ2000字以内
- [ ] reset() が送信済みメッセージを削除して初期状態に戻す
- [ ] **リトライ再描画**: update に「前回より短い（縮んだ）fullText」を渡すと再スタートと判定され、送信済みメッセージが破棄されてゼロから描画し直される（ストリーム途中リトライで古い試行のテキストが画面に残らない）。1900字分割確定後に縮んだfullTextが来るケースをユニットで確認
- [ ] index.js: ストリーム済みなら chunkMessage 送信をスキップ、delta ゼロなら chunkMessage 送信（コードレビューで分岐を確認）。tool_use で終わる step の後に reset が呼ばれる経路がある

## 4. #ai-memory
- [ ] `isAiChatChannel('ai-chat')` → true、`isAiChatChannel('ai-memory')` → false、`isAiChatChannel('general')` → false
- [ ] buildSystemPrompt: フェイクguildに `ai-memory` チャンネルあり → personaに長期記憶セクション（read_channel での参照、send_message での保存、delete_message での更新、自律使用の例外明記）が含まれ、地図に `ai-memory` が記憶注記付きで載る
- [ ] buildSystemPrompt: `ai-memory` なしのguild → 長期記憶セクションが出ない
- [ ] delete_message 実機能（フェイク）: bot自身のメッセージ → delete が呼ばれ成功文言。他人のメッセージ → `権限エラー` 文言が返り delete は呼ばれない
- [ ] toolLabel('delete_message', ...) が意味のあるラベルを返す

## 5. 無退行
- [ ] 雑談（ツールなし・haiku・非ストリーミング）が従来どおり動く
- [ ] Gemini `gemini-2.5-flash` のツールループ1周が従来どおり動く（onAnswerDelta を渡しても壊れない）
- [ ] 画像: read_channel ツール結果の画像が tool_result 内 type:"image"（base64）で送られる（非ストリーミングで確認可）
- [ ] chunkMessage のユニット（2000字以内・段落境界優先）が引き続き成立

## 6. 機能C（条件付き）
- [ ] thinking要約ステータスが実装されている場合のみ: fable-5 で thinking 要約テキストが取得でき、ステータス編集コールバックに流れる。未実装の場合: 実装しない判断の根拠（プローブで送ったパラメータ・返ったエラー）が verifier-report ではなく実装報告に記載されているはず — verifier は「機能Cのコードが中途半端に残っていない（死にコードなし）」ことだけ確認

## 7. 総合判定
全項目合格なら `.ai/verifier-report.md` に合格と各項目の根拠を記録。不合格項目は具体的な失敗内容を明記。
