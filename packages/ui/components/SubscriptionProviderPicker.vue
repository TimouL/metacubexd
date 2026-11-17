<script setup lang="ts">
import type {
  SubscriptionProviderChoice,
  SubscriptionProviderSelection,
} from '~/utils/subscriptionProviders'
import { IconCloud, IconPlus } from '@tabler/icons-vue'
import {
  formatSubscriptionUsage,
  manualProviderName,
  subscriptionChoices,
  validSubscriptionUrl,
} from '~/utils/subscriptionProviders'

const emit = defineEmits<{
  select: [selection: SubscriptionProviderSelection]
}>()

const modal = ref<{ open: () => void; close: () => void }>()
const api = useControlApi()
const { t } = useI18n()
const loading = ref(false)
const loadError = ref('')
const choices = ref<SubscriptionProviderChoice[]>([])
const selectedId = ref('')
const manualUrl = ref('')

const manualValid = computed(() => validSubscriptionUrl(manualUrl.value))
const canSubmit = computed(
  () => (selectedId.value !== '' || manualValid.value) && !loading.value,
)

async function open() {
  loading.value = true
  loadError.value = ''
  selectedId.value = ''
  manualUrl.value = ''
  choices.value = []
  modal.value?.open()
  try {
    choices.value = subscriptionChoices(await api.listProfiles())
  } catch (error) {
    loadError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loading.value = false
  }
}

function close() {
  modal.value?.close()
}

function submit() {
  const choice = choices.value.find((item) => item.id === selectedId.value)
  const url = choice?.url ?? manualUrl.value.trim()
  if (!validSubscriptionUrl(url)) return
  const name = choice?.name ?? manualProviderName(url)
  emit('select', { name, url })
  close()
}

defineExpose({ open, close })
</script>

<template>
  <Modal ref="modal" :title="t('subscriptionProviderPickerTitle')" size="xl">
    <template #icon><IconCloud :size="20" /></template>

    <p class="text-sm text-base-content/60">
      {{ t('subscriptionProviderPickerDescription') }}
    </p>

    <div v-if="loading" class="py-8 text-center">
      <span class="loading loading-md loading-ring text-primary" />
    </div>
    <div
      v-else-if="loadError"
      class="mt-4 rounded-xl bg-error/10 p-3 text-sm text-error"
    >
      {{ loadError }}
    </div>

    <section class="mt-4">
      <h3 class="mb-2 text-sm font-semibold">
        {{ t('subscriptionProviderPickerExisting') }}
      </h3>
      <p
        v-if="!choices.length"
        class="rounded-xl bg-base-200 p-3 text-sm text-base-content/60"
      >
        {{ t('subscriptionProviderPickerEmpty') }}
      </p>
      <div v-else class="flex flex-col gap-2">
        <label
          v-for="choice in choices"
          :key="choice.id"
          class="flex cursor-pointer items-start gap-3 rounded-xl border p-3"
          :class="
            selectedId === choice.id
              ? 'border-primary bg-primary/10'
              : 'border-base-content/10 bg-base-100 hover:bg-base-200'
          "
        >
          <input
            v-model="selectedId"
            type="radio"
            name="subscription-provider"
            :value="choice.id"
            class="radio mt-0.5 radio-sm radio-primary"
            @change="manualUrl = ''"
          />
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-center gap-2">
              <span class="font-medium">{{ choice.name }}</span>
              <span class="truncate text-xs text-base-content/50">{{
                choice.url
              }}</span>
            </span>
            <span class="mt-1 block text-xs text-base-content/60">
              <template v-if="choice.subscriptionInfo">
                {{ formatSubscriptionUsage(choice.subscriptionInfo) }}
              </template>
              <template v-else>{{
                t('subscriptionProviderPickerNoUsage')
              }}</template>
            </span>
          </span>
        </label>
      </div>
    </section>

    <section class="mt-5">
      <h3 class="mb-2 text-sm font-semibold">
        {{ t('subscriptionProviderPickerManual') }}
      </h3>
      <input
        v-model="manualUrl"
        type="url"
        class="input-bordered input w-full"
        :placeholder="t('subscriptionProviderPickerManualPlaceholder')"
        @input="selectedId = ''"
      />
      <p v-if="manualUrl && !manualValid" class="mt-1 text-xs text-error">
        {{ t('subscriptionProviderPickerInvalidUrl') }}
      </p>
    </section>

    <template #actions>
      <Button class="btn-ghost btn-sm" @click="close">{{ t('cancel') }}</Button>
      <Button
        class="btn-primary btn-sm"
        :icon="IconPlus"
        :disabled="!canSubmit"
        @click="submit"
        >{{ t('subscriptionProviderPickerAdd') }}</Button
      >
    </template>
  </Modal>
</template>
