# 検証レポート — Phase 4: #ai-memory自動埋め込み + #ai-config read_channel遮断

検証方法: 盲検（実装経緯・current-task.md・failure-log.md・lessons.md・git log/コミットメッセージは一切参照せず、rubric.mdと現在のコード・実際の動作のみで判定）。
検証日: 2026-07-04
対象: ブランチ `feat/ai-memory-auto-digest`（mainとの未コミット差分）、作業ディレクトリ `/root/projects/discord-ai-bot`

## 総合判定: **合格**

rubric.md 全項目（1〜8、9件のセクション・計30チェック項目）を、フェイクDiscordオブジェクト（discord.jsの実Collectionクラス使用）によるユニットテスト、コードレビュー、および実API（`claude-haiku-4-5-20251001`のみ、計2回）で照合し、全項目が合格基準を満たすことを確認した。

---

## 1. 構成

- [x] `src/services/personaConfig.js` が `getMemoryDigest` / `clearMemoryDigestCache` をexport。既存の `getPersonaConfig` / `clearPersonaConfigCache` も引き続きexportされている。
  根拠: `node -e "import('./src/services/personaConfig.js').then(m=>console.log(Object.keys(m)))"` → `['clearMemoryDigestCache','clearPersonaConfigCache','getMemoryDigest','getPersonaConfig']`、全て関数型。「変更なし」は git diff等の経緯参照ができないため、8.2a/8.2b/8.2c（下記）の挙動テストで代替確認（トピック/ピン取得・TTLキャッシュ・即時クリアが全て既存仕様どおり動作）。
- [x] 全srcファイルが `node --check` を通る。
  根拠: `src/` 配下11ファイル全てで `node --check` 実行、全てOK（index.js, constants.js, agent.js, streamReply.js, tools.js, provider.js, prompt.js, settings.js, attachments.js, personaConfig.js, historyBuilder.js）。
- [x] `timeout 17 node src/index.js` で `Ready! Logged in as umineko-agent#3789`、起動エラーなし。
  根拠: 実行ログに `Ready! Logged in as umineko-agent#3789` を確認。以降はギルドごとの `AI channel registered:` / `[commands] Registered /ai for guild` のみで、エラー・スタックトレースなし（node標準のpunycode非推奨警告のみ、無関係）。17秒後にtimeoutによりSIGTERMで正常終了（exit 143、意図どおり）。新規チャンネル作成（`AI channel created:`）は発生せず、実サーバーへの副作用なし。

## 2. getMemoryDigest（ユニット・フェイクguild）

フェイクguild/channel/message（discord.jsの実Collectionクラスで構築、LLM API呼び出しなし）で以下を全て確認（6/6 PASS）:

- [x] 複数メッセージ → 整形文字列、各メッセージの発言者名+内容を含み、古い順。timestampを意図的に挿入順とバラして検証（3000/1000/2000で挿入 → 出力は1000/2000/3000の順=`bob→carol→alice`）。
- [x] `ai-memory` チャンネルなし → `null`。
- [x] `ai-memory` チャンネルはあるがメッセージ0件 → `null`。空白のみcontentのメッセージのみの場合も別途 → `null`。
- [x] 合計4000字超 → 切り詰め。結果は4000字以内、`…(古い記憶は省略)` で始まり、最新メッセージ内容は残存、最古メッセージ内容は消失（新しい記憶を優先する仕様どおり）。
- [x] TTLキャッシュ: フェッチ回数カウンタで確認。1回目 `fetchCount=1`、2回目（同一guild、TTL内）も `fetchCount=1`（再フェッチなし）。`clearMemoryDigestCache(guildId)` 後の3回目で `fetchCount=2`（再フェッチ）。
- [x] fetch失敗（例外throw）時 → `console.warn` を出しつつ `null` を返す。呼び出し元へのthrowなし。

## 3. buildSystemPrompt への統合

（5/5 + キャッシュ配置1件、計6 PASS）

- [x] `memoryDigest` に非空文字列 → 長期記憶セクション内にその内容がそのまま含まれる。
- [x] `memoryDigest` が `null`/`undefined`/`''`/空白のみ → いずれも「以下は#ai-memoryに書かれている内容」という自動埋め込み導入文言は出ない。一方 `read_channel で読む` という促し文言は残る（ai-memoryチャンネル自体は存在するケース）。
- [x] `ai-memory` チャンネル自体が存在しない → `## 長期記憶` セクション自体が丸ごと出ない。
- [x] `custom` と `memoryDigest` を同時に渡す → 両方とも独立したセクション（`## 長期記憶` / `## サーバー独自設定`）に含まれる。
- [x] 地図上の `(あなたの長期記憶)`（#ai-memory向け）・`(ペルソナ設定)`（#ai-config向け）注記は健在。無関係チャンネルには付与されないことも確認。
- [x] **キャッシュ配置の無退行**: `src/services/provider.js` の `ClaudeAgentSession.step()` を読むと `system: [identity, persona(cache_control:ephemeral), time]` の順で組み立てている（コードレビュー）。さらに項目7の実APIコールでfetchフックにより実際に送信されたリクエストボディを検証し、`system[0]`=identity（cache_control無し）、`system[1]`=persona（`cache_control:{type:'ephemeral'}`あり）、`system[2]`=time（cache_control無し、`現在時刻`で始まる）という順序・構造を実測でも確認。

## 4. agent.js統合

- [x] `runAgent` が `getMemoryDigest(guild)` を呼び `buildSystemPrompt` に渡している（コードレビュー）。
  根拠: `src/services/agent.js` 21-23行目:
  ```
  const custom = await getPersonaConfig(guild);
  const memoryDigest = await getMemoryDigest(guild);
  const system = buildSystemPrompt(guild, aiChannelIds, { mode, custom, memoryDigest });
  ```
- [x] `channels.cache` が空のフェイクguildでも `runAgent` が落ちない。
  根拠: 実API（`claude-haiku-4-5-20251001`、1回）で `channels.cache.size===0` のフェイクguildに対し実際に `runAgent()` をフルパスで実行し、例外なく文字列応答（「こんにちは！調子は良好です。」）を得た。

## 5. read_channelの#ai-config遮断（4/4 PASS）

- [x] `read_channel(channel_name:'ai-config')` → `ai-config` チャンネル自体をメッセージ付きでguildに実在させた状態でも、返却テキストは `チャンネル #ai-config が見つかりませんでした。` のみで、仕込んだ秘密メッセージ内容の漏洩なしを確認。
- [x] `read_channel(channel_name:'ai-memory')` → 引き続き正常にメッセージ内容を読める（無退行）。
- [x] `read_channel(channel_name:'general'相当の通常チャンネル)` → 引き続き正常に読める（無退行）。
- [x] `aiChannelIds` に登録済みのAIチャットチャンネル名（例: `ai-work`）→ 既存どおり「見つかりませんでした」（無退行、既存フィルタ条件は健在）。

## 5b. #ai-configのメッセージフォールバック（4/4 PASS）

- [x] トピックなし・ピンなし・メッセージあり → そのメッセージ内容が `getPersonaConfig` の戻り値としてフォールバックで返る。
- [x] トピックが1件でもある → フォールバック不使用（直近メッセージ内容は戻り値に混ざらない）。
- [x] ピンが1件でもある → フォールバック不使用（直近メッセージ内容は戻り値に混ざらない）。
- [x] トピックなし・ピンなし・メッセージもなし → `null`。
- [x] `send_message(channel_name:'ai-config', ...)` → 実送信されず（`channel.send` 呼び出し回数0で確認）、`権限エラー` を含むテキストが返る。

## 5c. send_messageの#ai-config遮断（2件、うち1件は5bと重複確認）

- [x] `send_message(channel_name:'ai-config', ...)` → 上記5b最終項目と同一挙動を確認済み（rubric指示どおり1項目として扱う）。
- [x] `send_message(channel_name:<通常チャンネル>, ...)` → `channel.send` が実際に1回呼ばれ、指定内容で送信され、`権限エラー` を含まない成功テキストが返る（無退行）。

## 6. 即時反映（コードレビュー、2/2 PASS）

`src/index.js` 226-231行目:
```js
client.on(Events.MessageCreate, (message) => {
  if (!message.guild) return;
  const name = message.channel?.name;
  if (name === AI_MEMORY_CHANNEL_NAME) clearMemoryDigestCache(message.guild.id);
  else if (name === AI_CONFIG_CHANNEL_NAME) clearPersonaConfigCache(message.guild.id);
});
```
- [x] `#ai-memory` へのMessageCreateリスナーがあり `clearMemoryDigestCache` を呼んでいる。
- [x] `#ai-config` へのMessageCreateリスナーがあり `clearPersonaConfigCache` を呼んでいる（フォールバック経路のため新規必要）。

## 7. 実API統合（haiku、1回）

- [x] `ai-memory` に一意な内容（`合言葉はパイナップル`）を仕込んだフェイクguildで `runAgent` に雑談質問（Pythonの一般知識質問、read_channelを誘発しない）を投げ、`globalThis.fetch` フックで `/v1/messages` への最初のリクエストボディを捕捉。
  結果: 捕捉された唯一のリクエスト（＝read_channelは一切呼ばれず、モデルは直接回答）の `system[1].text`（persona）に `合言葉はパイナップル` がそのまま含まれていることを確認。runAgentの実装上、`buildSystemPrompt`はセッション開始前・最初のAPI呼び出し前に同期的に完了しているため、構造的にも「read_channel呼び出し前に既に含まれる」ことが保証されている。

## 8. 無退行（6/6 PASS）

- [x] `send_message` の `#ai-memory` 向け動作（自律使用可）に変化なし: `send_message(channel_name:'ai-memory', ...)` は `#ai-config` のような遮断を受けず、`channel.send` が呼ばれ正常送信される。
- [x] `delete_message` の「bot自身のメッセージのみ削除可」に変化なし: bot自身が投稿したメッセージ（authorId一致）→ 削除成功。他人のメッセージ → `権限エラー: 自分のメッセージ以外は削除できません。`。
- [x] `#ai-config` のトピックのみ設定 → 戻り値はトピックそのまま（既存どおり）。
- [x] `#ai-config` のピンのみ設定（複数） → 古い順に`\n\n`結合で返る（既存どおり）。
- [x] `#ai-config` のTTLキャッシュ（`fetchPinned`呼び出し回数で確認）: 2回目はキャッシュヒットで再フェッチなし、`clearPersonaConfigCache`後は再フェッチ。既存メカニズムに退行なし。

## 9. 総合判定

**全項目合格。** 不合格項目、要修正事項は無し。

---

## 検証方法の補足

- フェイクDiscordオブジェクトは discord.js の実 `Collection` クラスを土台に手作りした `guild`/`channel`/`message` を使用（LLM APIは一切モックせず、Discord側のみフェイク）。
- 実APIコールは合計2回、いずれも `claude-haiku-4-5-20251001`。`claude-fable-5` / `claude-opus-4-8` は不使用（`[usage] model=claude-haiku-4-5-20251001` のログで実測確認）。
- 「既存機能の変更なし」系の項目は、git diffや実装経緯を参照せず、現在のコードの挙動テストで代替確認する方針を採った（盲検性維持のため）。
- 一時検証スクリプト（`_verify_fakes.mjs` / `_verify_unit.mjs` / `_verify_real_api.mjs`）はプロジェクト直下に作成し実行後に削除済み。`git status --short` で残存なしを確認済み（`settings.json` 等の副産物も生成されていない）。
- プロダクトコード（`src/`以下）・`.ai/rubric.md`・`.ai/current-task.md` 等への変更は一切行っていない（`.ai/verifier-report.md` の上書きのみ）。
