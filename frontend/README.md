# 图文工坊 Vben 前端

实际使用官方 **Vue Vben Admin** 的 `BasicLayout`、菜单、面包屑、Tabbar、偏好设置和状态管理。上游来源与固定提交在 `UPSTREAM.json`；MIT 许可保留在 `LICENSE.VBEN`。

## 结构

- `src/`：图文工坊入口、7 个业务路由和同源工作区桥。
- `packages/`、`internal/tailwind-config/`：官方布局所需的 23 个工作区包，已移除演示应用、Mock、文档和测试。
- `dist/`：可由现有 Node 服务直接提供的生产文件。
- `scripts/build.mjs`：在 ASCII 临时路径中重建，避免项目中文目录的工具兼容问题。

Vben 接管导航、侧栏、路径、访问页签、搜索和全屏。业务内容暂时沿用一个持久的同源工作区 `/legacy?embedded=1&view=…`，从而保留创作会话、作品修改上下文和未提交配置；切换路由不会重载业务页面。业务页不是七份独立 iframe，也没有演示登录或伪造权限接口。

唯一的上游布局适配是为 `BasicLayout` 增加 `content` 插槽，未提供插槽时仍使用官方 `LayoutContent`。页签刷新通过 Vben store 的真实刷新状态转发成业务页的只读刷新消息。

## 构建

```sh
# 项目根目录
npm run build:frontend

# 或当前目录
node scripts/build.mjs
```

构建需要 Node.js 22.18+ / 24.12+ 及 pnpm 11。脚本可查找本机 NVM 安装的兼容 Node，也支持 `VBEN_NODE_BINARY`、`VBEN_PNPM_BINARY`。依赖版本锁定在 `pnpm-lock.yaml`；首次构建需要下载依赖。已构建的 `dist` 不需要在本地服务启动时再次安装依赖。

开发时先启动项目主服务，再在兼容 Node 环境运行 `pnpm install --frozen-lockfile`、`pnpm dev`，打开 `http://127.0.0.1:4321/admin/`。开发服务器将业务页面和 API 代理至本机 4318；可用 `VBEN_BACKEND_URL` 修改后端地址。生产入口由主服务提供。

## 工作区通信

外层仅接受本源且 `event.source === iframe.contentWindow` 的消息。页面名必须在七个路由白名单内；路由请求有递增 requestId，晚到回执不会覆盖最新导航。子页同样校验来源与 source。消息仅传页面标识和就绪状态，不传 API 密钥、Cookie 或产品资料。
