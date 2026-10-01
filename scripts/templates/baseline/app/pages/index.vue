<script setup lang="ts">
/**
 * 首页基线 —— 引导期结束后由 scripts/init.mjs 覆盖到 app/pages/index.vue。
 *
 * 两条纪律：
 *   ① 不引用任何组件库与模块（零依赖引导的产物必须开箱能跑）；
 *   ② 只用 app/assets/styles/tokens.css 里的 CSS 变量，不写死颜色。
 *      否则用户切到深色模式时会看到一块白底 —— 而这里本该是「默认就好看」的地方。
 */
const { appName } = useRuntimeConfig().public;

const steps = [
  { cmd: 'pnpm dev', text: '启动开发服务（就是你现在看到的这一页）' },
  { cmd: 'pnpm run check', text: '比对仓库现状与 template.config.json，看有没有漂移' },
  { cmd: 'pnpm verify', text: '复核产物：引导器残留、依赖、配置区间是否都对' },
  { cmd: 'pnpm run gates', text: '跑质量门禁（lint / 类型 / 测试 / 构建）' },
];
</script>

<template>
  <main class="home">
    <h1>{{ appName }}</h1>
    <p class="lead">
      引导器已经自删，现在这套工程里只剩你选过的东西。这一页是基线首页，
      直接改 <code>app/pages/index.vue</code> 就行 —— 引擎不会再碰它。
    </p>

    <section>
      <h2>下一步</h2>
      <dl class="steps">
        <template v-for="step in steps" :key="step.cmd">
          <dt><code>{{ step.cmd }}</code></dt>
          <dd>{{ step.text }}</dd>
        </template>
      </dl>
    </section>

    <section>
      <h2>改配置去哪里</h2>
      <p>
        <code>nuxt.config.ts</code> 里的 marker 区间由引擎维护，
        区间之外的「手写区」永远不会被改写 —— 你的 <code>routeRules</code>、
        模块选项、Vite 配置都写在那里。
      </p>
    </section>
  </main>
</template>

<style scoped>
.home {
  max-width: 720px;
  margin: 0 auto;
  padding: var(--sp-8) var(--sp-4);
}

.lead {
  color: var(--fg-muted);
}

section {
  margin-top: var(--sp-6);
}

.steps {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--sp-2) var(--sp-4);
  margin: 0;
}

.steps dt code {
  font-family: var(--font-mono);
  padding: 2px 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-subtle);
}

.steps dd {
  margin: 0;
  color: var(--fg-muted);
}
</style>
