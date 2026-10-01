import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

/**
 * 应用级 store 的起步骨架。
 *
 * 用「组合式」写法（setup store）而不是选项式：
 *   ① 与 <script setup> 的心智模型完全一致，不用在两种写法之间切换；
 *   ② 可以直接 import 别的组合式函数复用逻辑（选项式做不到）。
 *
 * 位置：app/stores/ 由 @pinia/nuxt 自动导入，所以组件里不用 import 就能用 useAppStore()。
 *
 * 为什么显式 import ref/computed（Nuxt 本来会自动导入它们）：
 * 自动导入只在 Nuxt 运行时里成立。显式声明之后，这个文件在纯 vitest 环境里也能被
 * import 与测试（见 test/app.spec.ts）—— 一个 store 不值得为它拉起整个 Nuxt。
 *
 * 什么时候**不该**新建 store：只在单个组件里用的状态放组件里就行。
 * store 的价值在于跨路由共享与可预测的调试（DevTools 里能看到每次变更）。
 */
export const useAppStore = defineStore('app', () => {
  /** 全局加载态：比如顶部的进度条 */
  const loading = ref(false);
  /** 侧边栏是否折叠 —— 典型的「看起来是 UI 状态，其实是跨页面共享的状态」 */
  const sidebarCollapsed = ref(false);

  const isReady = computed(() => !loading.value);

  function setLoading(value: boolean): void {
    loading.value = value;
  }

  function toggleSidebar(): void {
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }

  return {
    loading,
    sidebarCollapsed,
    isReady,
    setLoading,
    toggleSidebar,
  };
});
