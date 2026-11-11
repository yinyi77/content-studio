<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { BasicLayout } from '@vben/layouts';
import { useTabbarStore } from '@vben/stores';

const route = useRoute();
const tabbarStore = useTabbarStore();
let requestId = 0;
const router = useRouter();
const views = new Set(['briefing','radar','trends','xhs','dingtalk','history','settings']);
const frame = ref<HTMLIFrameElement>();
const ready = ref(false);
const currentView = computed(() => views.has(String(route.name)) ? String(route.name) : 'briefing');
const initialView = currentView.value;
const source = '/legacy?embedded=1&view=' + encodeURIComponent(initialView);
const logo = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"%3E%3Cpath fill="%236397f3" d="M2 2h12v12H2zM18 2h12v12H18zM2 18h12v12H2z"/%3E%3Cpath fill="%233b6bdc" d="M18 18h12v12H18z"/%3E%3C/svg%3E';
function sendView() {
  if (!ready.value) return;
  frame.value?.contentWindow?.postMessage({ type: 'content-studio:set-view', view: currentView.value, requestId: ++requestId }, window.location.origin);
}
function receive(event: MessageEvent) {
  if (event.origin !== window.location.origin || event.source !== frame.value?.contentWindow) return;
  const data = event.data;
  if (!data || typeof data !== 'object' || !views.has(data.view)) return;
  if (data.type === 'content-studio:ready') { ready.value = true; sendView(); }
  if (data.type === 'content-studio:navigate' && data.view !== currentView.value) void router.replace('/' + data.view);
  if (data.type === 'content-studio:view-ready' && data.requestId === requestId && data.view !== currentView.value) void router.replace('/' + data.view);
}
watch(currentView, sendView);
watch(() => tabbarStore.renderRouteView, visible => {
  if (visible === false && ready.value) frame.value?.contentWindow?.postMessage({ type: 'content-studio:refresh-view', view: currentView.value }, window.location.origin);
});
watch(() => route.meta.title, value => { document.title = `${String(value || '创作对话')} · 图文工坊`; }, { immediate: true });
onMounted(() => window.addEventListener('message', receive));
onBeforeUnmount(() => window.removeEventListener('message', receive));
</script>

<template>
  <BasicLayout logo-text="图文工坊" :logo-src="logo" :logo-src-dark="logo" @click-logo="router.push('/briefing')">
    <template #user-dropdown><div class="studio-local-user"><span class="studio-local-dot"></span><span>本地工作区</span><span class="studio-avatar">我</span></div></template>
    <template #content>
      <div class="studio-workspace">
        <iframe ref="frame" title="图文工坊业务工作区" class="studio-frame" :src="source" @load="sendView" />
      </div>
    </template>
  </BasicLayout>
</template>
