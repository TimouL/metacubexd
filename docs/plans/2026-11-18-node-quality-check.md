# Subscription Quality Check & Node Classification — Implementation Plan (v3.2, finalized)

> **Status:** v3.2 finalized — incorporates multiple rounds of Codex (auto/gpt-6-astra) review. NOT executed — awaiting user confirmation to start Phase 0 spike.

**Goal:** Panel-driven: bulk-add/tag subscriptions → one-pass NekoSpeed quality/speed/landing-region check → funnel classification (AI → streaming → download) → export each class as a **mihomo-consumable proxy-provider file** for fallback / download groups.

**Architecture:** Versioned config in `/data/node-check-config.json` (path from DATA_DIR). Agent orchestrates pinned NekoSpeed, correlates results to a **frozen full-proxy snapshot by unique temporary names**, classifies, and publishes YAML via a **staged-generation symlink** to stable paths under `/data/node-sets/`. UI drives via Control API. Shared subscription acquisition used by import/refresh/detection. sub-store/sub-check not required.

---

## Confirmed requirements (user)

- Tool: NekoSpeed; one pass for AI unlock + streaming + speed + landing region.
- Funnel (one node → at most one class): dead→drop; **AI pass (OpenAI AND YouTube both pass¹)** → ai; remaining **streaming pass (Netflix/YouTube/Disney+/Bilibili any)** → streaming; remaining **speed ≥1 MiB/s²** → download; below → drop.
  - ¹ user said "GPT YouTube 能过就行" — interpreted as **both OpenAI and YouTube must pass** for the AI class. Flagged for final user confirmation (ambiguous phrasing).
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

## Precision rules (v3.2 — finalized, deterministic)

- **Per-subscription replacement:** rechecking subscription A replaces ONLY A's contribution to the three aggregate sets. Unchecked B's contribution remains. Failed recheck of A retains A's prior contribution. Successful-but-empty A clears A's contribution. Persist per-subscription classified slices (`subscriptionId → {tempName → {class, renamedNode}}`) in config; rebuild all three aggregate sets from these slices at every export.
- **Deterministic alive/dead/unknown predicate** (field-VALUE based; no "if available"; evaluated per node in this priority order):
  1. fatal/error field non-empty (e.g. dial failure) → **dead**.
  2. any platform status == `unlock` → **alive** (a successful probe proves reachability).
  3. measured speed (bytes/s) > 0 → **alive**.
  4. measured latency > 0 → **alive**.
  5. all platform statuses ∈ {`reqfailed`,`na`,`pending`,missing} AND speed==0 AND latency==0:
     - all `reqfailed` → **dead**;
     - any `na` with at least one other platform measured → **alive**;
     - all `na` or all missing → **unknown** (discard, log, never enter a pass class).
  6. fallback when the report lacks a timeout-vs-rejection distinction: `reqfailed` with no positive measurement → **dead** (rule 5); no special-case needed.
  - Capability status: `unlock` = pass; `reqfailed`/`na`/missing = not pass (`na` = not applicable ≠ pass); `pending` = unknown (never passes, never overrides another platform's pass).
  - Mixed platforms: streaming pass = **any** of Netflix/YouTube/Disney+/Bilibili `unlock` (Netflix `pending` + YouTube `unlock` → streaming pass). AI pass = OpenAI `unlock` AND YouTube `unlock` (strict rule, flagged for user confirmation).
  - Outcome table: all-zero→unknown/discard; all-reqfailed→dead/discard; na-with-speed→alive→download; missing-field→unknown on that dimension but alive if any positive measurement; fatal-error→dead; pending-capability-with-good-speed→alive, download set only, never ai/streaming.
- **Provider reload:** repository uses **PUT** `/providers/proxies/{name}` (NOT PATCH). Spike MUST: load generation A, publish generation B via symlink, PUT-reload the existing provider, verify its group sees added AND removed nodes — including an empty set. Initial load alone does not prove re-export, the core requirement.

## Phase 0 — Feasibility spike (gated, before any product code)

- Pin NekoSpeed revision + Go 1.25 toolchain; plan Go build stage (upstream ships APK assets, not Linux binaries).
- Run ONE real detection on a frozen local subscription file; **require**: successful report generation (image-render-first must not block JSON — patched or worked around), JSON file located and parsed, all contract fields present, and **full-object correlation via temp names proven**. Merely `nekospeed -h` or field presence is NOT a pass.
- Prove complete path: detection → complete proxy YAML → file-provider → actual mihomo group consumption, INCLUDING re-export: load gen A, publish gen B, PUT /providers/proxies/{name} reload, verify group sees added/removed nodes (incl. empty set). If any link fails → stop and report.

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
- Tests: malformed/missing JSON, all statuses incl. unknown, unit boundaries, duplicate names, protocol-field preservation, partial failures, cancel/restart, concurrent export, deleted exports, transport redirects/HTML, **actual provider-consumption integration**, exported protocol compatibility with running mihomo, binary/license distribution.

## Open for user (not blocking spike)

- Confirm strict AI rule (OpenAI AND YouTube) — flagged ambiguity.
- GitHub proxy presets — configurable list adopted.
