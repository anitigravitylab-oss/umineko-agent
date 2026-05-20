# Discord AI Bot

An AI chatbot for Discord servers. It answers questions through a multi-step pipeline, autonomously calling tools for channel read/write, web search, and URL fetching.

## Features

- **Router** — Classifies each message as `simple` or `complex` using Gemini
- **Planner** — Decides which channels to read before starting a complex task
- **Tool Loop** — AI autonomously calls tools in parallel (up to 15 iterations)
- **Finalizer** — Quality-checks and cleans up the response, with automatic retry if insufficient

### Available Tools

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

## Architecture

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

## Setup

### Requirements

- Node.js 20+
- Discord Bot token ([Discord Developer Portal](https://discord.com/developers/applications))
- [DeepSeek API key](https://platform.deepseek.com)
- [Google Gemini API key](https://aistudio.google.com)

### Install

```bash
git clone https://github.com/your-username/umineko-agent
cd umineko-agent
npm install
cp .env.example .env
# Fill in your API keys in .env
```

### Run

```bash
npm start
```

## Windows Search API (optional)

The `search_web` and `fetch_url` tools require a separate API server running on a Windows PC. Cloud VM IPs are blocked by search engines, so searches are routed through a real Playwright browser on Windows instead.

```bash
cd windows-search-api
npm install
npx playwright install chromium
node server.js
```

The server listens on port `7654` by default. Set `WINDOWS_API_HOST` in your bot's `.env` to the Windows PC's hostname or IP address.

Connecting over a private network such as [Tailscale](https://tailscale.com) is recommended.

## Discord Bot Configuration

Enable the following Gateway Intents in the Developer Portal:

- `GUILDS`
- `GUILD_MESSAGES`
- `MESSAGE_CONTENT`

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DISCORD_TOKEN` | ✓ | Discord bot token |
| `DEEPSEEK_API_KEY` | ✓ | DeepSeek API key |
| `GEMINI_API_KEY` | ✓ | Gemini API key |
| `AI_CHANNEL_NAME` | | Channel the bot listens in (default: `ai-chat`) |
| `WEB_SEARCH_ENABLED` | | Set to `false` to disable web search tools (default: `true`) |
| `WINDOWS_API_HOST` | | Host of the Windows Search API (default: `localhost`) |

## License

MIT
