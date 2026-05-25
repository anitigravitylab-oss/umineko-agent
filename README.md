# Discord AI Bot

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/anitigravitylab-oss/umineko-agent)

[日本語](#discord-ai-bot-ja) | [English](#discord-ai-bot-en)

---

<a name="discord-ai-bot-ja"></a>
## 日本語

Discordサーバー上で動作するAIチャットボット。チャンネルの読み書き・ウェブ検索・URL取得などをツールとして使いながら、複数ステップのパイプラインで質問に答えます。

### Discordをナレッジベースとして使う

このボットの核心的なコンセプトは、**Discordのチャンネル群をそのままAIの記憶・データベースとして使う**ことです。

ボットはチャンネルのメッセージをコンテキストとして読み込むため、チャンネルに書き込まれた情報はすべてボットの知識になります。逆にボットはチャンネルへの書き込みや作成もできるため、情報の収集・整理・更新をAIに任せることができます。

**活用例:**

- **タスク管理** — `#tasks` チャンネルにタスクをメモしておけば、「今週のタスクを教えて」「これ完了したから更新して」と自然言語で管理できる
- **議事録・メモの蓄積** — 各チャンネルに情報を書き溜めておくと、「先週の議論をまとめて」「〇〇の件はどうなった？」といった横断的な質問にも答えられる
- **プロジェクト管理** — プロジェクトごとにチャンネルを分け、進捗や決定事項を記録しておけば、ボットが現状把握・サマリー生成・関連チャンネルへの情報転記を自動で行う
- **自動整理** — 「このチャンネルの内容を読んで、トピックごとに新しいチャンネルに整理して」と依頼すれば、チャンネルの作成・メッセージの転記まで実行できる
- **チーム内検索** — 「〇〇について過去に話した内容を教えて」と聞くだけで、関連するチャンネルを横断的に調べて回答してくれる

Notionやスプレッドシートのような専用ツールを使わなくても、**Discordの会話そのものが構造化された情報になる**のが最大の利点です。

### 機能

- **ルーター** — Gemini で質問を `simple` / `complex` に分類
- **プランナー** — 調査に必要なチャンネルを事前に絞り込み
- **ツールループ** — チャンネル読み書き・ウェブ検索をAIが自律的に呼び出し（並列実行）
- **ファイナライザー** — 回答の品質チェックと整形、不十分な場合は自動リトライ

#### 利用可能なツール

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

### アーキテクチャ

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

### セットアップ

**必要なもの**

- Node.js 20+
- Discord Bot トークン（[Discord Developer Portal](https://discord.com/developers/applications)）
- [DeepSeek API キー](https://platform.deepseek.com)
- [Google Gemini API キー](https://aistudio.google.com)

**インストール**

```bash
git clone https://github.com/your-username/umineko-agent
cd umineko-agent
npm install
cp .env.example .env
# .env を編集して各APIキーを設定
```

```bash
npm start
```

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

Developer Portal でボットに以下のIntentsを有効にしてください：`GUILDS` / `GUILD_MESSAGES` / `MESSAGE_CONTENT`

### 環境変数

| 変数名 | 必須 | 説明 |
|---|---|---|
| `DISCORD_TOKEN` | ✓ | Discordボットトークン |
| `DEEPSEEK_API_KEY` | ✓ | DeepSeek APIキー |
| `GEMINI_API_KEY` | ✓ | Gemini APIキー |
| `AI_CHANNEL_NAME` | | ボットが使うチャンネル名（デフォルト: `ai-chat`） |
| `WEB_SEARCH_ENABLED` | | `false` にするとウェブ検索ツールを無効化（デフォルト: `true`） |
| `WINDOWS_API_HOST` | | Windows Search APIのホスト（デフォルト: `localhost`） |

---

<a name="discord-ai-bot-en"></a>
## English

An AI chatbot for Discord servers. It answers questions through a multi-step pipeline, autonomously calling tools for channel read/write, web search, and URL fetching.

### Discord as a Knowledge Base

The core idea behind this bot is simple: **use Discord channels themselves as the AI's memory and database.**

Because the bot reads channel messages as context, anything written in a channel becomes part of the bot's knowledge. And because the bot can also write to and create channels, you can delegate information gathering, organization, and updates entirely to the AI.

**What you can do:**

- **Task management** — Keep tasks in a `#tasks` channel and manage them with natural language: "What are this week's tasks?" or "Mark that one as done."
- **Notes and meeting logs** — Accumulate notes across channels over time. The bot can answer cross-channel questions like "Summarize last week's discussion" or "What was decided about X?"
- **Project tracking** — Split channels by project and log progress and decisions. The bot can assess current status, generate summaries, and copy relevant info between channels automatically.
- **Auto-organization** — Ask "Read this channel and reorganize the content into new channels by topic" — the bot will create channels and move information on its own.
- **Team search** — Just ask "What did we say about X in the past?" and the bot searches across all relevant channels to find the answer.

The biggest advantage: **your Discord conversations become structured, queryable information** — no need for a separate wiki, Notion, or spreadsheet.

### Features

- **Router** — Classifies each message as `simple` or `complex` using Gemini
- **Planner** — Decides which channels to read before starting a complex task
- **Tool Loop** — AI autonomously calls tools in parallel (up to 15 iterations)
- **Finalizer** — Quality-checks and cleans up the response, with automatic retry if insufficient

#### Available Tools

| Tool | Description |
|---|---|
| `read_channel` | Read recent messages from a channel |
| `send_message` | Send a message to a channel |
| `create_channel` | Create a new text channel |
| `edit_channel` | Rename a channel or change its topic |
| `edit_message` | Edit one of the bot's own messages |
| `delete_channel` | Delete a channel |
| `search_web` | Search Bing via the Windows Search API |
| `fetch_url` | Fetch the text content of a URL via the Windows Search API |

### Architecture

```
Discord Message
    │
    ▼
[Router] Gemini 2.5 Flash Lite
    │ simple / complex
    ▼
[History] Fetch last 50 messages
    │
    ├─ simple ──▶ [DeepSeek] Direct answer
    │
    └─ complex ─▶ [Planner] Build investigation plan
                      │
                      ▼
                  [Tool Loop] DeepSeek + tool calls (up to 15 iterations)
                      │
                      ▼
                  [Finalizer] Quality check + cleanup (up to 2 retries)
                      │
                      ▼
                  Send to Discord
```

### Setup

**Requirements**

- Node.js 20+
- Discord Bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- [DeepSeek API key](https://platform.deepseek.com)
- [Google Gemini API key](https://aistudio.google.com)

**Install**

```bash
git clone https://github.com/your-username/umineko-agent
cd umineko-agent
npm install
cp .env.example .env
# Fill in your API keys in .env
```

```bash
npm start
```

### Windows Search API (optional)

The `search_web` and `fetch_url` tools require a separate API server running on a Windows PC. Cloud VM IPs are blocked by search engines, so searches are routed through a real Playwright browser on Windows instead.

```bash
cd windows-search-api
npm install
npx playwright install chromium
node server.js
```

The server listens on port `7654` by default. Set `WINDOWS_API_HOST` in your bot's `.env` to the Windows PC's hostname or IP address. Connecting over a private network such as [Tailscale](https://tailscale.com) is recommended.

### Discord Bot Configuration

Enable the following Gateway Intents in the Developer Portal: `GUILDS` / `GUILD_MESSAGES` / `MESSAGE_CONTENT`

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✓ | Discord bot token |
| `DEEPSEEK_API_KEY` | ✓ | DeepSeek API key |
| `GEMINI_API_KEY` | ✓ | Gemini API key |
| `AI_CHANNEL_NAME` | | Channel the bot listens in (default: `ai-chat`) |
| `WEB_SEARCH_ENABLED` | | Set to `false` to disable web search tools (default: `true`) |
| `WINDOWS_API_HOST` | | Host of the Windows Search API (default: `localhost`) |

---

## License

MIT

## Contributing

Pull requests are welcome. For major changes, please open an issue first to discuss what you would like to change.
