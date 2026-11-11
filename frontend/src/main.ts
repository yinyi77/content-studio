import { initPreferences } from '@vben/preferences';
import { addIcon } from '@vben/icons';

// The official layout uses these named icons. Register local vectors before
// mounting so navigation and search never contact the Iconify public API.
const stroke = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
addIcon('ep:fold', { width: 24, height: 24, body: `<g ${stroke}><path d="M4 5h16M4 19h16M12 9h8M12 15h8M8 9l-3 3 3 3"/></g>` });
addIcon('ep:expand', { width: 24, height: 24, body: `<g ${stroke}><path d="M4 5h16M4 19h16M12 9h8M12 15h8M5 9l3 3-3 3"/></g>` });
addIcon('mdi:keyboard-esc', { width: 24, height: 24, body: `<g ${stroke}><rect x="2" y="5" width="20" height="14" rx="3"/><path d="M8 9H5v6h3M5 12h2M12 9h-2v3h2v3h-2M18 9h-2v6h2"/></g>` });

await initPreferences({
  namespace: 'content-studio-vben-5.7-v2',
  overrides: {
    app: { name: '图文工坊', defaultHomePath: '/briefing', locale: 'zh-CN', layout: 'sidebar-nav', enableCheckUpdates: false, enablePreferences: false, defaultAvatar: '', contentPadding: 0, dynamicTitle: true },
    theme: { mode: 'light', semiDarkSidebar: true, semiDarkHeader: false, colorPrimary: 'hsl(217 91% 60%)', radius: '0.5', fontSize: 14 },
    breadcrumb: { enable: true, showIcon: false, hideOnlyOne: false },
    header: { height: 56, mode: 'fixed' },
    sidebar: { width: 224, collapseWidth: 64, collapsed: false, draggable: false, expandOnHover: true, collapsedButton: true, fixedButton: false },
    logo: { source: '', sourceDark: '', showText: true },
    tabbar: { enable: true, height: 40, persist: false, showIcon: true, showMore: true, showRefresh: false, showMaximize: true, styleType: 'chrome', draggable: true },
    footer: { enable: false }, copyright: { enable: false },
    transition: { enable: false, loading: false, progress: false },
    widget: { fullscreen: true, globalSearch: true, languageToggle: false, lockScreen: false, logoutButtonPosition: 'user-dropdown', notification: false, refresh: false, sidebarToggle: true, themeToggle: false, timezone: false },
    shortcutKeys: { globalLockScreen: false, globalLogout: false, globalPreferences: false, globalEscape: false },
  },
});
const { bootstrap } = await import('./bootstrap');
await bootstrap();
