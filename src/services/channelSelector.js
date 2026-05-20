import { ChannelType } from 'discord.js';

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const MAX_RETRIES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SYSTEM_PROMPT = `あなたはDiscordサーバーのチャンネル選択AIです。
ユーザーの質問に答えるために読むべきチャンネル名を選んでください。
関係ないチャンネルは含めないこと。
必ず以下のJSON形式のみで返してください:
{"channels":["channel-name-1","channel-name-2"],"reason":"理由"}`;

async function selectOnce(userMessage, channelList) {
  const res = await fetch(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `利用可能なチャンネル:\n${channelList}\n\nユーザーの質問: ${userMessage}` },
      ],
      max_tokens: 200,
    }),
  });

  if (!res.ok) throw new Error(`DeepSeek API error ${res.status}`);

  const data = await res.json();
  const raw = data.choices[0].message.content ?? '';

  // channels 配列を正規表現で抽出
  const match = raw.match(/"channels"\s*:\s*\[([^\]]*)\]/);
  if (!match) throw new Error(`No channels array: ${raw.slice(0, 100)}`);

  const channels = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (channels.length === 0) throw new Error('Empty channel list');

  const reasonMatch = raw.match(/"reason"\s*:\s*"([^"\n]+)"/);
  return { channels, reason: reasonMatch?.[1] ?? '' };
}

export async function selectChannels(userMessage, guild, excludeChannelId) {
  const textChannels = guild.channels.cache.filter(
    (c) => c.type === ChannelType.GuildText && c.id !== excludeChannelId
  );

  const channelList = textChannels
    .map((c) => `#${c.name}${c.topic ? ` (${c.topic})` : ''}`)
    .join('\n');

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await selectOnce(userMessage, channelList);
      console.log(`[selector] ${result.channels.join(', ')} (attempt ${attempt})`);
      return { ...result, textChannels };
    } catch (e) {
      lastError = e;
      console.warn(`[selector] attempt ${attempt} failed: ${e.message}`);
      if (attempt < MAX_RETRIES) await sleep(1000 * attempt);
    }
  }

  console.warn('[selector] All retries failed, using all channels');
  return { channels: textChannels.map((c) => c.name), reason: 'fallback', textChannels };
}
