/**
 * 单元测试的起点 —— 用 Pinia store 做示范，因为它同时覆盖了三件事：
 * ① 组合式 API 的响应式语义（ref / computed）；
 * ② **测试里怎么拿到一个干净的 store**（setActivePinia）；
 * ③ 不依赖 Nuxt 运行时也能跑（这也是 store 文件里显式 import ref/computed 的原因）。
 *
 * 注意 import 用的是**相对路径**而不是 `~/stores/app`：
 * Nuxt 别名要在 Nuxt 环境里才成立，而这个文件跑在 happy-dom 环境里。
 * 用别名会让「明明文件在那儿却 import 不到」，且报错信息完全不提别名二字。
 *
 * 需要真实 Nuxt 环境时（组件挂载、服务端接口），在文件顶部加：
 *   // @vitest-environment nuxt
 */
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../app/stores/app';

describe('useAppStore', () => {
  beforeEach(() => {
    // 每个用例一份全新的 pinia：store 是模块级单例，不重置会互相污染，
    // 表现为「单跑通过、全量跑失败」。
    setActivePinia(createPinia());
  });

  it('默认不处于加载态', () => {
    const store = useAppStore();
    expect(store.loading).toBe(false);
    expect(store.isReady).toBe(true);
  });

  it('loading 变化会带动 isReady（computed 是响应式的）', () => {
    const store = useAppStore();
    store.setLoading(true);
    expect(store.isReady).toBe(false);
    store.setLoading(false);
    expect(store.isReady).toBe(true);
  });

  it('toggleSidebar 每次调用都切换一次', () => {
    const store = useAppStore();
    expect(store.sidebarCollapsed).toBe(false);
    store.toggleSidebar();
    expect(store.sidebarCollapsed).toBe(true);
    store.toggleSidebar();
    expect(store.sidebarCollapsed).toBe(false);
  });
});
