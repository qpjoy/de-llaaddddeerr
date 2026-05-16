<template>
  <q-page class="content-panel">
    <div class="toolbar-row q-mb-md">
      <div class="page-title">设置</div>
      <q-space />
      <q-btn flat round icon="refresh" :loading="loading" @click="settings.refresh()" />
    </div>

    <!-- Server mode has no host-local settings. -->
    <q-banner v-if="!settings.available" class="bg-grey-2 q-mb-md" rounded>
      此页面仅在桌面端（嵌入 host 时）可用。服务端管理面板没有"插件市场服务器"概念，因为它就是上游。
    </q-banner>

    <template v-else>
      <div v-if="settings.loading.value && !data" class="section-surface q-pa-xl text-center text-grey-7">
        加载中…
      </div>

      <div v-else-if="data" class="section-surface q-pa-lg">
        <div class="text-h6 q-mb-xs">插件市场服务器</div>
        <div class="text-caption text-grey-8 q-mb-md">
          host 启动时按以下优先级决定使用哪个 URL：宿主显式 → 环境变量 → 本页设置 → 内置默认。
          修改保存后需要<strong>重启 app</strong> 才会生效（host 在启动时一次性读取并复用同一个 client）。
        </div>

        <!-- Current state -->
        <q-list bordered class="rounded-borders">
          <q-item>
            <q-item-section>
              <q-item-label caption>当前生效</q-item-label>
              <q-item-label class="text-weight-medium">
                <span v-if="data.effective.url">{{ data.effective.url }}</span>
                <span v-else class="text-grey-7">（离线模式）</span>
              </q-item-label>
              <q-item-label caption>{{ describeSource(data.effective.source) }}</q-item-label>
            </q-item-section>
          </q-item>

          <q-separator />

          <q-item>
            <q-item-section>
              <q-item-label caption>下次重启后</q-item-label>
              <q-item-label
                class="text-weight-medium"
                :class="{ 'text-warning': data.nextRestart.url !== data.effective.url }"
              >
                <span v-if="data.nextRestart.url">{{ data.nextRestart.url }}</span>
                <span v-else class="text-grey-7">（离线模式）</span>
              </q-item-label>
              <q-item-label caption>{{ describeSource(data.nextRestart.source) }}</q-item-label>
            </q-item-section>
            <q-item-section side v-if="data.nextRestart.url !== data.effective.url">
              <q-chip color="warning" text-color="white" dense icon="restart_alt">
                等待重启生效
              </q-chip>
            </q-item-section>
          </q-item>
        </q-list>

        <!-- Locks: if explicit / env locked, show banner instead of edit form. -->
        <q-banner v-if="data.explicitLocked" class="bg-orange-1 text-orange-10 q-mt-md" rounded>
          <template #avatar><q-icon name="lock" color="orange" /></template>
          宿主应用通过代码显式传入了 <code>serverBaseUrl</code> 选项，本页设置当前被忽略。
          要恢复本页可编辑，请在宿主代码中删除该参数。
        </q-banner>

        <q-banner v-else-if="data.envLocked" class="bg-blue-1 text-blue-10 q-mt-md" rounded>
          <template #avatar><q-icon name="terminal" color="primary" /></template>
          检测到环境变量 <code>QPJOY_MARKET_SERVER</code>，它会覆盖本页设置。
          要让本页生效，请在启动 app 前 unset 该变量。
        </q-banner>

        <!-- Editable form -->
        <template v-else>
          <div class="q-mt-lg">
            <q-input
              v-model="draftUrl"
              outlined
              label="服务器 URL"
              placeholder="https://market.example.com"
              hint="留空或点击「使用默认」即可恢复内置默认。"
              :rules="[validateUrl]"
              :error="!!validationError"
              :error-message="validationError ?? undefined"
              clearable
            >
              <template #append>
                <q-btn
                  flat
                  dense
                  icon="content_paste"
                  @click="pasteFromClipboard"
                  :title="'粘贴'"
                />
              </template>
            </q-input>

            <div class="text-caption text-grey-8 q-mt-sm">
              快速选择：
              <q-chip clickable dense outline @click="draftUrl = data.defaults.dev">
                {{ data.defaults.dev }}
                <q-tooltip>开发默认</q-tooltip>
              </q-chip>
              <q-chip
                v-if="data.defaults.prod"
                clickable
                dense
                outline
                @click="draftUrl = data.defaults.prod ?? ''"
              >
                {{ data.defaults.prod }}
                <q-tooltip>生产默认</q-tooltip>
              </q-chip>
              <q-chip
                v-if="data.userOverride"
                clickable
                dense
                outline
                color="grey-7"
                icon="history"
                @click="draftUrl = data.userOverride ?? ''"
              >
                上次保存
              </q-chip>
            </div>

            <div class="toolbar-row q-mt-md">
              <q-btn
                outline
                color="grey-8"
                icon="restore"
                label="使用默认"
                :disable="saving"
                @click="clearOverride"
              />
              <q-space />
              <q-btn flat label="取消" :disable="saving" @click="resetDraft" />
              <q-btn
                color="primary"
                icon="save"
                label="保存"
                :loading="saving"
                :disable="!isDirty || !!validationError"
                @click="save"
              />
            </div>
          </div>
        </template>
      </div>
    </template>
  </q-page>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';

import { useSettings, describeMarketServerSource } from 'src/composables/useSettings';

const settings = useSettings();
const data = computed(() => settings.settings.value);
const loading = computed(() => settings.loading.value);
const saving = computed(() => settings.saving.value);

const draftUrl = ref<string>('');
const validationError = ref<string | null>(null);

function describeSource(s: import('src/composables/useSettings').MarketServerSource) {
  return describeMarketServerSource(s);
}

// Keep the draft in sync with whatever the server reports — but only when
// we're not actively editing (no validation error pending, draft matches
// last-loaded override). This way a refresh doesn't blow away in-progress
// typing.
watch(
  () => settings.settings.value?.userOverride,
  (override) => {
    if (validationError.value) return;
    draftUrl.value = override ?? '';
  },
  { immediate: true }
);

const isDirty = computed(() => {
  const saved = settings.settings.value?.userOverride ?? '';
  return draftUrl.value.trim() !== saved.trim();
});

function validateUrl(value: string | null): true | string {
  validationError.value = null;
  if (!value) return true; // empty = clear
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    validationError.value = '必须以 http:// 或 https:// 开头';
    return validationError.value;
  }
  try {
    // eslint-disable-next-line no-new
    new URL(trimmed);
  } catch {
    validationError.value = 'URL 格式无效';
    return validationError.value;
  }
  return true;
}

async function pasteFromClipboard(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) draftUrl.value = text.trim();
  } catch {
    /* ignore clipboard-permission errors */
  }
}

function resetDraft(): void {
  draftUrl.value = settings.settings.value?.userOverride ?? '';
  validationError.value = null;
}

async function save(): Promise<void> {
  const v = validateUrl(draftUrl.value);
  if (v !== true) return;
  const target = draftUrl.value.trim();
  await settings.saveMarketServer(target || null);
}

async function clearOverride(): Promise<void> {
  draftUrl.value = '';
  await settings.saveMarketServer(null);
}

onMounted(() => {
  void settings.refresh();
});
</script>

<style scoped lang="scss">
.rounded-borders {
  border-radius: 6px;
}
</style>
