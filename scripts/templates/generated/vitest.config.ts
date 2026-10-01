import { defineVitestConfig } from '@nuxt/test-utils/config';

/**
 * Vitest 配置。
 *
 * 默认环境是 happy-dom，用来跑**快**的那一类：纯函数、组合式函数、Pinia store。
 * 这类测试几百毫秒跑完，适合在保存时高频执行。
 *
 * 需要真实 Nuxt 环境（组件挂载、服务端接口、路由）的测试，在**那个文件顶部**加一行：
 *
 *   // @vitest-environment nuxt
 *
 * 它比 happy-dom 慢得多（要起 Nuxt 运行时），所以不要把它设成全局默认 ——
 * 那样每跑一次测试都要等几秒，久而久之就没人跑了。
 */
export default defineVitestConfig({
  test: {
    environment: 'happy-dom',
    include: ['test/**/*.spec.ts'],
    // dot 报告器：通过时只打点，失败时才展开 —— 高频跑测试时输出噪音最小
    reporters: 'dot',
  },
});
