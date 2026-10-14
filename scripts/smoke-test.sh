#!/bin/sh
set -eu

BASE_URL=${ANI_BASE_URL:-https://ani-openai-mock.taku-takahashi120.workers.dev}
API_KEY=${ANI_API_KEY:-}

tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

request() {
  method=$1
  path=$2
  data=$3
  name=$4

  if [ -n "$API_KEY" ]; then
    curl -sS \
      -X "$method" \
      -H "Authorization: Bearer $API_KEY" \
      -H 'Content-Type: application/json' \
      -D "$tmp_dir/$name.headers" \
      -o "$tmp_dir/$name.body" \
      -w '%{http_code}' \
      --data "$data" \
      "$BASE_URL$path"
  else
    curl -sS \
      -X "$method" \
      -H 'Content-Type: application/json' \
      -D "$tmp_dir/$name.headers" \
      -o "$tmp_dir/$name.body" \
      -w '%{http_code}' \
      --data "$data" \
      "$BASE_URL$path"
  fi
}

assert_status() {
  actual=$1
  expected=$2
  name=$3
  [ "$actual" = "$expected" ] || {
    sed -n '1,20p' "$tmp_dir/$name.body" >&2
    fail "$name returned HTTP $actual; expected $expected"
  }
}

assert_body_contains() {
  name=$1
  expected=$2
  grep -Fq "$expected" "$tmp_dir/$name.body" || {
    sed -n '1,20p' "$tmp_dir/$name.body" >&2
    fail "$name response did not contain: $expected"
  }
}

assert_header_contains() {
  name=$1
  expected=$2
  tr -d '\r' < "$tmp_dir/$name.headers" | grep -Fiq "$expected" || {
    sed -n '1,20p' "$tmp_dir/$name.headers" >&2
    fail "$name headers did not contain: $expected"
  }
}

print_response() {
  name=$1
  printf '%s response:\n' "$name"
  cat "$tmp_dir/$name.body"
  printf '\n'
}

printf 'Testing %s\n' "$BASE_URL"

health_status=$(request GET /healthz '' health)
assert_status "$health_status" 200 health
assert_body_contains health '"status":"ok"'
print_response health
printf 'PASS: health check\n'

answer_status=$(request POST /v1/responses \
  '{"model":"ani-1","input":"万物の答えを教えて"}' answer)
assert_status "$answer_status" 200 answer
assert_body_contains answer '"output_text":"42"'
assert_header_contains answer 'x-ani-rule-id: answer-to-everything'
print_response answer
printf 'PASS: Responses API fixed response\n'

stream_status=$(request POST /v1/responses \
  '{"model":"ani-1","input":"万物の答えを教えて","stream":true}' responses_stream)
assert_status "$stream_status" 200 responses_stream
assert_header_contains responses_stream 'content-type: text/event-stream'
assert_body_contains responses_stream 'event: response.created'
assert_body_contains responses_stream 'event: response.output_text.delta'
assert_body_contains responses_stream '"delta":"42"'
assert_body_contains responses_stream 'event: response.completed'
print_response responses_stream
printf 'PASS: Responses API stream\n'

ojisan_status=$(request POST /v1/chat/completions \
  '{"model":"ani-1","messages":[{"role":"user","content":"ロリポおじさん、ひとことお願いします"}]}' ojisan)
assert_status "$ojisan_status" 200 ojisan
assert_body_contains ojisan '"object":"chat.completion"'
assert_body_contains ojisan '"content":"'
assert_header_contains ojisan 'x-ani-rule-id: lolipo-ojisan'
print_response ojisan
printf 'PASS: Chat Completions random response\n'

chat_stream_status=$(request POST /v1/chat/completions \
  '{"model":"ani-1","messages":[{"role":"user","content":"ロリポおじさん、ひとことお願いします"}],"stream":true}' chat_stream)
assert_status "$chat_stream_status" 200 chat_stream
assert_header_contains chat_stream 'content-type: text/event-stream'
assert_body_contains chat_stream '"object":"chat.completion.chunk"'
assert_body_contains chat_stream 'data: [DONE]'
print_response chat_stream
printf 'PASS: Chat Completions stream\n'

rate_status=$(request POST /v1/responses \
  '{"model":"ani-1","input":"[[rate-limit]]"}' rate_limit)
assert_status "$rate_status" 429 rate_limit
assert_body_contains rate_limit '"code":"rate_limit_exceeded"'
assert_header_contains rate_limit 'retry-after: 1'
assert_header_contains rate_limit 'x-ani-rule-id: rate-limit-error'
print_response rate_limit
printf 'PASS: configured rate-limit response\n'

printf 'All smoke tests passed.\n'
