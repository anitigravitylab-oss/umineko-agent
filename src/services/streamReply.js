// 機能A: Claude系ストリーミングのDiscord逐次表示。
// SSEで届く累積テキスト（onTextDelta経由）を2.5秒スロットルでDiscordメッセージへ
// 反映する。1900字(softLimit)を超えたら段落境界優先で確定メッセージを切り出し、
// 残りを新しいメッセージとして続ける。確定済みメッセージは以後編集しない。

const CURSOR = '▌';

// window内で分割点を探す。段落境界(\n\n)優先、なければ改行、なければ強制カット。
// サロゲートペアの真ん中では切らない。戻り値は「windowの先頭から何文字を確定
// 側に含めるか」（>0保証、無限ループ回避のため境界がindex0にある場合はスキップ）。
function findSplitIndex(window) {
  const paraIdx = window.lastIndexOf('\n\n');
  if (paraIdx > 0) return paraIdx + 2;
  const lineIdx = window.lastIndexOf('\n');
  if (lineIdx > 0) return lineIdx + 1;
  let cut = window.length;
  const code = window.charCodeAt(cut - 1);
  if (cut > 1 && code >= 0xd800 && code <= 0xdbff) cut -= 1; // 高サロゲートの直後で切らない
  return cut;
}

export function createStreamReply(channel, { throttleMs = 2500, softLimit = 1900, now = Date.now } = {}) {
  let consumedLength = 0; // fullTextのうち既に確定メッセージへ書き出し済みの長さ
  let currentMsg = null; // 編集対象の生きているメッセージ（確定するとnull化して手放す）
  let committed = []; // 確定済みメッセージ（以後編集しない。reset用に保持）
  let lastEditAt = null;
  let maxSeenLength = 0; // updateで観測した累積fullTextの最大長（再スタート検出用）

  async function safeSend(content) {
    if (!content) return null;
    try {
      return await channel.send(content);
    } catch (e) {
      console.warn(`[streamReply] send failed: ${e.message}`);
      return null;
    }
  }

  async function safeEdit(msg, content) {
    if (!content) return;
    try {
      await msg.edit(content);
    } catch (e) {
      console.warn(`[streamReply] edit failed: ${e.message}`);
    }
  }

  async function safeDelete(msg) {
    try {
      await msg.delete();
    } catch (e) {
      console.warn(`[streamReply] delete failed: ${e.message}`);
    }
  }

  // fullTextの未確定部分がsoftLimitを超える限り、段落境界優先で確定メッセージを
  // 切り出し続ける（1回のupdateで一気にsoftLimitを2回以上超えるケースにも対応）。
  // スロットル対象外（構造上必須の分割のため常に実行）。
  async function commitOverflow(fullText) {
    while (fullText.length - consumedLength > softLimit) {
      const window = fullText.slice(consumedLength, consumedLength + softLimit);
      const cut = findSplitIndex(window);
      const committedText = fullText.slice(consumedLength, consumedLength + cut);
      if (currentMsg) {
        await safeEdit(currentMsg, committedText);
        committed.push(currentMsg);
      } else {
        const sent = await safeSend(committedText);
        if (sent) committed.push(sent);
      }
      currentMsg = null;
      consumedLength += cut;
    }
  }

  // 現在のライブメッセージ（未確定の末尾テキスト）をfullTextの最新状態に合わせて
  // send/editする。存在しなければ必ずsend（スロットル対象外）。
  async function renderCurrent(fullText, { cursor }) {
    const visible = fullText.slice(consumedLength);
    const display = cursor ? `${visible}${CURSOR}` : visible;
    if (!display) return;
    if (!currentMsg) {
      currentMsg = await safeSend(display);
      lastEditAt = now();
      return;
    }
    lastEditAt = now();
    await safeEdit(currentMsg, display);
  }

  // 2.5秒スロットルで現在のメッセージを編集。初回テキスト到着時（＝メッセージ未送信時）
  // は無条件でsendする。softLimit超過時の確定切り出しは常に行う。
  async function update(fullText) {
    // 再スタート検出: 正常時のストリーム累積は単調増加なので、観測済み最大長より
    // 縮んだfullTextはストリーム途中リトライ（claudeFetchのattemptループ）による
    // 最初からの再送。分割確定済みメッセージは以後編集されないため、放置すると
    // 旧試行のテキストが画面に残ったまま新試行の内容が続いて表示が壊れる。
    // 送信済みメッセージを全削除して初期状態からゼロで描画し直す（誤検出なし）。
    if (fullText.length < maxSeenLength) {
      await reset();
    }
    maxSeenLength = fullText.length;
    await commitOverflow(fullText);
    if (!currentMsg) {
      await renderCurrent(fullText, { cursor: true });
      return;
    }
    const elapsed = lastEditAt == null ? Infinity : now() - lastEditAt;
    if (elapsed < throttleMs) return;
    await renderCurrent(fullText, { cursor: true });
  }

  // スロットル無視で最終状態に編集（カーソル除去）。全メッセージ2000字以内保証。
  async function finalize(fullText) {
    await commitOverflow(fullText);
    await renderCurrent(fullText, { cursor: false });
  }

  // 途中までストリームしたstepが回答ではなかった（tool_useで終わった）場合に、
  // 作ってしまったメッセージを全削除して初期状態に戻す。
  async function reset() {
    const toDelete = [...committed, currentMsg].filter(Boolean);
    committed = [];
    currentMsg = null;
    consumedLength = 0;
    lastEditAt = null;
    maxSeenLength = 0;
    for (const msg of toDelete) {
      await safeDelete(msg);
    }
  }

  return { update, finalize, reset };
}
