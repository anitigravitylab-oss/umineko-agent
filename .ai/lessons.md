# 教訓（セッションをまたいで効くもの。永続・追記専用）

- **Anthropic `image.source.type:'url'`（サーバー側URL取得）は、このbotのOAuth/Maxサブスク認証経路（`anthropic-beta: oauth-2025-04-20`）だと、公開されている到達可能なURLでも毎回 `400 Unable to download the file` で失敗する**。実機検証で確認済み。回避策：自前で `fetch()` → base64化 → `source:{type:'base64',...}` で送る方式に切り替えると安定動作する。今後Claude系で画像・ファイルをURL経由で渡す実装をする場合は、まずこの制約を疑うこと（`src/services/provider.js` の `fetchImageAsBase64` 参照）。
- **`.ai/rubric.md` を書くとき、「このファイルに差分がないこと」を機械的チェック項目にする前に、作業ディレクトリが本当にクリーンか（前タスクの未コミット変更が残っていないか）を確認すること**。未コミットの前タスクの差分が残ったまま次のタスクのrubricを「diff ゼロ」で書くと、正しい実装を誤って不合格判定してしまう（実際にこの手順で一度書き直しが発生した）。理想は前タスク完了時にコミットしてから次のrubricを書くこと。それが難しい場合はrubricに前提となる既知の差分を明記する。
- **Fable 5のthinkingブロックは自明なツール呼び出しでは出力されないことがある**（effort=maxでも）。thinking保存・再送まわりの検証は「複数情報源の突き合わせ」など分析を要するタスクで誘発し、まず1回目のレスポンスにthinkingが存在することを前提確認してから2回目のリクエストを判定する。
- **このbotのOAuth/Max認証経路では `output_config` は `effort` 以外のキーを受け付けない**（`output_config.thinking.display` 等は `Extra inputs are not permitted` で400。2026-07-02プローブ確認）。thinking要約表示などの機能はこの経路では使えない前提で設計する。
