# ani 設計書

## 1. 目的

`ani` は、設定ファイルだけで振る舞いを変更できる OpenAI API 互換のモックサーバーである。
プロンプトに含まれる文字列をルールに照合し、成功応答、任意の HTTP エラー、遅延、
トークン使用量、レート制限応答、ランダム応答を再現する。

主用途は SDK、リトライ、タイムアウト、フォールバック、レート制限処理の結合テストであり、
実際の推論や厳密なトークナイズは目的に含めない。

## 2. スコープ

### MVP

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`
- 非ストリーミング応答
- YAML / TOML 設定（起動時にどちらか 1 ファイルを読み込む）
- 文字列、正規表現、ロールを使ったプロンプト照合
- HTTP status、応答遅延、出力トークン数、rate-limit 応答の模擬
- 固定応答、重み付きランダム応答
- 設定検証、構造化アクセスログ、メトリクス

### MVP 後

- SSE ストリーミング
- function/tool call、structured output
- 設定の hot reload
- Embeddings API

OpenAI 互換とは、対象エンドポイントについて一般的な OpenAI SDK が `base_url` の変更だけで利用できることを指す。
未対応フィールドは無視し、リクエストの JSON 構造が不正な場合のみ `400` を返す。

## 3. 推奨技術構成

TypeScript、Next.js App Router、Node.js 22.12 以降を採用する。Next.js standalone成果物を
コンテナとロリポップ！デプロイナウの両方で実行する。Cloudflare Workersでは同じコアを利用する
専用のFetch handlerをWranglerでデプロイする。

- HTTP: Next.js Route Handlers / Web標準 `Request`, `Response`
- YAML: `yaml`
- TOML: `smol-toml`
- schema validation: `zod`
- test: Vitest
- コンテナ: Node.js Alpine の multi-stage build
- Workers: Wrangler、public HTTP上の設定

論理構成:

```text
HTTP adapter
  -> request normalizer
  -> rule matcher
  -> response planner
  -> latency scheduler
  -> OpenAI response renderer (chat | responses)
```

HTTP 形式とシナリオ判定を分離し、同じルールを Chat Completions と Responses の双方で再利用する。

## 4. 設定モデル

YAML を正規のドキュメント形式とし、TOML は同じschemaへデコードする。時間は `250ms`, `2s`、
容量は整数、確率・重みは 0 以上の数値で表す。未知フィールドは起動エラーにする。

設定はサーバー起動時に `ANI_CONFIG_PATH`（既定 `config/ani.yaml`）から一度だけ読み込む。
設定が不正な場合は終了コード2で停止し、リクエスト処理を開始しない。hot reloadは行わない。
Cloudflare Workers版ではローカルファイルシステムを利用せず、`ANI_CONFIG_URL` を必須とする。
設定ファイルの内容はWorker bundleやGitリポジトリへ含めない。

`ANI_CONFIG_URL` が指定された場合はpublic HTTPからGETする。Node.js版は起動時、Workers版は
最初のリクエスト時に一度だけ取得する。timeoutは2秒、最大サイズは1MiBとし、取得・検証に失敗した
Workers版は `503 config_unavailable` を返す。書き込みAPI、定期更新、hot reloadは提供しない。

```yaml
version: 1

server:
  api_key: "test-key"       # 省略時は Authorization を検証しない
  seed: 42                  # 省略時はランダム。指定時は再現可能
  max_body_bytes: 1048576

defaults:
  model: "ani-1"
  latency: 20ms
  response:
    text: "default response"
    output_tokens: 8
    token_mode: reported    # reported | padded

rules:
  - id: rate-limit-error
    priority: 100
    match:
      text:
        contains: ["[[rate-limit]]"]
      roles: [user]
    response:
      status: 429
      error:
        type: rate_limit_error
        code: rate_limit_exceeded
        message: "Please retry"
      headers:
        retry-after: "1"
        x-ratelimit-limit-tokens: "10000"
        x-ratelimit-remaining-tokens: "0"
        x-ratelimit-reset-tokens: "1s"

  - id: slow
    priority: 50
    match:
      text:
        regex: "(?i)slow|timeout"
    response:
      latency:
        distribution: fixed # fixed | uniform | normal
        value: 3s
      text: "slow response"

  - id: random-answer
    priority: 10
    match:
      text:
        contains: ["[[random]]"]
    response:
      random:
        - text: "alpha"
          weight: 1
        - text: "beta"
          weight: 2
        - text: "gamma"
          weight: 1
      output_tokens: 12
      token_mode: padded
```

TOML では同じキーを `[server]`, `[defaults]`, `[[rules]]`, `[[rules.response.random]]` として表現する。
初期実装では YAML/TOML 間の変換機能は持たせない。

## 5. プロンプトの正規化と照合

Chat Completions は `messages` 内の文字列 content と `content[type=text].text` を対象にする。
Responses API は `input` が文字列の場合と、input message の `input_text` を対象にする。
画像、音声、ファイルは照合対象から除外する。

各テキスト片を次の内部形式へ正規化する。

```text
PromptPart { role, text, ordinal }
```

照合条件:

- `contains`: いずれか、または `mode: all` 指定時はすべてを含む
- `equals`: 正規化後の全文一致
- `regex`: JavaScript 正規表現
- `roles`: 指定ロールのテキストだけを対象にする
- `model`: glob 形式によるモデル名照合
- `header`: HTTP ヘッダーの一致
- `case_sensitive`: 既定 `true`

複数の match フィールドは AND、各配列は既定 OR とする。入力順を維持して `\n` で結合する。
Unicode normalization は行わない。改行は LF に統一する。

### ルール決定

1. `priority` の降順
2. 同じ priority なら設定ファイルの記述順
3. 最初に一致した 1 ルールだけを採用
4. 一致しなければ `defaults.response`

偶発的な複数一致を診断できるよう、起動時の `ani validate` と `X-Ani-Rule-ID` 応答ヘッダーを用意する。

## 6. 振る舞いの意味

### status とエラー

`2xx` は通常の OpenAI 形式、非 `2xx` は次の形式で返す。

```json
{
  "error": {
    "message": "Please retry",
    "type": "rate_limit_error",
    "param": null,
    "code": "rate_limit_exceeded"
  }
}
```

status とエラー本文は独立に指定可能だが、起動時に矛盾を warning として報告する。

### latency

レスポンスヘッダーを送る前に待機する。クライアント切断時は request context で即座に中断する。

- `fixed`: 常に指定値
- `uniform`: `[min, max]` の一様分布
- `normal`: `mean`, `stddev`。負値は 0、任意の `max` で上限を設定

### output tokens

- `reported`: 実テキストに関係なく `usage.output_tokens` / `completion_tokens` を設定する
- `padded`: 指定値に近づくよう決められた filler を追加し、同梱 tokenizer で指定値に一致させる

モデルごとの厳密な tokenizer 互換は保証しない。`padded` は ani 固有 tokenizer で物理的な出力量や
ストリーム時間を試験する用途、`reported` は利用量処理を試験する用途とする。入力トークン数は
`configured`（固定値）または `estimated`（UTF-8 テキストから概算）を選べる。

### rate limit の模擬

サーバーはリクエスト履歴や時間窓を保持せず、TPM/RPM を集計・強制しない。特定のプロンプトに一致した場合、
ルールで `429` と以下のヘッダーを静的に返すことで、呼び出し側の rate-limit 処理を試験する。

```text
x-ratelimit-limit-tokens
x-ratelimit-remaining-tokens
x-ratelimit-reset-tokens
retry-after
```

値はルールごとに自由に設定できる。実際の「1分間に N token を超えたら失敗」や「最初の N 回だけ失敗」は
履歴状態なしでは正確に実現できないため、機能として提供しない。

### ランダム応答

候補から `weight / sum(weights)` で選ぶ。`server.seed` 指定時も並列実行順による揺れを避けるため、
乱数はグローバル列ではなく、指定された seed とリクエスト内容の hash から生成する。
同一 seed・同一リクエストは常に同じ結果になる。完全なランダム性が必要なら seed を省略する。

## 7. OpenAI 互換レスポンス

### Chat Completions

`POST /v1/chat/completions` は `id`, `object`, `created`, `model`, `choices`, `usage` を返す。
`choices[0].message` は `{role: "assistant", content: "..."}`、`finish_reason` は通常 `stop` とする。

### Responses

`POST /v1/responses` は `id`, `object`, `created_at`, `status`, `model`, `output`, `usage` と
`output_text` を構成できる output message/content を返す。内部の ResponsePlan は共通で、renderer だけを分ける。

### Models

`GET /v1/models` は設定に登場するモデルと defaults のモデルを返す。モデル未登録を拒否する
`strict_models` は任意機能とし、既定は任意モデル名を受け入れる。

認証を有効にした場合、`Authorization: Bearer <key>` を検証する。比較は constant-time とし、ログへ値を出さない。

## 8. ストリーミング拡張

MVP 後に `stream: true` を実装する。

- Chat Completions: `text/event-stream` で chat completion chunk を送り、最後に `data: [DONE]`
- Responses: `response.created`、text delta、`response.completed` の順に SSE event を送る
- `latency.first_token` と `latency.per_token` を追加
- `output_tokens` 個のチャンクではなく、`chunk_size_tokens` 単位で送信可能

接続前遅延と token 間遅延を別設定にしないと TTFT と総生成時間を個別に試験できないため、単一の latency
設定をストリームへ流用しない。

## 9. 実行

```text
npm run dev
ANI_CONFIG_PATH=config/ani.toml npm run dev
npm run build
npm run start:standalone
```

設定不正は終了コード `2` とする。デプロイNowでは `output: "standalone"` を必須とし、ビルド後に
`config/` を成果物へコピーする。Dockerでは `ANI_CONFIG_PATH` とread-only volumeで設定を差し替えられる。

## 10. 可観測性とテスト容易性

アクセスログには request id、endpoint、model、rule id、attempt、status、planned/actual latency、token usage、
rate-limit decision を JSON で出す。プロンプト本文と Authorization は既定で記録しない。

補助エンドポイント:

- `GET /healthz`: プロセス生存
- `GET /readyz`: 設定ロード済み

テスト方針:

- unit: YAML/TOML 同値、照合優先順位、重み選択
- golden: Chat Completions / Responses の成功・エラー JSON
- integration: 公式 SDK から `base_url` を差し替えた呼び出し
- cancellation: latency 待機中の切断でtimerが残らない
- fuzz: request decoder と regex/config parser

## 11. パッケージ構成案

```text
app/v1/                # Next.js Route Handlers
src/config/            # decode, validation, startup snapshot
src/prompt/            # normalized prompt
src/matcher/           # rule matching
src/scenario/          # stateless response planning
src/server/            # OpenAI response renderers
config/ani.yaml
```

設定ロード時に regex と重み累積値をコンパイルし、リクエスト経路では不変の設定 snapshot を参照する。
リクエスト間で共有する可変状態は持たない。

## 12. 実装フェーズ

1. config schema、`validate`、正規化、matcher
2. Chat Completions の固定成功/エラー応答
3. latency、決定論的ランダム応答
4. token usage と rate-limit 応答
5. Responses API、models、認証
6. metrics、コンテナ、SDK integration test
7. SSE と高度なレスポンス形式

MVP の受け入れ条件は、同一設定・同一リクエストで結果が再現でき、並行テスト同士が干渉せず、
Chat Completions と Responses の両方を OpenAI SDK の base URL 差し替えで呼べることとする。

## 13. 設計上の判断

- サーバーはリクエスト間のカウンター、時間窓、セッションを一切持たない。
- retry count と実測 TPM/RPM 制限は、共有状態が必要になるため提供しない。
- リトライ処理は、常に失敗するルールと常に成功するルールを別々に使って試験する。
- トークン数は「usage の模擬」と「実出力長」を分離する。
- ルールは first-match とし、複数ルールの merge による予測困難な設定を避ける。
- 乱数をリクエスト内容由来にして、並行実行でも flaky test を作らない。
