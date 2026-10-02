<script setup lang="ts">
/**
 * 进度页：初始化跑起来之后（或刷新之后）停留的地方。
 *
 * 它存在的理由是**刷新安全**：状态与日志在 useWizard.ts 里是模块级单例，
 * 而进度本身写在引擎的锁文件里。所以哪怕浏览器被刷新、甚至换一个标签页打开，
 * 只要服务还在，这一页都能告诉你「现在卡在哪一步」。
 *
 * 与选择页共用 ProgressStream：两条路径（实时 SSE / 轮询锁文件）的呈现必须一模一样，
 * 否则「刷新后看到的东西不一样」会让用户以为出了新问题。
 */
import { useWizard } from '~/utils/wizard/useWizard';
import ProgressStream from '~/components/wizard/ProgressStream.vue';
import '~/assets/styles/wizard.css';

const wizard = useWizard();
const { state, stages } = wizard;

onMounted(() => {
  void wizard.attach();
});

/** 重试不是在这个页面重开初始化 —— 那要先确认锁已被清理。 */
function onRetry(): void {
  wizard.retry();
  void navigateTo('/setup');
}
</script>

<template>
  <!-- 与选择页共用同一层「外壳 + 滚动区」：.wizard 固定一屏高，内容在 .wizard__body 里滚。
       这一页没有吸附区，滚动区自然占满整屏；不套这层的话，.wizard 的一屏高会把内容挤出去。 -->
  <main class="wizard">
    <div class="wizard__body">
      <header class="wizard__head">
        <h1>Nuxt Shuttle · 初始化进度</h1>
        <p>
          这一页可以直接刷新：进度来自引擎写的 <code>template.init.lock</code>，
          不依赖浏览器里保留的会话。关闭标签页也不会中断引擎。
        </p>
      </header>

      <div class="wizard__full">
        <ProgressStream
          :stages="stages"
          :stage-index="state.stageIndex"
          :status="state.status"
          :mode="state.mode"
          :logs="state.logs"
          :exit-code="state.exitCode"
          :error="state.error"
          :engine-plan="state.enginePlan"
          :remote="state.remote"
          @detach="wizard.detach()"
          @retry="onRetry()"
          @refresh="wizard.refreshStatus()"
        />
      </div>

      <div class="wizard__full preview">
        <p><NuxtLink to="/setup">
          ← 回到选择页
        </NuxtLink></p>
        <p class="preview__empty">
          如果初始化已经跑完，选择页连同它的路由一起被删掉了，这个链接会 404 —— 那是预期行为，
          不是出错。整页访问 <code>/</code> 才是初始化后的正确入口。
        </p>
      </div>
    </div>
  </main>
</template>
