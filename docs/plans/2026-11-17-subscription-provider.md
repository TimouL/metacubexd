# Subscription Provider Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users turn an existing remote profile or manually entered subscription URL into a mihomo HTTP proxy-provider from the local profile editor.

**Architecture:** Put the YAML mutation in `@metacubexd/config-editor` so it reuses validated document parsing, untouched-section preservation, diagnostics, and deterministic serialization. The UI adds one modal-backed component to the profile editor, lists remote profiles through the existing `/profiles` contract, applies the transform to the current draft, and leaves activation unchanged.

**Tech Stack:** TypeScript, Vue 3/Nuxt, `yaml`-backed `config-editor`, existing Control API, existing i18n and test setup.

### Task 1: AST-safe provider transform

**Files:**

- Modify: `packages/config-editor/src/index.ts`
- Test: `packages/config-editor/src/subscription-provider.test.ts`

1. Write failing tests for creating a provider, adding it to every eligible group, generating unique names, treating the same URL idempotently, preserving untouched comments, and rejecting invalid YAML.
2. Run `pnpm --filter @metacubexd/config-editor test -- src/subscription-provider.test.ts` and verify each new test fails because the API is missing.
3. Implement `addSubscriptionProxyProvider` using `openDocument`, `replaceDocumentData`, and plain JSON-compatible config values.
4. Re-run the focused test, then package typecheck and tests.
5. Commit `feat: add subscription provider transform`.

### Task 2: subscription selector UI

**Files:**

- Create: `packages/ui/components/SubscriptionProviderPicker.vue`
- Modify: `packages/ui/pages/profiles/[id]/edit.vue`
- Modify: `packages/ui/i18n/locales/en.json`
- Modify: `packages/ui/i18n/locales/zh.json`
- Test: `packages/ui/components/__tests__/SubscriptionProviderPicker.spec.ts`

1. Write failing component tests for remote-only listing, traffic/expiry formatting, unavailable metadata, manual URL validation, and emitted selection.
2. Run the focused UI test and verify it fails because the component is missing.
3. Implement the picker using existing modal/button conventions and `byte-size`/`dayjs`; manually entered URLs default to a safe provider label derived from their hostname.
4. Wire a header action and modal into the editor. Applying a selection parses the current YAML, calls the transform, updates `documentState`, `configData`, and `yamlText`, switches to YAML mode so Monaco immediately shows the result, and reports success or parse/list errors.
5. Run focused tests, UI typecheck, and lint.
6. Commit `feat: add subscription provider picker`.

### Task 3: full verification

**Files:**

- No production files unless verification exposes a defect.

1. Run `pnpm typecheck`.
2. Run `pnpm lint`.
3. Run focused unit tests and the `config-editor` package tests.
4. Run the repository's server image build command without contacting or replacing the running 8080 container.
5. Commit any verification fixes separately.

**Decisions already made:**

- Existing `select` and `url-test` groups all receive the provider in `use`; this maximizes usefulness without inventing a routing policy.
- A provider with the same URL is reused idempotently, while still ensuring eligible groups reference it.
- Manual URL provider names derive from the URL hostname and remain editable by the resulting YAML before saving.
