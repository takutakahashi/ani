# ani

YAML/TOMLで振る舞いを定義する、ステートレスなOpenAI API互換モックサーバーです。
Chat Completions APIとResponses APIを、Next.js standaloneまたはDockerで実行できます。

## 起動

Node.js 22.12以降とnpmを使用します。

```sh
npm ci
npm run dev
```

既定ではGit管理外の `config/ani.yaml` をサーバー起動時に読み込みます。別のファイルを使う場合は
`ANI_CONFIG_PATH` を指定します。設定が不正な場合、プロセスは終了コード2で停止します。

```sh
ANI_CONFIG_PATH=/path/to/ani.toml npm run dev
```

public HTTP上の設定を使う場合は `ANI_CONFIG_URL` を指定します。コンテナ／Node.js版は起動時、
Cloudflare Workers版は最初のリクエスト時に一度だけ取得します。HTTP GETのみを行い、2秒timeout、
1MiB上限、既存schemaによる検証を適用します。

```sh
ANI_CONFIG_URL=https://config.example.com/ani.yaml npm run dev
```

`ANI_CONFIG_URL` は `ANI_CONFIG_PATH` より優先されます。形式はURLの `.yaml`, `.yml`, `.toml`、
またはレスポンスの `Content-Type` から判定します。

リクエスト例:

```sh
curl http://localhost:3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"ani-1","messages":[{"role":"user","content":"hello"}]}'
```

## Docker

```sh
docker build -t ani .
docker run --rm -p 3000:3000 \
  -e ANI_CONFIG_URL=https://config.example.com/ani.yaml \
  ani
```

設定ファイルを差し替える場合:

```sh
docker run --rm -p 3000:3000 \
  -e ANI_CONFIG_PATH=/etc/ani/config.toml \
  -v "$PWD/config/ani.toml:/etc/ani/config.toml:ro" \
  ani
```

## ロリポップ！デプロイナウ

Next.jsのstandalone出力に対応しています。

```sh
npm install -g lolipop
lolipop deploy --name ani --framework next
```

設定ファイルはstandalone成果物へ同梱しません。`ANI_CONFIG_URL` を環境変数として設定するか、
実行環境から読めるファイルを用意して `ANI_CONFIG_PATH` を設定してください。

## Cloudflare Workers

Workers版はNext.jsを介さない軽量な専用エントリポイントを使用し、同じルール判定・レスポンス生成コアを
共有します。ローカルのworkerd環境で確認する場合:

```sh
npm run cf:dev
```

デプロイ:

```sh
npm run cf:deploy
```

Workers版はR2 bindingの `CONFIG_BUCKET` から設定を読みます。既定のobject keyは `active.yaml` で、
`ANI_CONFIG_KEY` bindingにより変更できます。最初のリクエスト時に取得し、isolate内で検証・保持します。

R2 bindingがない環境では、互換fallbackとして `ANI_CONFIG_URL` も利用できます。

設定のアップロード例:

```sh
npx wrangler r2 object put ani-openai-mock-config/active.yaml \
  --file config/ani.yaml \
  --content-type application/yaml \
  --remote
```

現在のデプロイ先: <https://ani-openai-mock.taku-takahashi120.workers.dev>

## エンドポイント

- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`
- `GET /healthz`

`stream: true` は現時点では未対応で、OpenAI形式の `400` を返します。サーバーはリクエスト間の
カウンターやセッションを持ちません。TPM/RPMは集計せず、設定ルールによって `429` とrate-limit
headersを返す方式で模擬します。

実際の設定ファイルはGit管理外です。詳細な仕様は [DESIGN.md](DESIGN.md) を参照してください。

## 開発

```sh
npm test
npm run typecheck
npm run lint
npm run build
npx wrangler deploy --dry-run
```

デプロイ済みAPIのsmoke test:

```sh
./scripts/smoke-test.sh

# 別のデプロイ先やAPIキーを使う場合
ANI_BASE_URL=https://example.com ANI_API_KEY=test-key ./scripts/smoke-test.sh
```

`/v1/responses` と `/v1/chat/completions` は `"stream": true` に対応しています。Responses APIは
`response.created` から `response.completed` までをSSEで返し、Chat Completionsは最後に
`data: [DONE]` を返します。設定で4xx/5xxを指定したルールは、ストリームを開始せず従来どおり
HTTPエラーのJSONレスポンスを返します。

プロンプトに次のディレクティブを含めると、設定ファイルより優先してレスポンスを制御できます。

```text
return(code=429, latency=100m, retry=3, response_text="OK", return_debug_response=false)
```

引数の順序は自由で、省略した値には設定ファイルのルールまたはdefaultsが使われます。`status` は `code`、
`retry_after` は `retry` の別名としても利用できます。`latency` は `m` / `ms`（ミリ秒）または `s`（秒）です。
`return_debug_response` が `true` の場合、`response_text` の代わりに method、URL、秘匿ヘッダーを除いた
request headers、request bodyをJSON文字列として応答本文に返します。互換性のため、綴りが異なる
`return_debug_responce` も受け付けます。
