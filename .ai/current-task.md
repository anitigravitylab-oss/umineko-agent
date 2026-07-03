# Phase 4: #ai-memory の自動埋め込み化 + #ai-config の read_channel 遮断

## 背景（なぜやるか）
ユーザー実測報告: 「configやmemoryを更新しても、読んでと言わないと反映されない。読んでと言っても読まないことがある」。

本番ログ調査で判明した実態:
- `#ai-memory` はモデルが `read_channel` を自発的に呼ぶかどうかに依存しており、LLMのツール呼び出し判断は100%決定的ではない（指示があっても呼ばないことがある、既知のLLMエージェントの弱点）
- `#ai-memory` の自動反映（トピック/ピン留めのみを見る `#ai-config` の personaConfig.js 方式）は存在せず、常にツール呼び出し頼み
- 別件として、`#ai-config` は本来トピック/ピン留めのみを読む設計（`getPersonaConfig`）だが、`read_channel` ツール自体は `#ai-config` を対象外にしておらず、モデルが `read_channel({"channel_name":"ai-config"})` を呼ぶと通常メッセージ（下書き・編集途中の内容）まで拾ってしまう副経路が実際にログで確認された（`犬語で喋る` → `結論から話す...` という編集途中の内容が2回のread_channelで別々の内容として読まれていた）

## 決定事項
- `#ai-memory`: 自動埋め込み方式に変更（推奨案採用）。read_channelでの深掘りは維持しつつ、基本的な内容は毎回systemプロンプトに自動で乗るようにする
- `#ai-config`: トピック/ピン留めを優先する設計は維持しつつ、**トピックもピン留めも0件の場合のみ直近メッセージにフォールバックする**（2026-07-03 追加決定）。本番で「メッセージを書いた/編集しただけでピン留めし忘れる」実障害が2回連続発生したため、ピン留め必須のUXは実用上の摩擦が大きいと判断。トピックまたはピンが1件でも存在する場合はフォールバックを使わない（管理者の意図的設定を一般メンバーの雑談で薄めないため、優先順位は維持）。`read_channel` を `#ai-config` に対して使えないよう塞ぐことも継続する（意図しない下書き内容の混入防止、フォールバックとは別経路）

## 目的
1. `#ai-memory` の内容を、モデルのツール呼び出し判断に頼らず、`#ai-config` と同様に毎回自動でsystemプロンプトに埋め込む
2. `read_channel` ツールが `#ai-config` を対象にできないようにし、トピック/ピン留め以外の経路での意図しない内容混入を防ぐ

## 変更するファイルと実装方針

### 1. `src/services/personaConfig.js`（関数追加。ファイル名はそのままでよい。責務が「チャンネルから設定/記憶を読む」で共通のため）
新関数 `getMemoryDigest(guild)` を追加してexport:
- ギルドから名前が正確に `ai-memory` のテキストチャンネルを探す。なければ `null`
- `channel.messages.fetch({ limit: 50 })` で最近のメッセージを取得（`read_channel` の実装と同じ取得件数でよい）、古い順に整列
- 各メッセージを `${author.username}: ${content}` の形式で1行にし、空文字content（画像のみ等）は除外
- 合計 **4000字で切り詰め**（超過分は古い方から捨て、先頭に `…(古い記憶は省略)` を付ける。`getPersonaConfig` の切り詰め方針と対にする）
- 空（メッセージなし）なら `null`
- **インメモリキャッシュ**: guild.idキー、TTL 5分（`getPersonaConfig`と同じ実装パターンを流用してよい。むしろ既存のキャッシュ実装を汎用化して両方で使い回すのが望ましいが、無理に共通化せず素直にコピーしてよい）
- `clearMemoryDigestCache(guildId)` もexport
- fetch失敗時はキャッシュにnullを入れてログ1行、例外を投げず落ちないこと

### 2. `src/services/prompt.js`
- `buildSystemPrompt(guild, aiChannelIds, { mode, custom, memoryDigest })` に `memoryDigest` パラメータを追加
- 現行の「## 長期記憶 (#ai-memory)」セクション（55-59行目付近）を以下のように拡張する:
  - `memoryDigest` が非空なら、セクション内に埋め込む。例:
    ```
    ## 長期記憶 (#ai-memory)
    以下は#ai-memoryに書かれている内容（自動反映・毎回最新）:
    <memoryDigest の中身>

    - 上記に無い、サーバー固有の人物・好み・決定事項・経緯が関わる質問では、より詳しい履歴を read_channel で読む。
    - ユーザーに「覚えて」と言われたとき、または会話でサーバーに関する持続的な事実（好み・決定・役割）を得たときは、#ai-memory に send_message で保存する。1メッセージ=1事実、簡潔に。
    - 古くなった記憶は delete_message（自分のメッセージのみ可）で消してから書き直す。
    - #ai-memory への send_message と自分のメッセージの delete_message に限り、「変更系ツールは明示依頼時のみ」の例外として、明示依頼がなくても自律的に使ってよい。
    ```
  - `memoryDigest` が空/nullの場合（#ai-memoryチャンネルが存在するがメッセージが0件）は、既存どおり read_channel を促す文言のみ（自動埋め込み部分は出さない）
  - `#ai-memory` チャンネル自体が存在しない場合は、このセクション自体を出さない（現行の `hasMemoryChannel` 判定はそのまま維持）
  - **注意: cache_control配置（persona → time の順、personaにcache_control）は変更禁止**。memoryDigestはpersona文字列の一部として組み込まれるため自然にキャッシュ対象になる（これは意図通り。5分ごとに内容が変わりうる点はpersonaConfigのcustomと同じ扱いでよい）

### 3. `src/services/agent.js`
- `runAgent` 冒頭、`getPersonaConfig(guild)` を呼んでいる箇所の近くで `getMemoryDigest(guild)` も呼び、`buildSystemPrompt` に `memoryDigest` として渡す
- `channels.cache` が空/存在しない場合でも例外を投げないこと（`getPersonaConfig` と同様の防御）

### 4. `src/index.js`
- `#ai-memory` チャンネルへの `MessageCreate` / `MessageUpdate` / `MessageDelete` を検知して `clearMemoryDigestCache(guild.id)` を呼ぶリスナーを追加（`ChannelPinsUpdate`/`ChannelUpdate` の実装パターンを流用）。author が bot自身かどうかは問わず、対象チャンネルへのあらゆる変更でキャッシュを飛ばす
- import文に `clearMemoryDigestCache` を追加

### 5. `src/services/tools.js`
- `read_channel` の実装（`executeToolInner` 内、253-267行目付近）で、`args.channel_name === 'ai-config'` の場合は既存の「見つかりませんでした」相当のエラーメッセージを返し、実際のチャンネル内容を読ませないようにする。既存のフィルタ条件（`!aiChannelIds.has(c.id)`）とは別に、明示的にチェックを追加すること（`aiChannelIds`ベースの判定だけでは`ai-config`を塞げないことが今回判明した根本原因のため、名前による明示チェックを必ず入れる）
- `#ai-memory` は引き続き `read_channel` で読めるままにする（変更しない）
- エラーメッセージ文言は自然に。例: `チャンネル #ai-config が見つかりませんでした。`（既存の「見つからない」パターンと同じにして、モデルに「このチャンネルは読めない」ことを暗示しつつ不自然に見せない）

## 禁止事項
- cache_control配置・thinkingのverbatim保存・claudeFetch挙動・streamReply・personaConfig(既存部分)の動作変更禁止
- `#ai-config` の基本設計（トピック/ピン留めのみを読む）を変更しないこと（今回はread_channelの遮断のみ追加。トピック/ピン留め機構自体はそのまま）
- send_message/delete_messageツールの`#ai-memory`向け動作は変更しない
- git commit / push / デプロイ禁止（親がやる）
- 勝手な仕様変更・大規模リファクタ・関係ない変更・長文ログ貼り付け禁止
- reasonix-do / 外部LLM APIの新規利用禁止

## 検証（実装者セルフチェック。盲検verifierは別途走る）
- 全srcファイル `node --check`
- getMemoryDigest のユニット（フェイクguild/channel/fetch: メッセージ複数件→整形された文字列、空→null、4000字超→切り詰め、TTLキャッシュの再利用とclear後の再取得、fetch失敗時のnull＋非クラッシュ）
- buildSystemPrompt のユニット（memoryDigest有→セクションに埋め込まれる、無（チャンネルはあるがメッセージ0件）→自動埋め込み部分が出ない、チャンネル自体なし→セクション自体が出ない、customとmemoryDigest併用時に両方出る、地図注記は既存のまま変化なし）
- read_channelのユニット（`channel_name: 'ai-config'` → 見つかりませんでした相当のエラー文言、`channel_name: 'ai-memory'` → 引き続き正常に読める、他の通常チャンネル名は引き続き正常）
- 実APIは **claude-haiku-4-5-20251001 で1〜2回のみ**（`#ai-memory`にメッセージを仕込んだフェイクguildでrunAgentを実行し、read_channelを呼ばなくても最初の応答に記憶内容が反映されていることを、fetchフックで送信systemプロンプトの中身を見て確認する）。fable-5/opus使用禁止
- 15秒起動スモーク（Ready確認）
- 一時テストスクリプトはプロジェクト直下に作り、終了後削除
