<script setup lang="ts">
import type {
  NodeCheckRefreshTransport,
  NodeCheckResultClass,
  ProfileMeta,
} from '~/types/control'
import {
  IconChecklist,
  IconClipboard,
  IconPlus,
  IconRefresh,
  IconTrash,
} from '@tabler/icons-vue'
import {
  githubProxyOptionLabel,
  NODE_CHECK_CLASSES,
  NODE_CHECK_RESULT_CLASSES,
  NODE_CHECK_TRANSPORT_MODES,
  useNodeCheck,
} from '~/composables/useNodeCheck'

const { t } = useI18n()
const { hasFeature, ready } = useControlInfo()
const {
  config,
  configLoading,
  configSaving,
  importing,
  starting,
  applying,
  job,
  applyResult,
  bulkText,
  bulkTransport,
  bulkErrors,
  selectedSubscriptionIds,
  classFilter,
  resultQuery,
  remoteProfiles,
  enabledGithubProxies,
  progress,
  running,
  filteredNodes,
  resultCounts,
  resultProviderSnippet,
  load,
  setTag,
  setTransport,
  addGithubProxy,
  updateGithubProxy,
  removeGithubProxy,
  addSubscriptions,
  startDetection,
  apply,
  copyText,
} = useNodeCheck()

useHead({ title: computed(() => t('nodeCheck')) })

onMounted(() => {
  if (hasFeature('node-check')) void load()
})

const available = computed(() => hasFeature('node-check'))
const canApply = computed(() => job.value?.state === 'completed')

const transportLabel = (mode: NodeCheckRefreshTransport['mode']) =>
  t(`nodeCheckTransport${mode}`)

const classLabel = (nodeClass: NodeCheckResultClass | 'all') =>
  nodeClass === 'all' ? t('all') : t(`nodeCheckClass${nodeClass}`)

const statusLabel = (value: string | undefined) => value || '-'

const toggleSubscription = (id: string, event: Event) => {
  const checked = (event.target as HTMLInputElement).checked
  selectedSubscriptionIds.value = checked
    ? [...selectedSubscriptionIds.value, id]
    : selectedSubscriptionIds.value.filter((value) => value !== id)
}

const onTransportChange = (id: string, event: Event) => {
  const mode = (event.target as HTMLSelectElement)
    .value as NodeCheckRefreshTransport['mode']
  void setTransport(id, { mode })
}

const onGithubProxyChange = (profile: ProfileMeta, event: Event) => {
  const proxyId = (event.target as HTMLSelectElement).value || undefined
  void setTransport(profile.id, { mode: 'githubProxy', proxyId })
}

const onTagBlur = (profile: ProfileMeta, event: FocusEvent) => {
  const target = event.target as HTMLInputElement | null
  const tag = target?.value.trim() ?? ''
  if (tag === (config.value?.tags[profile.id] ?? '')) return
  void setTag(profile.id, tag)
}
</script>

<template>
  <div v-if="!ready" class="flex flex-1 items-center justify-center">
    <span class="loading loading-md loading-spinner" />
  </div>
  <div v-else-if="!available" class="alert alert-warning">
    <span>{{ t('nodeCheckUnavailable') }}</span>
  </div>
  <div v-else class="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pb-8">
    <div class="flex items-center justify-between gap-3">
      <div>
        <h1 class="text-xl font-semibold">{{ t('nodeCheck') }}</h1>
        <p class="text-sm opacity-60">{{ t('nodeCheckDescription') }}</p>
      </div>
      <button class="btn btn-ghost btn-sm" @click="load">
        <IconRefresh class="h-4 w-4" />
        {{ t('refresh') }}
      </button>
    </div>

    <section class="card bg-base-200 shadow-sm">
      <div class="card-body gap-3">
        <h2 class="card-title text-base">{{ t('nodeCheckSubscriptions') }}</h2>
        <textarea
          v-model="bulkText"
          class="textarea-bordered textarea h-28 w-full font-mono text-xs"
          :placeholder="t('nodeCheckBulkPlaceholder')"
        />
        <div v-if="bulkErrors.length" class="text-xs text-error">
          {{ t('nodeCheckBulkInvalid') }}: {{ bulkErrors.join(', ') }}
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <select
            v-model="bulkTransport"
            class="select-bordered select select-sm"
          >
            <option value="direct">{{ t('nodeCheckTransportDirect') }}</option>
            <option value="githubProxy">
              {{ t('nodeCheckTransportGithubProxy') }}
            </option>
          </select>
          <button
            class="btn btn-primary btn-sm"
            :disabled="importing || !bulkText.trim()"
            @click="addSubscriptions"
          >
            <IconPlus class="h-4 w-4" />
            {{ importing ? t('nodeCheckImporting') : t('nodeCheckBulkAdd') }}
          </button>
        </div>

        <div v-if="configLoading" class="py-4 text-center">
          <span class="loading loading-sm loading-spinner" />
        </div>
        <div v-else class="overflow-x-auto">
          <table class="table w-full table-sm">
            <thead>
              <tr>
                <th>{{ t('nodeCheckSelect') }}</th>
                <th>{{ t('name') }}</th>
                <th>{{ t('nodeCheckTag') }}</th>
                <th>{{ t('nodeCheckTransport') }}</th>
                <th>{{ t('nodeCheckGithubProxy') }}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <tr v-for="profile in remoteProfiles" :key="profile.id">
                <td>
                  <input
                    type="checkbox"
                    class="checkbox checkbox-sm"
                    :checked="selectedSubscriptionIds.includes(profile.id)"
                    @change="toggleSubscription(profile.id, $event)"
                  />
                </td>
                <td class="max-w-64 truncate" :title="profile.url">
                  {{ profile.name }}
                </td>
                <td>
                  <input
                    class="input-bordered input w-32 input-xs"
                    :value="config?.tags[profile.id] ?? ''"
                    :placeholder="t('nodeCheckTagPlaceholder')"
                    @blur="onTagBlur(profile, $event)"
                  />
                </td>
                <td>
                  <select
                    class="select-bordered select select-xs"
                    :value="
                      config?.refreshTransport[profile.id]?.mode ?? 'direct'
                    "
                    @change="onTransportChange(profile.id, $event)"
                  >
                    <option
                      v-for="mode in NODE_CHECK_TRANSPORT_MODES"
                      :key="mode"
                      :value="mode"
                    >
                      {{ transportLabel(mode) }}
                    </option>
                  </select>
                </td>
                <td>
                  <select
                    v-if="
                      config?.refreshTransport[profile.id]?.mode ===
                      'githubProxy'
                    "
                    class="select-bordered select max-w-48 select-xs"
                    :value="config?.refreshTransport[profile.id]?.proxyId ?? ''"
                    @change="onGithubProxyChange(profile, $event)"
                  >
                    <option value="">{{ t('nodeCheckAuto') }}</option>
                    <option
                      v-for="proxy in enabledGithubProxies"
                      :key="proxy.id"
                      :value="proxy.id"
                    >
                      {{ githubProxyOptionLabel(proxy) }}
                    </option>
                  </select>
                </td>
                <td class="text-xs opacity-50">{{ profile.id }}</td>
              </tr>
              <tr v-if="remoteProfiles.length === 0">
                <td colspan="6" class="text-center opacity-60">
                  {{ t('nodeCheckNoSubscriptions') }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <section class="card bg-base-200 shadow-sm">
      <div class="card-body gap-3">
        <div class="flex items-center justify-between">
          <h2 class="card-title text-base">
            {{ t('nodeCheckGithubProxies') }}
          </h2>
          <button
            class="btn btn-outline btn-xs"
            :disabled="configSaving"
            @click="addGithubProxy"
          >
            <IconPlus class="h-3.5 w-3.5" />
            {{ t('add') }}
          </button>
        </div>
        <div
          v-for="proxy in config?.githubProxies ?? []"
          :key="proxy.id"
          class="flex flex-wrap items-center gap-2"
        >
          <input
            type="checkbox"
            class="toggle toggle-sm"
            :checked="proxy.enabled"
            :disabled="configSaving"
            @change="updateGithubProxy(proxy.id, { enabled: !proxy.enabled })"
          />
          <input
            class="input-bordered input min-w-0 flex-1 input-sm"
            :value="proxy.prefix"
            :placeholder="t('nodeCheckGithubProxyPlaceholder')"
            @blur="
              updateGithubProxy(proxy.id, {
                prefix: ($event.target as HTMLInputElement).value.trim(),
              })
            "
          />
          <span class="text-xs opacity-50">{{ proxy.id }}</span>
          <button
            class="btn btn-ghost text-error btn-xs"
            :disabled="configSaving"
            @click="removeGithubProxy(proxy.id)"
          >
            <IconTrash class="h-4 w-4" />
          </button>
        </div>
        <p v-if="(config?.githubProxies.length ?? 0) === 0" class="opacity-60">
          {{ t('nodeCheckNoGithubProxies') }}
        </p>
      </div>
    </section>

    <section class="card bg-base-200 shadow-sm">
      <div class="card-body gap-3">
        <h2 class="card-title text-base">{{ t('nodeCheckDetect') }}</h2>
        <div class="flex flex-wrap gap-3">
          <label
            v-for="profile in remoteProfiles"
            :key="profile.id"
            class="flex items-center gap-2 text-sm"
          >
            <input
              type="checkbox"
              class="checkbox checkbox-sm"
              :checked="selectedSubscriptionIds.includes(profile.id)"
              @change="toggleSubscription(profile.id, $event)"
            />
            <span>{{ profile.name }}</span>
          </label>
        </div>
        <p v-if="remoteProfiles.length === 0" class="opacity-60">
          {{ t('nodeCheckNoSubscriptions') }}
        </p>
        <div class="flex items-center gap-3">
          <button
            class="btn btn-primary btn-sm"
            :disabled="
              starting || running || selectedSubscriptionIds.length === 0
            "
            @click="startDetection"
          >
            <IconChecklist class="h-4 w-4" />
            {{ running ? t('nodeCheckDetecting') : t('nodeCheckStart') }}
          </button>
          <span v-if="job" class="text-xs opacity-60">{{ job.state }}</span>
        </div>
        <div v-if="job" class="flex items-center gap-3">
          <progress
            class="progress w-full progress-primary"
            :value="progress"
            max="100"
          />
          <span class="w-12 text-right text-xs">{{ progress }}%</span>
        </div>
      </div>
    </section>

    <section class="card bg-base-200 shadow-sm">
      <div class="card-body gap-3">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="card-title text-base">{{ t('nodeCheckResults') }}</h2>
          <button
            class="btn btn-outline btn-sm"
            :disabled="!canApply || applying"
            @click="apply"
          >
            {{ applying ? t('nodeCheckExporting') : t('nodeCheckExport') }}
          </button>
        </div>

        <div v-if="applyResult" class="rounded-lg bg-base-300 p-3 text-sm">
          <p class="font-medium">
            {{ t('nodeCheckProviderGeneration') }}:
            {{ applyResult.generation ?? '-' }}
          </p>
          <div
            v-for="nodeClass in NODE_CHECK_CLASSES"
            :key="nodeClass"
            class="mt-1 flex flex-wrap items-center gap-2 font-mono text-xs"
          >
            <span>{{ applyResult.providers[nodeClass]?.providerName }}</span>
            <span>{{ applyResult.providers[nodeClass]?.filePath }}</span>
            <button
              v-if="applyResult.providers[nodeClass]"
              class="btn btn-ghost btn-xs"
              @click="
                copyText(
                  `${applyResult.providers[nodeClass]!.providerName}\t${applyResult.providers[nodeClass]!.filePath}`,
                )
              "
            >
              <IconClipboard class="h-3.5 w-3.5" />
            </button>
          </div>
          <div class="mt-2 flex items-start gap-2">
            <pre class="flex-1 overflow-x-auto text-xs">{{
              resultProviderSnippet
            }}</pre>
            <button
              v-if="resultProviderSnippet"
              class="btn btn-ghost btn-xs"
              @click="copyText(resultProviderSnippet)"
            >
              <IconClipboard class="h-3.5 w-3.5" />
              {{ t('nodeCheckCopySnippet') }}
            </button>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <button
            v-for="nodeClass in ['all', ...NODE_CHECK_RESULT_CLASSES]"
            :key="nodeClass"
            class="btn btn-xs"
            :class="classFilter === nodeClass ? 'btn-primary' : 'btn-ghost'"
            @click="classFilter = nodeClass as NodeCheckResultClass | 'all'"
          >
            {{ classLabel(nodeClass as NodeCheckResultClass) }}
            ({{ resultCounts[nodeClass as keyof typeof resultCounts] }})
          </button>
          <input
            v-model="resultQuery"
            class="input-bordered input input-xs"
            :placeholder="t('nodeCheckResultSearch')"
          />
        </div>

        <div class="overflow-x-auto">
          <table class="table w-full table-sm">
            <thead>
              <tr>
                <th>{{ t('nodeCheckClass') }}</th>
                <th>{{ t('name') }}</th>
                <th>{{ t('nodeCheckSpeed') }}</th>
                <th>{{ t('nodeCheckRegion') }}</th>
                <th>AI</th>
                <th>{{ t('nodeCheckStreaming') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="node in filteredNodes"
                :key="`${node.index}-${node.name}`"
              >
                <td>{{ classLabel(node.class) }}</td>
                <td>{{ node.renamed ?? node.name }}</td>
                <td>
                  {{
                    node.speedMBs === undefined ? '-' : node.speedMBs.toFixed(2)
                  }}
                  MB/s
                </td>
                <td>{{ statusLabel(node.region) }}</td>
                <td>
                  {{
                    statusLabel(
                      node.ai.find((entry) => entry.status === 'unlock')
                        ?.status ?? node.ai[0]?.status,
                    )
                  }}
                </td>
                <td>
                  {{
                    statusLabel(
                      node.media.find((entry) =>
                        entry.platform.includes('outube'),
                      )?.status ?? node.media[0]?.status,
                    )
                  }}
                </td>
              </tr>
              <tr v-if="filteredNodes.length === 0">
                <td colspan="6" class="text-center opacity-60">
                  {{ t('nodeCheckNoResults') }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  </div>
</template>
