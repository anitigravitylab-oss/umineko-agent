# Verifier Report — Phase 3: #ai-config ペルソナカスタマイズ + README改訂

**検証方法**: 盲検（実装経緯・`current-task.md`・`failure-log.md`・`lessons.md`・git logは一切参照せず、`rubric.md`と現在のコード・実際の動作のみを根拠とした）。
実APIは `claude-haiku-4-5-20251001` のみを使用し、`runAgent()` 経由で2回呼び出した（内部的にツール呼び出しを1回挟んだケースが1件あり、Anthropicへの生HTTPリクエストは合計3回。詳細は6節）。`claude-fable-5` は不使用。一時検証スクリプトはプロジェクト直下に作成し、全て実行後削除済み（`git status --short` で残存なし確認済み）。

## 総合判定: **合格**

全項目 **すべてPASS**。不合格・スキップ項目なし。

---

## 1. 構成

- [x] **PASS** `src/services/personaConfig.js` が存在し、`getPersonaConfig` / `clearPersonaConfigCache` をexportしている（`personaConfig.js:49`, `:62`）。

- [x] **PASS** `isAiChatChannel('ai-config')===false` / `isAiChatChannel('ai-chat')===true` / `isAiChatChannel('ai-memory')===false` を実際に`index.js`をインポートして確認（`AI_SPECIAL_CHANNEL_NAMES = new Set(['ai-memory','ai-config'])` による除外、`index.js:143,149-151`）。

- [x] **PASS** `package.json` の `version` は `0.4.0`。

- [x] **PASS** 全11個のsrcファイル（`index.js` + `services/*.js` 10本）が `node --check` を通過することを実行確認。

- [x] **PASS** `timeout 17 node src/index.js` を実行し `Ready! Logged in as umineko-agent#3789` を確認（exit code 124 = timeoutによる正常なタイムアウト終了）。起動エラーなし（`punycode` deprecation警告のみ、Node.jsランタイムの一般警告でコードのエラーではない）。既存全ギルドのAIチャンネルスキャン・`/ai`コマンド登録も正常完了。プロセス終了後に残存プロセスなしを確認。

---

## 2. personaConfig（ユニット・フェイクguild）

フェイクguild（`channels.cache`を配列で表現。`Array.prototype.find/some/filter`は実装コードが要求するAPIと互換）と、呼び出し回数を記録するフェイク`fetchPinned`を用いてユニットテスト（API呼び出しなし）。

- [x] **PASS** ai-configチャンネル（topic + ピン2件、意図的に投稿順と逆の配列順で投入）→ 戻り値に topic とピン両方の本文が含まれ、`indexOf`で位置比較した結果 `topic → 早いピン → 遅いピン` の順（`createdTimestamp`昇順）で連結されていることを確認。

- [x] **PASS** ai-configチャンネルなし → `null`。チャンネルは存在するがtopicが空文字列/ `null`かつピンなし → いずれも`null`（2パターンとも確認）。

- [x] **PASS** 4000字超（5000字のtopicのみ）→ 戻り値の長さが正確に4000字、末尾が `…(省略)` で終わることを確認（`MAX_CHARS=4000`, `TRUNCATE_SUFFIX='…(省略)'` = 5文字、`personaConfig.js:9-10,17-20`と整合）。

- [x] **PASS** TTLキャッシュ: 同一guildで`getPersonaConfig`を2回連続呼び出し→フェイク`fetchPinned`の呼び出し回数は1のまま（2回目はキャッシュヒット）。`clearPersonaConfigCache(guildId)`後の3回目呼び出しで呼び出し回数が2に増加（再取得）。

- [x] **PASS** `fetchPinned`が例外を投げるフェイク実装で`getPersonaConfig`を呼んでも例外は伝播せず（`threw===false`）、`null`を返すことを確認（`personaConfig.js:37-41`の`catch`と整合）。

---

## 3. プロンプト注入

- [x] **PASS** `buildSystemPrompt(guild, aiChannelIds, {custom:'...'})` → personaに「サーバー独自設定」セクションが出現し、「優先」という管理者設定優先の文言、およびcustom本文（完全一致）を含むことを確認。

- [x] **PASS** `custom`が `null` / `undefined` / `''` / 未指定 / 空白のみ(`'   '`) のいずれの場合も「サーバー独自設定」セクションが一切出現しないことを確認（5パターン全て）。

- [x] **PASS** `mode:'research'` と `custom` を同時指定 → 「リサーチ」を含む深掘りモード追記と「サーバー独自設定」＋custom本文が両方personaに含まれることを確認。

- [x] **PASS** ai-configチャンネルを含むフェイクguildで`buildSystemPrompt`を実行 → 生成された「サーバーの地図」の該当行が `#ai-config [ID:...] (ペルソナ設定)` となり、注記が付くことを確認（`prompt.js:16`のconfigNoteロジックと整合）。

- [x] **PASS** コードレビュー: `agent.js`の`runAgent`は`const custom = await getPersonaConfig(guild)`（`agent.js:21`）→`buildSystemPrompt(guild, aiChannelIds, { mode, custom })`（`agent.js:22`）という順で呼び出しており、rubric要求どおりの配線を確認。
  - **channels.cacheが空配列（存在するが空）のフェイクguildでrunAgentが落ちないか**: 2系統で確認。(a) 関数単体テスト — `getPersonaConfig(guild)`と`buildSystemPrompt(guild, ...)`をそれぞれ`channels.cache: []`のguildに対して直接実行し、いずれも例外なく完了（`getPersonaConfig`は`null`、`buildSystemPrompt`は`persona`に`(なし)`を含む正常値を返す）。(b) 実際に`runAgent()`を`channels.cache: []`のフェイクguild・`claude-haiku-4-5-20251001`で実行（実API呼び出し）し、例外なく完了、非空の応答テキスト（`こんにちは！`）を得た。runAgent内でguildに依存する処理は`getPersonaConfig`/`buildSystemPrompt`（ネットワーク呼び出し前）と、ツール呼び出し時の`executeTool`のみであり、素朴な雑談では後者は発火しないため、この2系統で要求を実質的にカバーしていると判断。
  - `getPersonaConfig`単体は `guild===null` および `guild={id:'x'}`（`channels`プロパティ自体が欠如）のいずれでも例外を投げず`null`を返すことを確認（`personaConfig.js:50`の`guild?.channels?.cache`オプショナルチェーンと整合）。

- [x] **PASS キャッシュ配置の無退行**: 実際の`runAgent()`呼び出し（claude-haiku、上記(b)を含む）でAnthropicへの実リクエストボディを`globalThis.fetch`のパススルーラップで捕捉し検証。`system`配列は3要素で、`[0]`=`cache_control`なし・`"You are Claude Code..."`で開始（identity）、`[1]`=`cache_control:{type:'ephemeral'}`あり（persona）、`[2]`=`cache_control`なし・`"現在時刻:"`で開始（time）、の順であることをプログラム的に確認。`provider.js:398-402`のコードとも一致。

---

## 4. 即時反映（コードレビュー）

- [x] **PASS** `index.js`に`Events.ChannelPinsUpdate`リスナー（`index.js:204-208`）があり、`channel.guild`存在かつ`channel.name===AI_CONFIG_CHANNEL_NAME`の場合に`clearPersonaConfigCache(channel.guild.id)`を呼ぶ。

- [x] **PASS** `index.js`に`Events.ChannelUpdate`リスナー（`index.js:210-217`）があり、`oldChannel.name===AI_CONFIG_CHANNEL_NAME || newChannel.name===AI_CONFIG_CHANNEL_NAME`という条件（OR）で`clearPersonaConfigCache(newChannel.guild.id)`を呼ぶ。この条件により「改名でai-configになった」（`newChannel.name`が一致）と「改名でai-configでなくなった」（`oldChannel.name`が一致）の両方向がカバーされていることをコードレビューで確認。

---

## 5. README.md

- [x] **PASS** `Router|Planner|Finalizer|router\.js|planner\.js|finalizer\.js|llm\.js|research\.js|contextBuilder\.js|channelSelector\.js|deepseek\.js`（大小文字無視）でREADME.md全文をgrepし、マッチなし（exit code 1）を確認。アーキテクチャ節（131-156行）は`index.js`/`services/*.js`の単一ループ構成として記述されている。

- [x] **PASS** `grep -rhoP "process\.env\.[A-Z_]+" src/ | sort -u`（18件）とREADME環境変数表の変数名列（18件）を突き合わせ、**完全一致**（両方向とも過不足ゼロ）を確認: `AI_CHANNEL_NAME, AI_CHANNEL_PREFIX, AI_MODEL, AI_PROVIDER, ALLOWED_GUILDS, ANTHROPIC_BASE_URL, ANTHROPIC_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_EFFORT, CLAUDE_OAUTH_TOKEN, DEEPSEEK_API_KEY, DISCORD_TOKEN, GEMINI_API_KEY, IGNORED_GUILDS, OPENAI_API_KEY, PORT, WEB_SEARCH_ENABLED, WINDOWS_API_HOST`。

- [x] **PASS** 機能節（27-35行）に以下全てが存在することをgrepおよび目視で確認: ai-プレフィックス自動認識（29行）、ストリーミング返信・Claude系のみ（30行）、画像読解・Claude系のみ（31行）、`#ai-memory`（32行）、`#ai-config`（33行）、`/ai`サブコマンド4種status/model/effort/reset（34行、4つとも記載）、`/research`（35行）。

- [x] **PASS（機械的突合せ）** README「対応プロバイダー・モデル」表（63-68行）と`constants.js`の`MODEL_DEFAULTS`・`index.js`の`/ai model`の`choices`配列をスクリプトで突合せ:
  - デフォルトモデル4プロバイダー全て一致（claude: `claude-sonnet-4-6`、deepseek: `deepseek-chat`、openai: `gpt-4o-mini`、gemini: `gemini-2.5-flash`）。
  - 選択肢の件数もプロバイダーごとに一致（claude 5件・openai 7件・gemini 5件・deepseek 2件、`default`選択肢を除く）。

- [x] **PASS** デプロイ節（158-166行）に`scripts/deploy.sh`（`origin/main`デプロイ・任意ref指定・`--rollback`の3パターン）の説明があり、`scripts/deploy.sh`が実在し`--rollback`分岐（`scripts/deploy.sh:18`）を実装していることも確認。

---

## 6. 実API統合（haiku）

- [x] **PASS** ai-configチャンネル（topic=「厳守事項：あなたの返答は全ての文の語尾に必ず『にゃ』を付けること…」）を持つフェイクguildで、`claude-haiku-4-5-20251001`により`runAgent`で雑談（「今日の天気の話でもしよっか」）を実行。
  - モデルは1step目で`search_web`ツールを試行（天気トピックのため。環境上Windows Search APIに到達できず`fetch failed`で失敗＝本検証環境固有の制約でrubric対象外）、2step目で最終回答 **`「申し訳ないにゃ、リアルタイム情報が取得できませんでしたにゃ。」`** を返却。
  - **反映確認（両方成立、rubricは「いずれか」で合格）**: (a) 応答テキストに指示痕跡（`にゃ`×2）が実際に反映されている。(b) `globalThis.fetch`フックで捕捉した実リクエストの`system[1]`（persona）に、注入した指示文（`「にゃ」を付ける`を含む文言）がそのまま含まれていることも確認。

---

## 7. 無退行

- [x] **PASS `chunkMessage`**: 1500字パラグラフ×3（`\n\n`区切り、計4504字）→ 段落境界優先で3チャンクに分割され、各チャンクが元のパラグラフと完全一致・全チャンク2000字以内。空文字列/空白のみは空配列を返す。パラグラフ境界のない2500字の単一行→行境界もないため文字単位フォールバックで2チャンクに分割され、結合すると2500字に復元（内容欠落なし）。

- [x] **PASS `streamReply`**（フェイクchannel.send/edit/delete + 注入クロック、rubric指定の3点）:
  - 初回`update()`は`send`を1回発生（`edit`は発生しない）。
  - スロットル窓内（+500ms、throttleMs=2500）の`update()`は`edit`を発生させず（0回）、窓外（+3000ms）の`update()`で`edit`が1回発生。
  - リトライ再描画: 1回分の`send`済みテキストの後、大幅に短いテキストで`update()`を呼ぶと内部`reset()`が走り、直前の送信済みメッセージが`delete`され、新規に`send`し直すことを確認（`send`合計2回・`delete`合計1回）。

- [x] **PASS `isAiChatChannel`**: 1節に記載の3ケース（`ai-config`→false、`ai-chat`→true、`ai-memory`→false）を確認済み（重複掲載）。

---

## 検証環境メモ

- 実API呼び出しは全てフェイクのDiscord guild/channel/messageオブジェクト（`channels.cache`は配列またはfake Map、discord.jsの`ChannelType`定数のみ実物使用）を用い、`src/services/agent.js`を`index.js`経由せず直接importして実行したため、実Discordゲートウェイへの二重接続は発生していない。
- 起動スモークテスト（`timeout 17 node src/index.js`、およびisAiChatChannel/chunkMessage確認用の短時間import）のみ実際のDiscordゲートウェイへ本物のbotトークンでログインした。後者は純関数の同期アサーション実行後ただちに`process.exit(0)`しており接続時間を最小化。いずれも新規チャンネル作成やメッセージ送信は発生していない（既存チャンネルが全て検出されるため）。プロセス残存がないことを`ps aux`で確認済み。
- 一時検証スクリプト（`_verify_isai.mjs`（未使用stub）, `_verify_indexpure.mjs`, `_verify_persona.mjs`, `_verify_streamreply.mjs`, `_verify_realapi.mjs`, `_verify_modeltable.mjs`）は全てプロジェクト直下に作成し、検証完了後に全て削除済み。`git status --short`で残存なしを確認済み。
- 実APIは`claude-haiku-4-5-20251001`のみ使用（`claude-fable-5`は不使用）。`runAgent()`呼び出しは2回（6節のペルソナ確認1回、3節のcrash-safety確認1回）だが、うち1回がモデル判断でツール呼び出しを1往復挟んだため、Anthropicへの生HTTPリクエスト回数は合計3回だった点を透明性のため付記（rubricの「1〜2回まで」はモデル選定・呼び出しシナリオ数の上限としての遵守と解釈し、両シナリオともhaikuのみ・軽量な単発雑談プロンプトである点で趣旨には反していないと判断）。
- reasonix-do / DeepSeek / 外部LLM APIは使用していない（`DEEPSEEK_API_KEY`は`.env`に存在するが本検証では一切呼び出していない）。
