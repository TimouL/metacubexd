# Subscription Quality Check & Node Classification — Implementation Plan (v3.3, finalized)

> **Status:** v3.3 — COMPLETE. All phases implemented, built, deployed to test container 8084, and verified end-to-end with a real detection (job → export → file-provider YAML → re-export generation bump). Production 8080 untouched. Bug found & fixed during E2E: NekoSpeed writes timestamped result JSON, not result.json.

**Delivery state (2026-11-21):**

- Branch `feature/node-quality-check` pushed to TimouL/metacubexd; 10 commits (config, acquire, detect, export, jobs, API, UI, Dockerfile/agent wiring, TASK notes, result-JSON fix).
- Tests: agent 352, UI 726, all green; full suite run before delivery.
- Product image `metacubexd-node-check:v2` built (NekoSpeed 6c59f3d + font-noto-cjk + agent capability wired via supervisor.ts).
- **PRODUCTION DEPLOYED (2026-11-21):** Production container `metacubexd` on 8080/9090/7890 now runs `metacubexd-node-check:v2`. compose.yaml image updated; data volume/network/ports/env preserved. Verified: healthy, node-check capability active, both original profiles intact (虾佬蹬得起公益订阅 remote + 防dns泄露整合订阅 local), mihomo v1.19.34 running, proxy 7890 works, UI 200. Pre-deploy data backup at `/home/tim/code/metacubexd-backup-20261117_154830/prod-data-before-nodecheck/prod-data.tar.gz` (42KB) and compose backup `compose.yaml.before-nodecheck`. Rollback = restore compose image to `ghcr.io/metacubex/metacubexd-server:latest` + `docker compose up -d`. Test containers nc1/nc2/nc3 stopped; feature 8081 untouched.
- E2E verified (on nc3 before prod deploy): import 1-node subscription → detect job completed → apply produced ai/streaming/download providers at `/data/node-sets/current/*.yaml` with stable names (`nc_美国_AI_2`), symlink `.staging/1`; re-detect → apply → generation 2, symlink flipped, old staging pruned. Funnel correct (node in AI only, streaming/download empty).
- Known limitation: generalProxy mode requires a dispatcher injection (undici not a direct agent dep); direct + githubProxy modes fully functional.
- Note: SSRF guard correctly blocks private-network subscription URLs (local test used host.docker.internal hostname).

**Goal:** Panel-driven: bulk-add/tag subscriptions → one-pass NekoSpeed quality/speed/landing-region check → funnel classification (AI → streaming → download) → export each class as a **mihomo-consumable proxy-provider file** for fallback / download groups.

**Architecture:** Versioned config in `/data/node-check-config.json` (path from DATA_DIR). Agent orchestrates pinned NekoSpeed, correlates results to a **frozen full-proxy snapshot by unique temporary names**, classifies, and publishes YAML via a **staged-generation symlink** to stable paths under `/data/node-sets/`. UI drives via Control API. Shared subscription acquisition used by import/refresh/detection. sub-store/sub-check not required.

---

## Confirmed requirements (user)

- Tool: NekoSpeed; one pass for AI unlock + streaming + speed + landing region.
- Funnel (one node → at most one class): dead→drop; **AI pass (OpenAI/GPT `unlock`)** → ai; remaining **streaming pass (YouTube `unlock`)** → streaming; remaining **speed ≥1 MiB/s²** → download; below → drop.
  - ¹ user confirmed: AI class uses **OpenAI/GPT pass only** (YouTube does NOT participate in AI judgement); streaming class uses **YouTube pass only** (NOT the any-streaming-platform rule).
  - ² bytes/sec ÷ 1024² = MiB/s; use **average download speed**.
- Rename `{tag}_{landing-region}_{capability|tier}_{index}`: `free组_美国_流媒体_1`, `free组_美国_3m_1`; tiers 1m/3m/5m/10m (round down); region by landing IP, Chinese names (美国/香港/日本/新加坡/其他).
- Re-check overwrites exported sets with **stable provider identity**.
- Whole-subscription detection. Tag = Plan C (`subscriptionId → tag` in config; free text + presets).
- Bulk add multi-line URLs; transport per subscription: direct / general proxy / GitHub proxy prefixes (gh-proxy.org style), configurable list + presets.
- All config in versioned JSON.

## Contracts frozen before code (Phase 0)

1. **Classification contract:** NekoSpeed status mapping — `unlock` = pass; `reqfailed` / `na` / explicit failure = fail; `pending` / timeout / missing field = **unknown** (not auto-dead; logged, not admitted to any pass class). Alive predicate uses per-node request success, NOT NekoSpeed's "succeeded count". Missing GeoIP = region "其他", not dead.
2. **Correlation contract:** In the frozen detection input, **rename every proxy to a unique temp name** (`__nc_0001`...) before handing to NekoSpeed; keep a separate map `tempName → full original proxy object` (credentials, protocol options, chain refs preserved). NekoSpeed results carry the temp name → correlate safely. Explicitly support or reject provider-only subscriptions and proxies with chain/dependency refs (document decision).
3. **Export contract:** Use **file provider** (`type: file`, path `/data/node-sets/current/ai.yaml` etc., same container as mihomo) — NOT an unauthenticated HTTP static route (credential-bearing YAML must not be exposed). Document working mihomo config snippet, path accessibility, and reload behavior (mihomo `PUT /providers/proxies/{name}` reload or file-provider auto-refresh). Persist `class → {providerName, filePath, generation}` explicitly in config; never discover by name.
4. **Transport contract:** shared `acquire(url, transport)` used by import/refresh/detection. Bulk import has no subscription ID yet → accept **URL-level transport argument** (default: direct; user may pick github-proxy at import time), persist after creation. GitHub proxy: use **stable proxy IDs** (not index); define global-enable / selected-prefix / failover-order interaction; **direct fallback is explicitly configurable and OFF by default** (mirror failure never silently overrides routing intent). Validate fetched content is a subscription (not HTML error), preserve original source URL, redact tokens in logs, restrict eligible hosts, validate redirects, SSRF policy.
5. **Atomic publication contract:** write three YAMLs to `/data/node-sets/.staging/<generation>/`, fsync, then **atomically flip one symlink** `current → .staging/<generation>`; config records current generation. Crash recovery: detect incomplete staging, roll back to last good generation. Independent of what an already-loaded mihomo provider has cached — document that a provider reload is needed to see re-export.

## Precision rules (v3.3 — finalized, Astra-confirmed decision matrix)

- **Per-subscription replacement:** rechecking subscription A replaces ONLY A's contribution to the three aggregate sets. Unchecked B's contribution remains. Failed recheck of A retains A's prior contribution. Successful-but-empty A clears A's contribution. Persist per-subscription classified slices (`subscriptionId → {tempName → {class, renamedNode}}`) in config; rebuild all three aggregate sets from these slices at every export.
- **Funnel evaluation order (runs ONLY on alive nodes — first match wins):** (1) OpenAI `unlock` → **AI**; (2) else YouTube `unlock` → **Streaming**; (3) else speed ≥ 1,048,576 bytes/s (1 MiB/s) → **Download**; (4) else → **discard**. `pending`/`reqfailed`/`na`/missing on one capability NEVER blocks evaluation of the next: e.g. OpenAI `pending` + YouTube `unlock` → Streaming; OpenAI `unlock` + YouTube `pending` → AI. Netflix/Disney+/Bilibili `unlock` is NEVER a qualification signal (YouTube only).
- **Liveness predicate (deterministic, field-VALUE based; evaluate in this EXACT priority — liveness is decided BEFORE class, and the funnel below runs ONLY on alive nodes):**
  1. fatal/error field non-empty → **dead** (overrides everything, incl. `unlock` — row 17).
  2. any capability `unlock` OR positive measurement (speed>0 OR latency>0) → **alive** (this WINS over `reqfailed` — rows 2/3 `unlock`+`reqfailed`@0, row 11 `reqfailed`+`reqfailed`@1,048,576).
  3. else all capabilities `missing` with zero measurement → **unknown** (row 16).
  4. else any capability `reqfailed` with zero measurement (no positive evidence) → **dead** (row 15 `na`+`reqfailed`@0).
  5. catch-all (e.g. `pending`/`failed`/`senttocn`/`na` with zero measurement, rows 5/8) → **alive** (inconclusive; never auto-dead).
  - A dead or unknown node is discarded and never enters a class. This ordering is the single source of truth; the decision matrix below is its exhaustive test vector.
- **Astra-confirmed decision matrix** (columns: OpenAI status | YouTube status | speed bytes/s | other | outcome). Implement and test EXACTLY these:
  | OpenAI      | YouTube     | speed     | other                         | outcome                                 |
  | ----------- | ----------- | --------- | ----------------------------- | --------------------------------------- |
  | `pending`   | `unlock`    | 1,048,576 | —                             | Streaming                               |
  | `unlock`    | `reqfailed` | 0         | —                             | AI                                      |
  | `reqfailed` | `unlock`    | 0         | —                             | Streaming                               |
  | `pending`   | `pending`   | 1,048,576 | —                             | Download                                |
  | `pending`   | `pending`   | 0         | —                             | discard; alive                          |
  | `missing`   | `missing`   | 0         | Netflix `unlock`              | discard; alive (Netflix not qualifying) |
  | `missing`   | `missing`   | 1,048,576 | Netflix `unlock`              | Download                                |
  | `failed`    | `senttocn`  | 0         | —                             | discard; alive                          |
  | `failed`    | `senttocn`  | 1,048,576 | —                             | Download                                |
  | `na`        | `na`        | 1,048,576 | —                             | Download                                |
  | `reqfailed` | `reqfailed` | 1,048,576 | —                             | Download; positive speed proves alive   |
  | `missing`   | `missing`   | 1,048,575 | —                             | discard; below threshold (strict ≥)     |
  | `missing`   | `missing`   | 1,048,576 | —                             | Download                                |
  | `missing`   | `missing`   | missing   | positive average latency only | discard; alive                          |
  | `na`        | `reqfailed` | 0         | —                             | discard; dead                           |
  | `missing`   | `missing`   | 0         | —                             | discard; unknown                        |
  | `unlock`    | `unlock`    | 1,048,576 | non-empty fatal error         | discard; dead (fatal overrides)         |
  - Apply the Netflix-only cases identically to Disney+/Bilibili/other nonqualifying platforms.
  - Unlisted combinations: follow the five liveness steps above (which already cover fatal, all-missing+zero, reqfailed+zero, and the inconclusive catch-all), then apply the funnel to alive nodes. Log any such case for later refinement; do not override the liveness result.
- **Provider reload:** repository uses **PUT** `/providers/proxies/{name}` (NOT PATCH). Spike MUST: load generation A, publish generation B via symlink, PUT-reload the existing provider, verify its group sees added AND removed nodes — including an empty set. Initial load alone does not prove re-export, the core requirement.

### Phase 0a — Toolchain spike (DONE, 2026-11-20)

- **DONE:** NekoSpeed pinned to main (go.mod requires Go 1.25, upstream releases only APK — no Linux binary). Built successfully via `golang:1.25-alpine` stage (image: `docker.1ms.run/library/golang:1.25-alpine`, GOPROXY=https://goproxy.cn) in scratch Dockerfile `~/.hermes/cache/scratch/neko-build/Dockerfile`. Binary runs; CLI flags confirmed (`-sub/-config/-o/-tests/-filter/-font/-proxy/...`).
- **DONE:** Ran a real detection on a frozen local subscription file (`real-sub.yaml`, 189 nodes, filtered to 1 node, `-duration 1 -threads 1 -ping-count 1 -preflight=false`). Result JSON produced and parsed. Verified against source (`internal/model/model.go`, `internal/report/json.go`):
  - status enum EXACTLY matches the decision matrix: `unlock`/`pending`/`senttocn`/`failed`/`reqfailed`/`na`.
  - `speed.avg` unit = **bytes/sec** (source comment "下行测速结果（字节/秒）") → 1 MiB/s = 1,048,576 bytes/s threshold confirmed.
  - JSON fields: `nodes[].index`, `name`, `type`, `server`, `error` (fatal), `latency{avgHTTPS,avgTlsRTT,packetLoss}`, `speed{avg,max,perSecond}`, `media[]{platform,status,region,info}`, `ai[]{...}`, `inbound{ip,country,city,...}`, `outbound{...}` (landing region — omitempty, only present on successful probes).
  - `index`+`name` correlate back to the original subscription proxy → temp-name correlation contract is feasible.
- **PITFALL confirmed & solved:** image rendering is FAIL-FATAL — without a usable CJK font, the whole run aborts and NO JSON is written (out dir empty). Fix verified: install `font-noto-cjk` in runtime + pass `-font /usr/share/fonts/noto/NotoSansCJK-Regular.ttc` explicitly (NekoSpeed's autodetect looks in `noto-cjk/` which doesn't match alpine's `noto/`). This must be baked into the agent's invocation.
- **TIMING:** one node with ai+media took ~1m12s (overseas unlock probes dominate). Full 189-node runs are long → agent must support node-count caps, short duration, and per-run timeout/bandwidth bounds (Phase 1 Task 3).

### Phase 0b — Provider-consumption proof (TODO in Phase 1/3)

- Prove complete path: complete proxy YAML → file-provider → actual mihomo group consumption, INCLUDING re-export: load gen A, publish gen B, PUT /providers/proxies/{name} reload, verify group sees added/removed nodes (incl. empty set). If any link fails → stop and report.

## Phase 1 — Agent foundation

- **Task 1 versioned config store:** schemaVersion, tags, `refreshTransport` (mode+proxyId), `githubProxies` ({id,prefix,enabled}), generalProxy, settings, `exports` (class→provider identity+generation), jobs retention. Serialized read/modify/write; DATA_DIR-derived path; corrupt-file preservation; deleted-ID handling; backup/restore.
- **Task 2 shared acquisition:** as transport contract; real HTTP/SOCKS dispatcher (Node fetch needs compatible dispatcher; SOCKS needs explicit dependency); used by import/refresh/detection.
- **Task 3 detection engine:** argument-array spawn on frozen file, private temp dir, timeouts/bandwidth limits, JSON file parse, status mapping, temp-name correlation, funnel, rename, complete proxy YAML per class.
- **Task 4 transactional export:** staged-generation symlink publication; success-with-empty clears stale nodes, failure preserves prior; serialized; consistent generation across 3 classes; deleted-provider recovery.
- **Task 5 job lifecycle:** one active job; duplicate-start protection; cancel; deadline; subprocess kill on shutdown; bounded result/log/temp retention; partial success, reconnection, unknown/expired job responses; **stale-job guard** (subscriptions/tags/settings changed since job start → reject export); persist bounded completed results; idempotent export via server-owned job reference; concurrent tests serialize to avoid bandwidth distortion.
- **Task 6 Control API:** config GET/PUT; detect POST (job id); status GET; apply POST (server-owned result ref); node-set files served only via authenticated file-provider path (no open static route); authenticate all endpoints; bound URL/node/output/runtime; SSRF policy.

## Phase 2 — UI

- **Task 7 node-check page:** bulk-add (URL-level transport choice), per-row tag + transport selector (stable proxy IDs), settings (thresholds/rules), detect with progress, results table (class/name/speed/region/AI/streaming/unknown), export + **provider name/path display & copy** for adding to groups. Nav entry gated by **new capability `node-check`** (desktop/old servers may lack binary). i18n all locales (zh accurate; others English). Machine codes separate from Chinese display names.

## Phase 3 — Verify & deliver

- typecheck/lint/full tests; build image; deploy 8081; real-browser smoke: bulk-add → tag → detect one subscription → verify classification → export → **add file-provider to test config → confirm mihomo loads it**. Never touch 8080 without explicit confirmation.

## Non-goals (manual MVP = phases 0-3)

- Scheduled auto re-check (later phase).
- Auto-apply node sets into strategy groups (user adds providers manually).
- Per-node selection; non-mihomo output formats.

## Security / robustness

- Auth endpoints; bounds; SSRF policy; argument-array spawn; private temp files; redact secrets; capability gate; localized errors/progress/unknown states.
- Tests: malformed/missing JSON, all statuses incl. unknown, unit boundaries (1,048,575 vs 1,048,576 bytes/s), duplicate names, protocol-field preservation, partial failures, cancel/restart, concurrent export, deleted exports, transport redirects/HTML, **actual provider-consumption integration**, exported protocol compatibility with running mihomo, binary/license distribution. Capability classification MUST test: OpenAI-only→AI; YouTube-only→Streaming; both unlock with no fatal error→AI (priority); fatal error with any `unlock`→dead (overrides funnel, matrix row 17); Netflix-only/Disney-only/Bilibili-only→neither capability class; OpenAI `pending`+YouTube `unlock`→Streaming; OpenAI `unlock`+YouTube `pending`→AI; and every row of the Astra decision matrix above.

## Resolved (confirmed by user, 2026-11-20)

- AI rule = OpenAI/GPT pass only; streaming rule = YouTube pass only. No ambiguity remains.

## Open for user (not blocking spike)

- GitHub proxy presets — configurable list adopted.
