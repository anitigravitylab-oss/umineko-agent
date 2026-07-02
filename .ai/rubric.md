# 合格基準（rubric）— Phase 3: #ai-config ペルソナカスタマイズ + README改訂

実装の経緯は見ずに、現在のコード（mainとの差分）と実際の動作だけで機械的に照合すること。曖昧な場合は不合格側に倒す。一時スクリプトはプロジェクト直下に作成し実行後削除。LLM APIのモック禁止（Discordのguild/channel/message/pinはフェイク可）。コスト厳守: 実APIは `claude-haiku-4-5-20251001` を1〜2回まで。`claude-fable-5` 使用禁止。

## 1. 構成
- [ ] `src/services/personaConfig.js` が存在し、`getPersonaConfig` / `clearPersonaConfigCache` をexport
- [ ] `isAiChatChannel('ai-config')` → false、`isAiChatChannel('ai-chat')` → true、`isAiChatChannel('ai-memory')` → false
- [ ] `package.json` の version が `0.4.0`
- [ ] 全srcファイルが `node --check` を通る
- [ ] `timeout 17 node src/index.js` で `Ready! Logged in as umineko-agent#3789`、起動エラーなし

## 2. personaConfig（ユニット・フェイクguild）
- [ ] ai-config チャンネルあり（topic + ピン2件）→ 戻り値にtopicと両ピンの内容が含まれ、ピンはcreatedTimestamp昇順
- [ ] ai-config チャンネルなし → null。topicもピンも空 → null
- [ ] 合計4000字超 → 4000字程度で切り詰められ省略マーカーが付く
- [ ] TTLキャッシュ: 同一guildで2回目の呼び出しでは fetchPinned が再実行されない（呼び出し回数を記録するフェイクで確認）。`clearPersonaConfigCache(guildId)` 後は再実行される
- [ ] fetchPinned が例外を投げても throw せず null（または空）を返す

## 3. プロンプト注入
- [ ] `buildSystemPrompt(guild, aiChannelIds, {custom: '...'})` → personaに「サーバー独自設定」相当のセクションが出現し、管理者設定を優先する旨の文言とcustom本文を含む
- [ ] custom なし（null/undefined/空文字）→ セクションが出現しない
- [ ] researchモード併用時、research追記もサーバー独自設定も両方含まれる
- [ ] 地図上で `ai-config` チャンネルに注記（ペルソナ設定である旨）が付く
- [ ] `agent.js` の runAgent が getPersonaConfig を呼び buildSystemPrompt に渡している（コードレビュー）。channels.cache が**空**（存在はする）のフェイクguildでも runAgent が落ちない。`getPersonaConfig` 単体は guild が null / channels.cache 欠如でも throw しない（channels.cache を完全に持たないguildでの runAgent 全体は実運用に存在しないため対象外）
- [ ] **キャッシュ配置の無退行**: リクエストのsystem配列が従来どおり identity → persona(cache_control) → time の順（コードレビューまたはfetchフック）

## 4. 即時反映（コードレビュー）
- [ ] index.js に ChannelPinsUpdate / ChannelUpdate のリスナーがあり、ai-config チャンネルの変更で clearPersonaConfigCache が呼ばれる（ChannelUpdateは改名で ai-config になった/でなくなった両方向をカバー）

## 5. README.md
- [ ] Router / Planner / Finalizer / 旧ファイル名（router.js, planner.js, finalizer.js, llm.js, research.js, contextBuilder.js, channelSelector.js, deepseek.js）への言及が本文にない（アーキテクチャ説明が単一ループとして書かれている）
- [ ] 環境変数の表があり、`grep -rhoP "process\.env\.[A-Z_]+" src/ | sort -u` の結果と過不足なく対応する（コード側にあってREADMEにない変数、READMEにあってコードにない変数がいずれもゼロ）
- [ ] 機能説明に以下が全部ある: ai-プレフィックス自動認識 / ストリーミング返信(Claude系) / 画像読解(Claude系) / #ai-memory / #ai-config / /ai サブコマンド4種(status/model/effort/reset) / /research
- [ ] 対応モデルの記載が constants.js / index.js の choices と矛盾しない
- [ ] デプロイ節に scripts/deploy.sh と --rollback の説明がある

## 6. 実API統合（haiku 1回）
- [ ] ai-config ありのフェイクguild（topicに一意な口調指示、例:「語尾に『にゃ』を付ける」）で runAgent 雑談 → 応答が返り、口調指示が反映される（反映は緩め判定: 応答に指示痕跡があれば合格、なければsystemプロンプト送信内容に指示が入っていることをfetchフックで確認して合格）

## 7. 無退行
- [ ] chunkMessage / streamReply / isAiChatChannel の既存ユニット相当が引き続き成立（streamReplyは初回send+スロットル+リトライ再描画の3点だけで可）

## 8. 総合判定
全項目合格なら `.ai/verifier-report.md` に合格と各項目の根拠を記録（上書き）。不合格項目は具体的な失敗内容を明記。
