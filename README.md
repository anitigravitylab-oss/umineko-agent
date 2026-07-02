# Discord AI Bot (umineko)

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/anitigravitylab-oss/umineko-agent)

Discordサーバーに常駐するAIエージェント「umineko」。チャンネルの読み書き・ウェブ検索・URL取得などをツールとして自律的に使いながら、単一のsystemプロンプト＋ツールループでユーザーの質問に答えます。

## Discordをナレッジベースとして使う

このボットの核心的なコンセプトは、**Discordのチャンネル群をそのままAIの記憶・データベースとして使う**ことです。

ボットはチャンネルのメッセージをコンテキストとして読み込むため、チャンネルに書き込まれた情報はすべてボットの知識になります。逆にボットはチャンネルへの書き込みや作成もできるため、情報の収集・整理・更新をAIに任せることができます。

**活用例:**

- **タスク管理** — `#tasks` チャンネルにタスクをメモしておけば、「今週のタスクを教えて」「これ完了したから更新して」と自然言語で管理できる
- **議事録・メモの蓄積** — 各チャンネルに情報を書き溜めておくと、「先週の議論をまとめて」「〇〇の件はどうなった？」といった横断的な質問にも答えられる
- **プロジェクト管理** — プロジェクトごとにチャンネルを分け、進捗や決定事項を記録しておけば、ボットが現状把握・サマリー生成・関連チャンネルへの情報転記を自動で行う
- **自動整理** — 「このチャンネルの内容を読んで、トピックごとに新しいチャンネルに整理して」と依頼すれば、チャンネルの作成・メッセージの転記まで実行できる
- **チーム内検索** — 「〇〇について過去に話した内容を教えて」と聞くだけで、関連するチャンネルを横断的に調べて回答してくれる

Notionやスプレッドシートのような専用ツールを使わなくても、**Discordの会話そのものが構造化された情報になる**のが最大の利点です。

## 概要

複数の専用ステージを順に経由する多段パイプライン構成ではなく、**単一のsystemプロンプトとモデル自身のツール判断による1本のループ**（`runAgent`）で動作します。モデルが「関連チャンネルを読むべきか」「ツールを呼ぶべきか」「もう回答してよいか」を自律的に判断し、最大15回（`/research` は25回）のツール実行ループの末に回答を返します。

## 機能

- **AIチャットチャンネル自動認識** — `ai-` で始まる名前のチャンネル（プレフィックスは `AI_CHANNEL_PREFIX` で変更可）を自動的にAI応答チャンネルとして登録する。起動時の全ギルドスキャン・サーバー参加時・チャンネル作成時にスキャンする
- **ストリーミング返信（Claude系のみ）** — Claudeプロバイダー使用時、生成中の回答をリアルタイムでDiscordメッセージへ逐次反映する（2.5秒スロットルで編集、1900字を超えたら段落境界優先で自動的に複数メッセージへ分割）
- **画像読解（Claude系のみ）** — ユーザーの添付画像やツール結果内の画像を自前でfetchしてbase64化し、Claudeに渡して読解させる
- **`#ai-memory`（長期記憶）** — ボットがサーバー固有の事実（人物・好み・決定事項）を自律的に読み書きする専用チャンネル。このチャンネル自体はAI応答チャンネルとして登録されず、通常の会話には反応しない
- **`#ai-config`（ペルソナカスタマイズ）** — このチャンネルのトピックとピン留めメッセージを、サーバー管理者によるペルソナ上書き設定としてsystemプロンプトに注入する。トピック変更には「チャンネルの管理」、ピン留めには「メッセージの管理」権限が要るため、実質サーバー管理側だけが制御できる。変更は5分キャッシュだがピン/トピック変更時は即時反映される
- **`/ai` コマンド（管理者のみ）** — `status`（現在のプロバイダー・モデル・effort設定を表示）/ `model`（プロバイダー・モデルを変更。モデル名から自動でプロバイダーも切替）/ `effort`（Claude使用時の思考の深さを変更）/ `reset`（すべてを環境変数のデフォルトに戻す）の4サブコマンド
- **`/research`** — `search_web` / `fetch_url` を駆使した深掘りリサーチを実行し、引用元付きレポートを生成する（最大25回のツールループ、進捗をステータスメッセージで逐次表示）

### 利用可能なツール

| ツール | 説明 | 実行制限 |
|---|---|---|
| `read_channel` | 指定チャンネルの最近のメッセージ履歴を読む | - |
| `send_message` | 指定チャンネルにメッセージを送信 | - |
| `create_channel` | テキストチャンネルを作成 | 管理者のみ |
| `edit_channel` | チャンネルの名前・トピック・カテゴリを変更 | 管理者のみ |
| `create_category` | カテゴリを作成 | 管理者のみ |
| `edit_category` | カテゴリ名を変更 | 管理者のみ |
| `delete_category` | カテゴリを削除（中のチャンネルはカテゴリなしになる） | - |
| `edit_message` | ボット自身のメッセージを編集 | - |
| `delete_message` | メッセージを削除 | ボット自身のメッセージのみ（主に`#ai-memory`の記憶更新用） |
| `delete_channel` | チャンネルを削除 | - |
| `fetch_message` | メッセージリンクから内容を取得 | - |
| `list_members` | サーバーメンバー一覧を取得（メンション用ID付き） | - |
| `find_member` | 名前でメンバーを検索し、メンション文字列を取得 | - |
| `search_web` | Bingでウェブ検索（Windows Search API経由。`WEB_SEARCH_ENABLED=false`で無効化可） | - |
| `fetch_url` | 指定URLのページ本文テキストを取得（Windows Search API経由） | - |

「変更系ツール（送信・作成・編集・削除）はユーザーが明示的に依頼したときだけ使う」のがpersonaの行動原則。例外は `#ai-memory` への `send_message` と自分のメッセージの `delete_message` で、記憶の自律的な保存・更新にのみ明示依頼なしで使ってよい。

## 対応プロバイダー・モデル

`AI_PROVIDER` で選ぶメインプロバイダーと、`/ai model` でギルドごとに上書きできるモデル一覧。

| プロバイダー | デフォルトモデル | 選択可能なモデル（`/ai model`） |
|---|---|---|
| `claude`（Max OAuth） | `claude-sonnet-4-6` | Fable 5 / Opus 4.8 / Sonnet 5 / Sonnet 4.6 / Haiku 4.5 |
| `deepseek`（デフォルト） | `deepseek-chat` | v4-pro / v4-flash |
| `openai` | `gpt-4o-mini` | gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.4-nano / gpt-5-mini / gpt-4o / gpt-4o-mini |
| `gemini` | `gemini-2.5-flash` | 3.1-pro-preview / 3.5-flash / 3-flash-preview / 2.5-flash / 2.5-flash-lite |

Claudeは通常のAPIキーではなく、**Claude Maxサブスクリプションのoauthトークン**（Claude Code CLIのログインで取得）で呼び出す。ストリーミング返信・画像読解・プロンプトキャッシュ・`effort`（思考の深さ）はClaude利用時のみ有効。

## セットアップ

**必要なもの**

- Node.js 20+
- Discordボットトークン（[Discord Developer Portal](https://discord.com/developers/applications)）
- 使用するプロバイダーのAPIキー・トークン（下記環境変数を参照）

**インストール**

```bash
git clone https://github.com/anitigravitylab-oss/umineko-agent
cd umineko-agent
npm install
cp .env.example .env
# .env を編集して各種トークン・APIキーを設定
npm start
```

### 環境変数

| 変数名 | 必須 | デフォルト | 説明 |
|---|---|---|---|
| `DISCORD_TOKEN` | ✓ | - | Discordボットトークン |
| `AI_PROVIDER` | | `deepseek` | メインAIプロバイダー: `deepseek` / `openai` / `gemini` / `claude`（`/ai model`でギルドごとに上書き可） |
| `AI_MODEL` | | プロバイダーごとのデフォルト | 使用モデルの上書き（`/ai model`で選ぶとプロバイダーも自動切替） |
| `CLAUDE_EFFORT` | | `max` | Claude使用時の思考の深さ: `low` / `medium` / `high` / `max`（Haikuモデルでは無視される） |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude利用時 ✓ | - | Claude MaxサブスクリプションのOAuthトークン（`sk-ant-oat01-...`）。Claude Code CLIのログインから取得 |
| `CLAUDE_OAUTH_TOKEN` | | - | `CLAUDE_CODE_OAUTH_TOKEN` の代替名（フォールバック） |
| `ANTHROPIC_OAUTH_TOKEN` | | - | `CLAUDE_CODE_OAUTH_TOKEN` の代替名（フォールバック） |
| `ANTHROPIC_BASE_URL` | | `https://api.anthropic.com` | Anthropic APIのベースURL上書き |
| `GEMINI_API_KEY` | Gemini利用時 ✓ | - | Google Gemini APIキー |
| `OPENAI_API_KEY` | OpenAI利用時 ✓ | - | OpenAI APIキー |
| `DEEPSEEK_API_KEY` | DeepSeek利用時 ✓ | - | DeepSeek APIキー |
| `AI_CHANNEL_NAME` | | `ai-chat` | 起動時にギルドへ自動作成されるデフォルトAIチャンネル名 |
| `AI_CHANNEL_PREFIX` | | `ai-` | このプレフィックスで始まるチャンネルを自動でAIチャットチャンネルとして登録する（`ai-memory` / `ai-config` は特例で対象外） |
| `ALLOWED_GUILDS` | | 全ギルド | カンマ区切りのギルドIDホワイトリスト。指定時はこれ以外のギルドを無視 |
| `IGNORED_GUILDS` | | なし | カンマ区切りのギルドID無視リスト |
| `WEB_SEARCH_ENABLED` | | `true` | `false` にすると `search_web` / `fetch_url` ツールを無効化 |
| `WINDOWS_API_HOST` | | `localhost` | Windows Search APIのホスト名／IPアドレス |
| `PORT` | | `8080` | ヘルスチェック用HTTPサーバーのポート |

### Windows Search API（オプション）

`search_web` / `fetch_url` ツールを使うには、Windows PC上で別途APIサーバーを起動する必要があります。クラウドVMのIPはGoogleやBingにブロックされるため、WindowsのPlaywrightブラウザを経由して検索します。

```bash
cd windows-search-api
npm install
npx playwright install chromium
node server.js
```

デフォルトでポート `7654` で起動します。ボット側では `WINDOWS_API_HOST` 環境変数にホスト名またはIPアドレスを設定してください。[Tailscale](https://tailscale.com) などのプライベートネットワークで接続することを推奨します。

### Discordボットの設定

Developer Portal でボットに以下のGateway Intentsを有効にしてください: `GUILDS / GUILD_MESSAGES / MESSAGE_CONTENT / GUILD_MEMBERS`

## アーキテクチャ

```
src/
├── index.js               Discordクライアント起動、イベントハンドラ（メッセージ受信・
│                           スラッシュコマンド・チャンネル増減・ピン/トピック変更）、
│                           メッセージ分割送信
└── services/
    ├── agent.js            単一ループエージェント本体（runAgent）。systemプロンプト
    │                       構築 → モデル呼び出し → ツール実行 → 結果を戻す、を反復
    ├── prompt.js           systemプロンプト（persona＋time）の組み立て。サーバーの
    │                       チャンネル地図・長期記憶／ペルソナ設定セクションの注入
    ├── provider.js         プロバイダー別セッション（Claude/Gemini/OpenAI互換）。
    │                       Claudeのストリーミング(SSE)・プロンプトキャッシュ・
    │                       画像base64変換・リトライを担当
    ├── tools.js            Discord操作・ウェブ検索ツールの定義と実行
    ├── streamReply.js      Claudeストリーミング応答をDiscordメッセージへ逐次反映
    │                       （スロットル・1900字分割・リトライ再描画）
    ├── personaConfig.js    #ai-config チャンネルのトピック/ピン留めからサーバー
    │                       独自ペルソナ設定を取得しTTLキャッシュ（5分）
    ├── historyBuilder.js   チャンネル履歴をAI用のuser/assistantメッセージ配列に変換
    ├── settings.js         ギルドごとのプロバイダー/モデル/effort設定の永続化
    │                       （settings.json）
    ├── constants.js        モデルデフォルト・プロバイダー一覧・effortレベルの定数
    └── attachments.js      メッセージ添付ファイルから画像URLを抽出
```

## デプロイ

本番はGCE VM上でpm2稼働しており、`scripts/deploy.sh` でgitベースにデプロイします。VM上の `/opt/discord-bot` はこのリポジトリのgit clone。`.env` と `settings.json` はgit管理外のため、デプロイのたびに上書きされず保持されます。

```bash
bash scripts/deploy.sh              # origin/main をデプロイ
bash scripts/deploy.sh origin/foo   # 任意のref（動作確認用ブランチ等）を明示的に指定してデプロイ
bash scripts/deploy.sh --rollback   # 直前のデプロイ（deploy-prevタグ）にロールバック
```

---

## License

MIT
