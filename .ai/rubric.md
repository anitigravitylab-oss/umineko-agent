# 合格基準（rubric）— Phase 4: #ai-memory自動埋め込み + #ai-config read_channel遮断

実装の経緯は見ずに、現在のコード（mainとの差分）と実際の動作だけで機械的に照合すること。曖昧な場合は不合格側に倒す。一時スクリプトはプロジェクト直下に作成し実行後削除。LLM APIのモック禁止（Discordのguild/channel/message/fetchのフェイクは可）。コスト厳守: 実APIは `claude-haiku-4-5-20251001` を1〜2回まで。`claude-fable-5`/`claude-opus-4-8` 使用禁止。

## 1. 構成
- [ ] `src/services/personaConfig.js` が `getMemoryDigest` / `clearMemoryDigestCache` をexport（既存の `getPersonaConfig` / `clearPersonaConfigCache` は変更なし）
- [ ] 全srcファイルが `node --check` を通る
- [ ] `timeout 17 node src/index.js` で `Ready! Logged in as umineko-agent#3789`、起動エラーなし

## 2. getMemoryDigest（ユニット・フェイクguild）
- [ ] `ai-memory` チャンネルに複数メッセージあり → 整形された文字列が返り、各メッセージの発言者名と内容が含まれる、古い順
- [ ] `ai-memory` チャンネルなし → null
- [ ] `ai-memory` チャンネルはあるがメッセージ0件（または空文字content only）→ null
- [ ] 合計4000字超 → 切り詰められ省略マーカーが付く
- [ ] TTLキャッシュ: 同一guildで2回目の呼び出しでは `messages.fetch` が再実行されない（呼び出し回数を記録するフェイクで確認）。`clearMemoryDigestCache(guildId)` 後は再実行される
- [ ] fetch失敗時にthrowせずnullを返す（非クラッシュ）

## 3. buildSystemPrompt への統合
- [ ] `memoryDigest` に非空文字列を渡す → persona内の長期記憶セクションにその内容がそのまま含まれる
- [ ] `memoryDigest` がnull/undefined/空文字 → 長期記憶セクション内に自動埋め込み部分の文言が出ない（ただしai-memoryチャンネル自体が存在する場合はread_channelを促す文言は残る）
- [ ] `ai-memory` チャンネル自体が存在しない場合 → 長期記憶セクション自体が出ない（既存動作の無退行）
- [ ] `custom`（#ai-config由来）と`memoryDigest`を同時に渡した場合、両方ともpersonaに含まれる
- [ ] 地図上の `(あなたの長期記憶)` `(ペルソナ設定)` 注記は既存どおり変化なし
- [ ] **キャッシュ配置の無退行**: system配列が identity → persona(cache_control) → time の順（コードレビューまたはfetchフック）

## 4. agent.js統合
- [ ] `runAgent` が `getMemoryDigest(guild)` を呼び `buildSystemPrompt` に渡している（コードレビュー）
- [ ] `channels.cache` が空のフェイクguildでも `runAgent` が落ちない

## 5. read_channelの#ai-config遮断
- [ ] `executeTool('read_channel', {channel_name: 'ai-config'}, ...)` → 実際のチャンネル内容ではなく「見つかりませんでした」相当のエラーテキストが返る（実際に`ai-config`チャンネルがフェイクguildに存在し、かつ中にメッセージがあってもその内容が漏れないことを確認）
- [ ] `executeTool('read_channel', {channel_name: 'ai-memory'}, ...)` → 引き続き正常にメッセージ内容が読める（無退行）
- [ ] `executeTool('read_channel', {channel_name: '<通常チャンネル>'}, ...)` → 引き続き正常に読める（無退行）
- [ ] `aiChannelIds` に登録された通常のAIチャットチャンネル名でも、既存どおり読めない（無退行、既存フィルタ条件が壊れていない）

## 5b. #ai-configのメッセージフォールバック（2026-07-03追加）
- [ ] トピックなし・ピンなし・#ai-configにメッセージあり → そのメッセージ内容がgetPersonaConfigの戻り値としてフォールバックで返る
- [ ] トピックまたはピンが1件でもある → メッセージフォールバックは使われない（直近メッセージの内容が戻り値に混ざらない）
- [ ] トピックなし・ピンなし・メッセージもなし → null
- [ ] `executeTool('send_message', {channel_name: 'ai-config', content: '...'}, ...)` → 実際には送信されず権限エラー相当のテキストが返る

## 5c. send_messageの#ai-config遮断（自己汚染防止・2026-07-03追加）
- [ ] `executeTool('send_message', {channel_name: 'ai-config', content: '...'}, ...)` → 実際には送信されず権限エラー相当のテキストが返る
- [ ] `executeTool('send_message', {channel_name: '<通常チャンネル>', content: '...'}, ...)` → 引き続き正常に送信される（無退行）

## 6. 即時反映（コードレビュー）
- [ ] index.js に `#ai-memory` チャンネルへの MessageCreate（少なくとも）のリスナーがあり、`clearMemoryDigestCache` を呼んでいる
- [ ] index.js に `#ai-config` チャンネルへの MessageCreate のリスナーがあり、`clearPersonaConfigCache` を呼んでいる（フォールバック経路のため新規追加）

## 7. 実API統合（haiku 1回）
- [ ] `ai-memory` に一意な内容（例:「合言葉はパイナップル」）を仕込んだフェイクguildで `runAgent` 雑談（read_channelを誘発しない質問）→ fetchフックで送信された最初のsystemプロンプトの中に、read_channelを呼ぶ前から既にその内容が含まれていることを確認する

## 8. 無退行
- [ ] send_message / delete_message ツールの `#ai-memory` 向け動作（自律使用可、bot自身のメッセージのみ削除可）に変化なし
- [ ] `#ai-config` のトピック/ピン留め自動反映機構（`getPersonaConfig`）自体は無変更・無退行

## 9. 総合判定
全項目合格なら `.ai/verifier-report.md` に合格と各項目の根拠を記録（上書き）。不合格項目は具体的な失敗内容を明記。
