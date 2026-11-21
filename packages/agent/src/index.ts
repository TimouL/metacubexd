import type { ApplyResult } from './node-check/jobs'
import type { ScriptRunner } from './script'
import type { CreateSupervisorOptions } from './supervisor'
import type {
  KernelManager,
  SystemProxyController,
  TunController,
} from './types'
import { createControlRouter } from './http'
import { MIHOMO_VERSION } from './kernel/assets'
import { acquire as acquireNodeCheckSubscription } from './node-check/acquire'
import { createNodeCheckConfigStore } from './node-check/config'
import { runDetection } from './node-check/detect'
import { exportNodeSets } from './node-check/export'
import { createJobManager } from './node-check/jobs'
import { createProfileConfigEditor } from './profile-editor'
import { createProfileStore } from './profiles'
import { applyActiveRefresh } from './refresh-apply'
import { createProfileScheduler } from './scheduler'
import { createScriptRunner } from './script'
import { createSupervisor } from './supervisor'

async function getNodeCheckJobResult(
  store: ReturnType<typeof createNodeCheckConfigStore>,
  resultId: string,
): Promise<ApplyResult> {
  const jobs = createJobManager({ configStore: store })
  const result = await jobs.getResult(resultId)
  if (!result) throw new Error(`Node-check result ${resultId} is unavailable`)
  return result as unknown as ApplyResult
}

export const AGENT_VERSION = '0.0.0'

export { createControlRouter } from './http'
export type { ControlRouterDeps } from './http'
export { MIHOMO_VERSION, mihomoAsset } from './kernel/assets'
export { fetchKernel, listMihomoVersions } from './kernel/fetch-kernel'
export { fetchGeoAssets, GEO_ASSET_URLS } from './kernel/geo'
export { mergeConfigs } from './merge'
export {
  createProfileConfigEditor,
  ProfileEditorConflictError,
  ProfileEditorValidationError,
} from './profile-editor'
export type {
  ProfileConfigEditor,
  ProfileConfigEditorOptions,
  ProfileEditorApplyResult,
  ProfileEditorPreview,
  ProfileEditorSnapshot,
} from './profile-editor'
export { createProfileStore } from './profiles'
export { applyActiveRefresh } from './refresh-apply'
export type { ApplyActiveRefreshOptions } from './refresh-apply'
export { createProfileScheduler } from './scheduler'
export type {
  ProfileRefreshResult,
  ProfileScheduler,
  ProfileSchedulerDeps,
} from './scheduler'
export { createScriptRunner } from './script'
export type {
  CreateScriptRunnerOptions,
  ScriptRun,
  ScriptRunner,
} from './script'
export { createSupervisor } from './supervisor'
export type { CreateSupervisorOptions, SupervisorDeps } from './supervisor'
export { buildTunConfig, TunPreconditionError } from './tun'
export * from './types'
export { createWebdavClient } from './webdav'
export type { WebdavClient, WebdavClientOptions } from './webdav'

export type CreateAgentOptions = CreateSupervisorOptions & {
  profilesDir: string
  agentToken?: string
  // Runs enabled 'script' profiles during composition. Defaults to a real
  // worker-backed runner; tests inject a fake to avoid spawning workers.
  scriptRunner?: ScriptRunner
  systemProxy?: SystemProxyController // OS proxy controller; enables 'system-proxy'
  kernelManager?: KernelManager // kernel version mgmt; enables 'kernel-version'
  tunController?: TunController // TUN mode controller; enables 'tun'
  // Optional binary/font paths for the bundled node-quality checker. When set,
  // the agent advertises 'node-check' and mounts its control routes.
  nodeCheckBinaryPath?: string
  nodeCheckFontPath?: string
  nodeCheckGeneralProxy?: string
  nodeCheckGithubProxies?: import('./node-check/config').GithubProxy[]
  nodeCheckCreateDispatcher?: import('./node-check/acquire').DispatcherFactory
}

export interface AgentInfo {
  hasAgent: true
  version: string
  platform: { os: string; arch: string }
  kernel: { bundled: boolean; path: string; version?: string }
  features: string[]
}

export function createAgent(opts: CreateAgentOptions) {
  const nodeCheckConfigStore =
    opts.nodeCheckBinaryPath === undefined
      ? undefined
      : createNodeCheckConfigStore({ dir: opts.homeDir })
  if (nodeCheckConfigStore) {
    void nodeCheckConfigStore.writeConfig((current) => {
      if (opts.nodeCheckGeneralProxy !== undefined) {
        current.generalProxy = opts.nodeCheckGeneralProxy
      }
      if (opts.nodeCheckGithubProxies !== undefined) {
        current.githubProxies = structuredClone(opts.nodeCheckGithubProxies)
      }
    })
  }
  const nodeCheckConfig = nodeCheckConfigStore
    ? {
        configStore: nodeCheckConfigStore,
        acquire: (
          url: string,
          transport: import('./node-check/config').RefreshTransport,
        ) =>
          acquireNodeCheckSubscription(url, transport, {
            configStore: nodeCheckConfigStore,
            ...(opts.nodeCheckCreateDispatcher
              ? { createDispatcher: opts.nodeCheckCreateDispatcher }
              : {}),
          }),
        exportNodeSets,
        jobManager: createJobManager({
          dir: opts.homeDir,
          configStore: nodeCheckConfigStore,
          apply: (resultId) =>
            getNodeCheckJobResult(nodeCheckConfigStore, resultId),
          detect: (content, detectOpts) =>
            runDetection(content, {
              ...detectOpts,
              ...(opts.nodeCheckFontPath
                ? { fontPath: opts.nodeCheckFontPath }
                : {}),
            }),
        }),
      }
    : undefined
  const profiles = createProfileStore({
    dir: opts.profilesDir,
    activeConfigPath: opts.activeConfigPath,
    // Without a runner, script profiles are silently skipped during compose —
    // the user's script transforms never apply. Default to a real one so the
    // feature works across every Runtime Form (server/desktop) out of the box.
    scriptRunner: opts.scriptRunner ?? createScriptRunner(),
  })
  const supervisor = createSupervisor(opts)
  const profileEditor = createProfileConfigEditor({
    profiles,
    supervisor,
    homeDir: opts.homeDir,
  })
  const { systemProxy, kernelManager, tunController } = opts
  const info = (): AgentInfo => ({
    hasAgent: true,
    version: AGENT_VERSION,
    platform: { os: process.platform, arch: process.arch },
    kernel: {
      bundled: true,
      path: opts.binaryPath,
      // Fall back to the bundled kernel's version when the supervisor has not
      // observed a running kernel yet (fresh launch / stopped without ever
      // starting). Otherwise the dashboard shows "-" for the kernel version
      // until the kernel runs once, even though the bundled version is known.
      version: supervisor.getState().version ?? MIHOMO_VERSION,
    },
    features: [
      'profiles',
      'logs-sse',
      'kernel-control',
      // homeDir always exists, so geo-asset download is always available.
      'geo-assets',
      // WebDAV backup/restore is always available — credentials arrive per-request.
      'webdav-backup',
      // Runtime config viewer reads the activeConfigPath file — always available.
      'runtime-config',
      // Config-section editor reads/writes top-level keys of the active profile.
      'config-sections',
      'visual-config-editor',
      ...(systemProxy ? ['system-proxy'] : []),
      ...(kernelManager ? ['kernel-version'] : []),
      ...(tunController ? ['tun'] : []),
      ...(nodeCheckConfig ? ['node-check'] : []),
    ],
  })
  const router = createControlRouter({
    supervisor,
    profiles,
    profileEditor,
    info,
    homeDir: opts.homeDir,
    activeConfigPath: opts.activeConfigPath,
    token: opts.agentToken,
    systemProxy,
    kernelManager,
    tunController,
    nodeCheck: nodeCheckConfig,
  })
  // Wire the auto-update scheduler to the same profiles store. NOT started here
  // — the server boot plugin starts it (the desktop builds its own scheduler so
  // it can surface per-refresh notifications, and does NOT start this one).
  //
  // Validate and conditionally apply the active subscription before completing
  // its refresh result. The scheduler awaits this work and isolates failures.
  const scheduler = createProfileScheduler({
    profiles,
    apply: (id) =>
      applyActiveRefresh(profiles, supervisor, id, { homeDir: opts.homeDir }),
  })
  return {
    supervisor,
    profiles,
    profileEditor,
    router,
    info,
    scheduler,
    systemProxy,
    kernelManager,
    tunController,
  }
}
