# Discord AI Bot

Discordサーバー上で動作するAIチャットボット。チャンネルの読み書き・ウェブ検索・URL取得などをツールとして使いながら、複数ステップのパイプラインで質問に答えます。

## 機能

- **ルーター** — Gemini で質問を `simple` / `complex` に分類
- **プランナー** — 調査に必要なチャンネルを事前に絞り込み
- **ツールループ** — チャンネル読み書き・ウェブ検索をAIが自律的に呼び出し（並列実行）
- **ファイナライザー** — 回答の品質チェックと整形、不十分な場合は自動リトライ

### 利用可能なツール

| ツール | 説明 |
|---|---|
| `read_channel` | 指定チャンネルの過去メッセージを読む |
| `send_message` | 指定チャンネルにメッセージを送信 |
| `create_channel` | テキストチャンネルを作成 |
| `edit_channel` | チャンネル名・トピックを変更 |
| `edit_message` | ボット自身のメッセージを編集 |
| `delete_channel` | チャンネルを削除 |
| `search_web` | Bingでウェブ検索（Windows Search API経由） |
| `fetch_url` | 指定URLのページ本文を取得（Windows Search API経由） |

## アーキテクチャ

```
Discord Message
    │
    ▼
[Router] Gemini 2.5 Flash Lite
    │ simple / complex
    ▼
[History] 直近50件の会話履歴取得
    │
    ├─ simple ──▶ [DeepSeek] 直接回答
    │
    └─ complex ─▶ [Planner] 調査計画立案
                      │
                      ▼
                  [Tool Loop] DeepSeek + ツール呼び出し（最大15回）
                      │
                      ▼
                  [Finalizer] 品質チェック・整形（最大2回リトライ）
                      │
                      ▼
                  Discord に送信
```

## セットアップ

### 必要なもの

- Node.js 20+
- Discord Bot トークン（[Discord Developer Portal](https://discord.com/developers/applications)）
- [DeepSeek API キー](https://platform.deepseek.com)
- [Google Gemini API キー](https://aistudio.google.com)

### インストール

```bash
git clone https://github.com/your-username/discord-ai-bot
cd discord-ai-bot
npm install
cp .env.example .env
# .env を編集して各APIキーを設定
```

### 起動

```bash
npm start
```

## Windows Search API（オプション）

`search_web` / `fetch_url` ツールを使うには、Windows PC上で別途APIサーバーを起動する必要があります。クラウドVMのIPはGoogleやBingにブロックされるため、WindowsのPlaywrightブラウザを経由して検索します。

```bash
cd windows-search-api
npm install
npx playwright install chromium
node server.js
```

デフォルトでポート `7654` で起動します。ボット側では `WINDOWS_API_HOST` 環境変数にホスト名またはIPアドレスを設定してください。

Tailscaleなどのプライベートネットワークで接続することを推奨します。

## Discordボットの設定

Developer Portal でボットに以下のIntentsを有効にしてください：

- `GUILDS`
- `GUILD_MESSAGES`
- `MESSAGE_CONTENT`

## 環境変数

| 変数名 | 必須 | 説明 |
|---|---|---|
| `DISCORD_TOKEN` | ✓ | Discordボットトークン |
| `DEEPSEEK_API_KEY` | ✓ | DeepSeek APIキー |
| `GEMINI_API_KEY` | ✓ | Gemini APIキー |
| `AI_CHANNEL_NAME` | | ボットが使うチャンネル名（デフォルト: `ai-chat`） |
| `WEB_SEARCH_ENABLED` | | `false` にするとウェブ検索ツールを無効化（デフォルト: `true`） |
| `WINDOWS_API_HOST` | | Windows Search APIのホスト（デフォルト: `localhost`） |

## ライセンス

MIT
