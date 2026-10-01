// https://nuxt.com/docs/api/configuration/nuxt-config
//
// 这个文件里有八个 marker 区间（scripts/init.mjs 的 SECTIONS 常量与之一一对应）：
//   TEMPLATE:IMPORTS         顶层 import（如 Tailwind 的 vite 插件）
//   TEMPLATE:MODULES         模块数组
//   TEMPLATE:MODULE_OPTIONS  各模块自己的配置段（i18n、site 等）
//   TEMPLATE:VITE            vite 构建配置
//   TEMPLATE:CSS             全局样式入口（顺序固定，见 README）
//   TEMPLATE:RUNTIME         运行期配置
//   TEMPLATE:RENDER          渲染模式（ssr / nitro.preset / routeRules）
//   TEMPLATE:TYPESCRIPT      TypeScript 严格度
//
// 引擎只替换「>>> 与 <<< 之间」的全部内容（含缩进对齐），
// 区间之外的「手写区」逐字节不动 —— 你自己的配置写在那里。
// 缺任何一个 marker，引擎都会直接报错退出，不做「尽力而为」。
//
// 注意 marker 必须**成对出现**，且区间内不要出现第二个同名 marker。

// >>> TEMPLATE:IMPORTS
// <<< TEMPLATE:IMPORTS

export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  devtools: { enabled: true },

  // >>> TEMPLATE:MODULES
  modules: [],
  // <<< TEMPLATE:MODULES

  // >>> TEMPLATE:MODULE_OPTIONS
  // <<< TEMPLATE:MODULE_OPTIONS

  // >>> TEMPLATE:VITE
  vite: {},
  // <<< TEMPLATE:VITE

  // >>> TEMPLATE:CSS
  css: ['~/assets/styles/tokens.css', '~/assets/styles/base.css'],
  // <<< TEMPLATE:CSS

  // >>> TEMPLATE:RUNTIME
  runtimeConfig: {
    public: {
      appName: 'Nuxt Shuttle',
    },
  },
  // <<< TEMPLATE:RUNTIME

  // >>> TEMPLATE:RENDER
  ssr: true,
  // <<< TEMPLATE:RENDER

  // >>> TEMPLATE:TYPESCRIPT
  typescript: {},
  // <<< TEMPLATE:TYPESCRIPT

  // ---------------------------------------------------------------------------
  // 手写区：引擎永不改动。你自己的 routeRules、模块选项、vite 配置写在这里。
  // ---------------------------------------------------------------------------
  app: {
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      title: 'Nuxt Shuttle',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      ],
    },
  },
});

