# Phase 3: ペルソナカスタマイズ（#ai-config） + README全面改訂

前提: v2単一ループ + ストリーミング + #ai-memory はmainにマージ・本番稼働済み。作業ブランチ: `feat/persona-config-readme`（mainから分岐済み。コミットは親が行うので不要）。

## 機能A: #ai-config によるギルド別ペルソナカスタマイズ

### 設計
チャンネル名が正確に `ai-config` のテキストチャンネルがあるギルドでは、その**トピック**と**ピン留めメッセージ**をsystemプロンプトのpersonaに注入する。トピック変更は「チャンネルの管理」、ピン留めは「メッセージの管理」権限が要るため、実質サーバー管理側だけがペルソナを制御できる（通常メッセージは注入しない）。

### A-1. チャンネル特例（src/index.js）
- `isAiChatChannel` の除外に `ai-config` を追加（`ai-memory` と同様、AIチャット自動登録の対象外）。除外名はSetか配列の定数にまとめる。

### A-2. 設定の取得とキャッシュ（src/services/personaConfig.js 新規）
- `getPersonaConfig(guild)` (async) をexport:
  - ギルドから名前が正確に `ai-config` のテキストチャンネルを探す。なければ `null`。
  - トピック + ピン留めメッセージ（`channel.messages.fetchPinned()`、createdTimestamp昇順、各メッセージの `content`）を結合したテキストを返す。形式: トピックが先、次にピン留め各件。
  - 合計 **4000字で切り詰め**（超過分は捨てて末尾に `…(省略)` を付ける）。
  - 空（トピックなし・ピンなし）なら `null`。
- **インメモリキャッシュ**: guild.idキー、TTL 5分。ピン取得はAPIコールなので毎メッセージ叩かない。
- `clearPersonaConfigCache(guildId)` もexport。
- fetchPinned が例外を投げたら（権限不足等）キャッシュにnullを入れてログ1行、落ちないこと。

### A-3. 即時反映（src/index.js）
- `Events.ChannelPinsUpdate` と `Events.ChannelUpdate` で、対象チャンネル名が `ai-config`（ChannelUpdateは新旧どちらかの名前が該当）なら `clearPersonaConfigCache(guild.id)` を呼ぶ（TTLを待たず即反映）。

### A-4. プロンプト注入（src/services/prompt.js + agent.js）
- `buildSystemPrompt(guild, aiChannelIds, { mode, custom })` に `custom` を追加。`custom` が非空なら、personaの末尾（researchモード追記より前）に以下を追加:
  ```
  ## サーバー独自設定（#ai-config より・サーバー管理者が設定）
  以下はこのサーバーの管理者による指示。上の一般原則と矛盾する場合はこちらを優先する:
  <custom>
  ```
- `agent.js` の `runAgent` 冒頭で `const custom = await getPersonaConfig(guild)` を取り、buildSystemPromptに渡す。guildがnull/フェイクで `channels.cache` が無い場合も落ちないこと。
- 注意: personaはプロンプトキャッシュ（cache_control）対象。customはTTLキャッシュで安定文字列になるためキャッシュ効率は保たれる。**cache_controlの配置や時刻ブロックの位置は変更禁止。**
- 地図上で `ai-config` チャンネルには `(ペルソナ設定)` の注記を付ける（ai-memoryの注記と同様の方式）。

## 機能B: README.md 全面改訂

現行READMEはv1（Router/Planner/Finalizer時代）の内容で古い。v2の実態に合わせて全面的に書き直す（日本語）:
- **概要**: 単一ループエージェント（1つのsystemプロンプト + モデル自身のツール判断）である旨と特徴
- **機能一覧**: AIチャットチャンネル（ai-プレフィックス自動認識）、ストリーミング返信（Claude系）、画像読解（Claude系）、#ai-memory 長期記憶、#ai-config ペルソナカスタマイズ、/ai コマンド（status/model/effort/reset）、/research
- **対応プロバイダー/モデル**: Claude（Max OAuth: fable-5 / opus-4-8 / sonnet-5 / sonnet-4-6 / haiku-4-5）、Gemini、OpenAI、DeepSeek
- **セットアップ**: 必要な環境変数の表（src/ 内の `process.env.*` 参照と完全一致させること。DISCORD_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, GEMINI_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, AI_PROVIDER, AI_MODEL, CLAUDE_EFFORT, AI_CHANNEL_NAME, ALLOWED_GUILDS/IGNORED_GUILDS 等、実際にコードにあるものを漏れなく）
- **アーキテクチャ**: src/ 構成（index.js / agent.js / prompt.js / provider.js / tools.js / streamReply.js / personaConfig.js / historyBuilder.js / settings.js / constants.js / attachments.js）の1行説明
- **デプロイ**: `bash scripts/deploy.sh`（origin/main）、`--rollback`、ブランチ指定。VM上の .env / settings.json はuntrackedで保持される旨
- **旧アーキテクチャへの言及（router/planner/finalizer/契約書的な古い説明）を一切残さない**

## 機能C: package.json のバージョンを 0.4.0 に上げる（v2化の区切り）

## 禁止事項
- cache_control配置・thinkingのverbatim保存・claudeFetch挙動・streamReply動作の変更禁止
- Gemini/OpenAI/DeepSeekセッションの動作変更禁止
- git commit / push / デプロイ禁止（親がやる）
- 勝手な仕様変更・大規模リファクタ・関係ない変更・長文ログ貼り付け禁止
- reasonix-do / 外部LLM APIの新規利用禁止

## 検証（実装者セルフチェック。盲検verifierは別途走る）
- 全srcファイル `node --check`
- personaConfig のユニット（フェイクguild/channel/fetchPinned + 注入クロックまたはTTL検証: 2回目の呼び出しでfetchPinnedが再実行されないこと、clearでキャッシュが飛ぶこと、4000字切り詰め、ai-configなし→null、fetchPinned例外→null＋非クラッシュ）
- buildSystemPrompt のユニット（custom有→セクション出現と優先文言、custom無→出現しない、地図注記）
- isAiChatChannel('ai-config') → false
- 実APIは**haiku 1回**の統合確認のみ（ai-configありフェイクguildでrunAgentが落ちず応答が返る）。fable-5使用禁止
- READMEの環境変数表と `grep -rn "process.env" src/` の突き合わせ
- 15秒起動スモーク（Ready確認）
- 一時テストスクリプトはプロジェクト直下に作り、終了後削除
