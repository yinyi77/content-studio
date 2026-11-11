import { createApp, markRaw } from 'vue';
import { createRouter, createWebHashHistory } from 'vue-router';
import { initStores, useAccessStore } from '@vben/stores';
import { setupI18n } from '@vben/locales';
import { BookOpenText, InspectionPanel, LayoutGrid, MessageSquareCode, Search, Settings, SquareCode } from '@vben/icons';
import '@vben/styles';
import './workspace.css';
import App from './App.vue';

const originalHash = location.hash;
const originalLegacyView = new URLSearchParams(location.search).get('view');

export const pages = [
  { view: 'briefing', title: '创作对话', icon: markRaw(MessageSquareCode) },
  { view: 'radar', title: '选题雷达', icon: markRaw(InspectionPanel) },
  { view: 'trends', title: '当下热点', icon: markRaw(Search) },
  { view: 'xhs', title: '小红书账号', icon: markRaw(LayoutGrid) },
  { view: 'history', title: '作品记录', icon: markRaw(BookOpenText) },
  { view: 'dingtalk', title: '钉钉接入', icon: markRaw(SquareCode) },
  { view: 'settings', title: '模型设置', icon: markRaw(Settings) },
];
const Empty = { render: () => null };
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/briefing' },
    ...pages.map(page => ({ path: '/' + page.view, name: page.view, component: Empty, meta: { title: page.title, icon: page.icon, affixTab: page.view === 'briefing', keepAlive: true } })),
    { path: '/:pathMatch(.*)*', redirect: '/briefing' },
  ],
});
export async function bootstrap() {
  const app = createApp(App);
  await initStores(app, { namespace: 'content-studio-vben-local' });
  await setupI18n(app, { defaultLocale: 'zh-CN' });
  const access = useAccessStore();
  access.setAccessMenus(pages.map((page, index) => ({ path: '/' + page.view, name: page.title, icon: page.icon, order: index })));
  access.setAccessRoutes(router.getRoutes());
  access.setIsAccessChecked(true);
  app.use(router);
  await router.isReady();
  if (!originalHash && pages.some(page => page.view === originalLegacyView)) await router.replace('/' + originalLegacyView);
  app.mount('#app');
}
