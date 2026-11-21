[English](routing.en.md) · [中文](routing.md)

# LLM Smart Routing

[← Back to README](../README.md)

<p align="center"><img src="screenshots/router.png" width="760" alt="Auto-routing panel"/></p>

An OpenAI-compatible local proxy (`router/router.mjs`, listening on `127.0.0.1:8788`). Every request first goes through a **classifier** that picks the task tier, then walks that tier's **provider-grouped chain**, deciding whether to switch model or switch provider based on *why* the attempt failed.

## Routing Tiers

| Route | Suitable for | Typical primary model |
|---|---|---|
| `simple` | Chit-chat, Q&A, translation, weather/news | deepseek-v4.1-flash |
| `coding` | Writing code, running commands, file operations, MCP tool calls | kimi-k3.1-pro |
| `complex` | Architecture design, complex analysis, planning | claude-opus-5-5 |
| `expert` | Manually designated hardest tasks | claude-fable-5-2 |

Providers, chains and tiers are all editable in the UI, and new routes (e.g. `fast` / `vision`) can be added.

In the UI a chain is a **provider dropdown plus searchable model inputs**: pick an existing model, or type a new name directly (no existence check — saved as typed). Model candidates come from three sources, in order:

1. the provider's `GET /v1/models` (server-side cache for 10 minutes; "↻ Refresh model list" forces a re-pull)
2. models already referenced in the config
3. models actually used in the router log, grouped by `provider=`

When a provider has no `/models` endpoint (Volcengine's plan endpoint returns 404, for example), the last two take over, so the list is never empty. Models can be reordered inside a provider group (that order is the intra-provider fallback order), and groups can be reordered or removed entirely.

## Chain = provider groups

A route's chain is an **ordered list of providers**, each holding an **ordered list of models**:

```json
"coding": {
  "chain": [
    { "provider": "ark",     "models": ["kimi-k3.1-pro", "doubao-seed-2.1-pro"] },
    { "provider": "wb",      "models": ["glm-5.3-flash"] },
    { "provider": "reverix", "models": ["claude-opus-5-5", "gpt-6.1-sol"] }
  ]
}
```

Order is priority. **Switch models inside a provider first; move to the next provider only when the whole account is unusable.** That is the key difference from flattening every fallback model into one list: balance/quota/auth failures apply to every model on that account, so a flat chain burns all five attempts on the same dead provider.

## Failure attribution

| Scope | Typical signal | Action |
|---|---|---|
| **Model** | model not found, unsupported parameter, context overflow, single-model outage (400, 404 model, 422) | next model in the same provider |
| **Capability** (a 400 subtype) | `does not support thinking`, `tools is not supported`, `protocol conversion ... messages.reasoning_content`, unsupported `response_format` | strip the offending field and retry the same target once; only then switch models |
| **Provider** | insufficient balance, quota exhausted (402 / 403 `insufficient_user_quota` / 429 `AccountQuotaExceeded`), auth failure (401), unreachable (DNS/TLS/timeout) | skip **all remaining models** of that provider, move to the next provider in order |
| **Rate limit** (a 429 subtype) | `rate limit`, `requests per 1 minute`, `too many requests` | skip the provider too, but cool down for **60 s only** (honours a parsed `per N minute` window) — never a 15-minute quota breaker |
| **Single-model 5xx** | 5xx whose text points at the model (`Model service temporarily unavailable`, `choose another available model`) | first time cools down **that model only** and tries the next model in the same provider; only a **second consecutive 5xx** trips the whole provider |
| **Request** | genuinely unparseable only: invalid JSON, `"messages" is required`, empty body | stop trying, return the error to the client |

Three extras:

- **Parameter self-heal**: on a 400 like `temperature only 0.6 is allowed`, rewrite the parameter and retry the same target once — not counted as a failure, no breaker trip.
- **Capability downgrade**: when a provider rejects `reasoning_effort` / `tools` / `response_format` / `max_completion_tokens`, drop that field and retry; the log records `fix=<label>` and failures carry `dropped=N`.
- **Fast-fail only on real request errors**: `RE_FATAL_REQ` matches missing message structure or unparseable JSON. **Any other unknown 400 keeps failing over** instead of blaming the client — otherwise agent UIs pop up "this provider refused the request, start a new chat" when the user did nothing wrong.

> Status codes when every candidate fails: `400` only for a fatal request error, otherwise `502` (or `503 + Retry-After` when all providers are open, `429` for rate limits). That way the client treats it as a **service outage** and retries, rather than as "this conversation's structure is rejected".

## Outbound sanitization (reasoning echo)

Agent clients replay the previous assistant turn's chain-of-thought verbatim. Those fields are **client-local state** that most upstreams reject:

| Where | Stripped | Failure it causes |
|---|---|---|
| Top level | `reasoning_effort`, `reasoning`, `think`, `thinking`, `verbosity`, `prompt_cache_key`, `service_tier` … | local Ollama 400 `"qwen2.5:3b-instruct" does not support thinking` |
| Messages | `reasoning_content`, `reasoning_details`, `thinking_blocks`, `provider_specific_fields`, `cache_control`, `refusal` … | Reverix (OpenAI→Anthropic conversion) 400 `cannot preserve ... messages.reasoning_content` |
| Content array | `{"type":"thinking"}` / `{"type":"redacted_thinking"}` blocks | same; messages left with only thinking are dropped entirely |

A message whose `content` becomes empty without `tool_calls` is removed to avoid `content must not be empty`. If a provider really needs the echo, declare `providers.<id>.keepFields: ["reasoning_content"]`.

Failure logs include `shape=[n=12,rc=5,eff=medium,tools=8,stream]` so you can see at a glance what made the upstream 400; `/admin/health` keeps the same field in `recentFails`.

## Routing strategies

Each route may carry a strategy that only reorders **inside that tier** — it never adds/removes members and never bypasses the capability guard:

```json
"complex": { "strategy": "latency", "chain": [ ... ] }
```

| Strategy | Ordering | Best for |
|---|---|---|
| `priority` (default) | exactly the `chain` order | "strong/expensive first" |
| `latency` | lower recent TTFT (EWMA) first, unknown last | interactive agents |
| `cost` | lower `providers.<id>.cost` (USD/1M tokens) first | cost control |
| `healthy` | fewer failures in the last 5 minutes first, open breakers last | flaky upstreams |

Stats live in memory only (EWMA + 5-minute failure window), reset on restart, and are never written back to config.
`/admin/plan` echoes `strategy` and the resulting order; the UI exposes a strategy dropdown per route.

**Tier order also comes from config**: an explicit `retryPolicy.tiers` is used verbatim (missing routes are dropped); only when absent does the router fall back to the order routes appear in the file. Adding or renaming a route therefore never silently rewrites the escalation ladder.

## Capability guard (never let a tiny model fake an agent turn)

A model you *can* call is not necessarily a model that can *do the job*. A local 3B model cannot handle tool calls; forced to, it confidently narrates that it will use the tools while the actual task is already dead. So a provider can declare its limits:

```json
"local": {
  "baseUrl": "http://127.0.0.1:11434/v1",
  "capabilities": { "tools": false, "stream": true, "maxChars": 6000, "maxMessages": 12, "tiers": ["simple"] }
}
```

| Field | Effect |
|---|---|
| `tools: false` | requests carrying `tools` skip this provider; logged as `skip=incapable(local:no-tools(19))` |
| `tiers: ["simple"]` | only serve the listed tiers; `auto` classified as coding/complex never lands here |
| `maxChars` / `maxMessages` | skip once the conversation exceeds the threshold |
| `stream: false` | skip streaming requests (non-streaming-only upstreams) |

Three supporting rules:

- **A tool-bearing request is never "simple"**: even if the client explicitly sends `model=simple` or `model=auto`, any request with `tools` is upgraded to `coding` (`guard.upgradeOnTools`, on by default), logged as `upgrade=simple->coding(tools=19)`. A flash model plus 19 tools is just as unreliable.
- **Borrow the next tier when this tier has no eligible candidate**: not only on retries. When every provider in `simple` is open or blocked by the guard, the router walks `simple→coding→complex→expert` right away for the first capable, un-tripped provider (`borrow=coding`, `x-router-escalate` header set). Capability is evaluated **against the borrowed tier**, so a `simple` request cannot smuggle in the local model that way.
- **Capability dead end fails immediately**: if filtering leaves zero candidates (e.g. only a local 3B configured, request carries 19 tools), the router returns `400 router_no_capable_model` with `retryable:false` and never touches an upstream. Retrying that shape can never succeed.

## Account-level circuit breaker

Provider-scoped failures trip a breaker keyed by `baseUrl + key` (same host with a different key is a different account), persisted to `breaker-state.json`:

- When the error carries a **quota reset time** (e.g. `It will reset at 2026-11-22 04:06:22 +0800`), the breaker recovers exactly then; otherwise it cools down per class: quota 15 min, auth 60 min, **rate-limit 60 s** (or the parsed `per N minute` window), gateway 60 s, network 30 s.
- While open, that provider is skipped without sending a request. **If every candidate is open**, the fast-fail rules below decide between `503 + Retry-After` and a terminal `400`.
- Any success clears the breaker.

### Fast fail: stop the 30s × 3 retry loop

Agent clients honour `503 + Retry-After: 30` and retry up to three times. When the accounts are genuinely unusable, those 90 seconds are wasted. The router therefore returns `400` with `retryable:false` and **no** `Retry-After` when:

| Condition | Why | Error type |
|---|---|---|
| zero candidates after capability filtering | this request shape cannot be served by the current config | `router_no_capable_model` |
| every candidate was already open **before the request arrived** and the youngest breaker is ≥ `guard.fastFailStaleMs` (default 45s) | the outage predates the request; asking again changes nothing | `router_cooling` |
| a quota/balance/auth breaker older than `fastFailStaleMs` exists and this is attempt ≥ 2 | waiting 30s will not fix arrears | `router_cooling` |
| retries ≥ `guard.fastFailAfterRetries` (default 2) and everything is open | it already had its chances | `router_cooling` |
| earliest recovery ≥ `guard.fastFailMinWaitMs` (default 120s) | too long for an interactive turn | `router_cooling` |

The 30-second network breaker deliberately **never** triggers fast fail: it is the one class that may recover on the next attempt, so it is worth one wait. Set any value to `0` to disable that rule.

## Retry awareness

When the same request in the same session arrives again within 5 minutes *after a failure*, it is treated as an agent retry:

| Retry | Behaviour |
|---|---|
| 1st | skip providers/models already tried last round, resume from the breakpoint |
| 2nd (`retryPolicy.escalateAfter`) | escalate to the next tier (simple → coding → complex → expert), then the reserve pool |

If nothing is left after the breakpoint, the router escalates immediately instead of making an empty pass. A successful response clears the ledger, so normal conversation is unaffected.

## Other mechanics

- **Dual-mode classifier**: cloud small model (default; walks the inherited route's providers and picks the first non-open one — zero deployment) or local Ollama (fully offline)
- **Session stickiness**: short follow-ups ("continue / ok") keep the current tier, preserving prompt cache
- **Tool-intent override**: reminders / email / PDF / screenshots go deterministically to `coding`
- **Reserve pool**: `reserve` declares cross-provider fallbacks, auto-appended to every chain (providers already present are not re-appended, preserving provider order)
- **Budget breaker**: per-upstream-host daily limits (`usd` for pay-as-you-go / `requests` for subscriptions); over-limit upstreams are skipped
- **Hot reload**: saving in the UI takes effect immediately (`/admin/reload`), with automatic backup; API keys are masked and blank fields never overwrite
- **One-click agent hookup**: switch Hermes to `model=auto`, or point any other agent's Base URL at the proxy

## Configuration

```bash
mkdir -p ~/.hermes/router
cp router/config.example.json ~/.hermes/router/config.json
node router/router.mjs
```

| Field | Meaning |
|---|---|
| `providers.<name>` | `{ baseUrl, apiKey, label? }` — the provider account pool |
| `routes.<name>.chain[]` | `{ provider, models[] }`, order is priority; inline `{ baseUrl, apiKey, models[] }` also accepted |
| `reserve[]` | cross-provider fallback pool appended to every chain |
| `retryPolicy` | `{ windowMs, escalateAfter, crossTier, tiers[] }` |
| `breaker` | `{ quotaMs, authMs, rateMs, serverMs, networkMs, modelMs }` |
| `classifier.mode` | `cloud` (default) or `local` (Ollama) |
| `budgets.<host>` | `{ "usd": 20 }` or `{ "requests": 5000 }` |
| `upstreamTimeoutMs` | upstream timeout (default 600 s, for slow reasoning models) |

## Observability

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | route list + per-provider breaker state |
| `GET /admin/health` | full state: breaker reason/remaining, model cooldowns, chains, recent failures |
| `GET /admin/plan?route=simple&retry=2` | preview the exact attempt order for a tier and retry count |
| `POST /admin/breaker/reset` | clear breakers (`{"provider":"ark"}`, omit for all) |

Responses carry `x-router-provider` / `x-router-model` / `x-router-attempts` / `x-router-retry` / `x-router-escalate`; logs emit `route= model= host= ok|FAIL status= kind= scope= retry=` and stay parseable by the usage dashboard.

## Regression tests

```bash
npm run test:router
```

Runs a local fake upstream covering: provider-level skip of a whole account, model-level switch, parameter self-heal, fast-fail on bad requests, retry escalation, and all-breakers-open fast fail.

## Optional upstream: Devin CLI bridge

`devin-proxy/proxy.mjs` wraps a one-shot `devin -p --model ...` agent session as a limited OpenAI-compatible endpoint. Start it with `DEVIN_PROXY_KEY=<random-key> node devin-proxy/proxy.mjs`; it binds to `127.0.0.1:8790` only. The local Base URL is `http://127.0.0.1:8790/v1`; Agent Manager can forward it at `/px/devin/v1`.

The bridge requires Bearer authentication. `GET /health` checks only the listener, **not** CLI authentication or model availability: check `devin models` and make a real completion before prioritizing a model. This machine has verified `swe-2-high` and `swe-2-flash-high` end to end. Map them with `DEVIN_MODEL_MAP='{"swe-2-high":"swe-2-high","swe-2-flash-high":"swe-2-flash-high"}'`; the model-list endpoint only reports configured aliases, not live availability.

On this machine, simple routes use Volcano Ark → Devin SWE-2 Flash High → WorkBuddy → DeepSeek; coding routes use Volcano Ark → Devin SWE-2 High → WorkBuddy → DeepSeek → Reverix. Complex and expert keep their existing Reverix → Devin SWE-2 High → Ark → WorkBuddy → DeepSeek order. This is **not direct model inference**. Each call launches an independent Devin agent session and may consume account quota. It accepts only non-streaming text, not OpenAI tool calls or images. Agent requests requiring tools or streaming must use another provider. Test locally without billing via `node --test devin-proxy/proxy.test.mjs`.

## Open-source comparison

Projects this router was measured against, and what was adopted:

| Project | Approach | Adopted here | Not adopted because |
|---|---|---|---|
| [LiteLLM](https://github.com/BerriAI/litellm) | unified gateway for 100+ providers; fallbacks, cooldowns, `simple-shuffle` / `least-busy` / `latency-based` / `cost-based` routing | account-level breakers + cooldowns; latency/cost strategies scoped per tier | Python gateway is large; this needs a single-process, dependency-free OpenAI-compatible layer |
| [RouteLLM](https://github.com/lm-sys/RouteLLM) | learned classifier decides strong vs weak model at a threshold | the classify-then-pick-tier shape, with a swappable cloud/local classifier | needs preference data and ML deps; four hand-written tiers are enough here, and misroutes cost more than they save |
| [semantic-router](https://github.com/aurelio-labs/semantic-router) | embedding similarity over example utterances, no LLM call | deterministic tool-intent regex first (`TOOL_INTENT`) | requires an embedding model; keyword + small classifier is more stable for short Chinese prompts |
| [vLLM Semantic Router](https://github.com/vllm-project/semantic-router) | Envoy ExtProc with intent/complexity/safety signals + semantic cache | signal-driven selection: request shape (tools, chars, messages, tier) participates directly | Envoy/Go and a self-hosted fleet is overkill for a laptop |
| [OpenRouter](https://openrouter.ai/docs/features/provider-routing) | provider routing by `order` / `price` / `throughput` / `latency` + failover | `priority` / `cost` / `latency` strategies and failover semantics | hosted service; keys and billing stay outside this machine |
| [Portkey Gateway](https://github.com/Portkey-AI/gateway) | rule routing, exponential backoff, conditional routes | retry-aware windows and backoff | observability platform first; its config model is heavy for this use |

One operational lesson lands here verbatim: **fallbacks should never retry errors that will fail again**. Insufficient balance, invalid keys and capability mismatches are permanent — fail fast. Only rate limits, network errors and 5xx deserve another round.

## Related

- [Reverse proxy](proxy.en.md) · [Usage dashboard](dashboard.en.md)
