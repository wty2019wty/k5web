<template>
  <div v-if="!appStore.navbar" class="fixed-settings" @click="setVisible">
    <a-button type="primary">
      <template #icon>
        <icon-settings />
      </template>
    </a-button>
  </div>
  <a-drawer
    :width="'min(300px, 90vw)'"
    unmount-on-close
    :visible="visible"
    :cancel-text="$t('settings.close')"
    :ok-text="$t('settings.copySettings')"
    @ok="copySettings"
    @cancel="cancel"
  >
    <template #title> {{ $t('settings.title') }} </template>
    <Block :options="contentOpts" :title="$t('settings.content')" />
    <Block :options="othersOpts" :title="$t('settings.otherSettings')" />
    <a-alert>{{ $t('settings.alertContent') }}</a-alert>
  </a-drawer>
</template>

<script lang="ts" setup>
  import { computed, onMounted, onUnmounted } from 'vue';
  import { Message } from '@arco-design/web-vue';
  import { useI18n } from 'vue-i18n';
  import { useClipboard } from '@vueuse/core';
  import { useAppStore } from '@/store';
  import {
    BLE_CHUNK_OPTIONS,
    BLE_CHUNK_AUTO,
    subscribeBleChunkSetting,
  } from '@/utils/ble-serial/index.js';
  import Block from './block.vue';

  const emit = defineEmits(['cancel']);

  const appStore = useAppStore();
  // 浮层里的分片选择器也写 localStorage：订阅它，保持抽屉显示的 appStore 值同步。
  let unsubscribeBleChunk: (() => void) | null = null;
  onMounted(() => {
    unsubscribeBleChunk = subscribeBleChunkSetting((value) => {
      appStore.bleChunkSize = value;
    });
  });
  onUnmounted(() => {
    if (unsubscribeBleChunk) unsubscribeBleChunk();
  });
  const { t } = useI18n();
  const { copy } = useClipboard();
  const visible = computed(() => appStore.globalSettings);
  const contentOpts = computed(() => [
    { name: 'settings.navbar', key: 'navbar', defaultVal: appStore.navbar },
    {
      name: 'settings.menu',
      key: 'menu',
      defaultVal: appStore.menu,
    },
    {
      name: 'settings.topMenu',
      key: 'topMenu',
      defaultVal: appStore.topMenu,
    },
    { name: 'settings.footer', key: 'footer', defaultVal: appStore.footer },
    { name: 'settings.tabBar', key: 'tabBar', defaultVal: appStore.tabBar },
    {
      name: 'settings.menuFromServer',
      key: 'menuFromServer',
      defaultVal: appStore.menuFromServer,
    },
    {
      name: 'settings.menuWidth',
      key: 'menuWidth',
      defaultVal: appStore.menuWidth,
      type: 'number',
    },
  ]);
  // BLE 写分片档位：509/256/128/64/32/20 + 自动
  const bleChunkOpts = computed(() => [
    ...BLE_CHUNK_OPTIONS.map((value) => ({ label: String(value), value })),
    { label: t('settings.bleChunkAuto'), value: BLE_CHUNK_AUTO },
  ]);
  const othersOpts = computed(() => [
    {
      name: 'settings.colorWeak',
      key: 'colorWeak',
      defaultVal: appStore.colorWeak,
    },
    {
      name: 'settings.bleChunkSize',
      key: 'bleChunkSize',
      defaultVal: appStore.bleChunkSize,
      type: 'select',
      options: bleChunkOpts.value,
    },
  ]);

  const cancel = () => {
    appStore.updateSettings({ globalSettings: false });
    emit('cancel');
  };
  const copySettings = async () => {
    const text = JSON.stringify(appStore.$state, null, 2);
    await copy(text);
    Message.success(t('settings.copySettings.message'));
  };
  const setVisible = () => {
    appStore.updateSettings({ globalSettings: true });
  };
</script>

<style scoped lang="less">
  .fixed-settings {
    position: fixed;
    top: 280px;
    right: 0;

    svg {
      font-size: 18px;
      vertical-align: -4px;
    }
  }
</style>
