import { onMounted, onBeforeMount, onBeforeUnmount } from 'vue';
import { useDebounceFn } from '@vueuse/core';
import { useAppStore } from '@/store';
import { addEventListen, removeEventListen } from '@/utils/event';

// Keep aligned with @mobile-max in assets/style/mobile.less (WIDTH - 1).
// https://arco.design/vue/component/grid#responsivevalue
export const MOBILE_BREAKPOINT = 992;

export function queryDevice() {
  const rect = document.body.getBoundingClientRect();
  return rect.width - 1 < MOBILE_BREAKPOINT;
}

export function applyDevice(appStore: ReturnType<typeof useAppStore>) {
  const isMobile = queryDevice();
  appStore.toggleDevice(isMobile ? 'mobile' : 'desktop');
}

export default function useResponsive(immediate?: boolean) {
  const appStore = useAppStore();
  function resizeHandler() {
    applyDevice(appStore);
  }
  const debounceFn = useDebounceFn(resizeHandler, 100);
  onBeforeMount(() => {
    // Sync on first paint so mobile never flashes the desktop shell.
    applyDevice(appStore);
    addEventListen(window, 'resize', debounceFn);
    addEventListen(document, 'visibilitychange', resizeHandler);
  });
  onMounted(() => {
    if (immediate) resizeHandler();
  });
  onBeforeUnmount(() => {
    removeEventListen(window, 'resize', debounceFn);
    removeEventListen(document, 'visibilitychange', resizeHandler);
  });
}
