<script setup lang="ts">
/**
 * 选择页：三区结构（左技术栈 / 右 Nuxt 配置 / 底部操作条）。
 *
 * 两条刻意的设计：
 * ① 首次绘制一定是**骨架态**。令牌要从 window.__WIZARD__ 读、选择要从 localStorage 与
 *    URL 读，这些只有浏览器里才有。与其在服务端渲染一份「猜的」默认值再水合时改掉
 *    （那会带来水合不一致），不如先显示骨架，挂载后再拉数据。
 * ② 「初始化项目」是**两步确认**：第一次点击只算计划并展开预览，第二次才真的开始。
 *    从点下按钮到结束，中间会删文件、装依赖 —— 值得多一次点击。
 */
import type { Selection } from '~/utils/wizard/option-model';
import { useWizard } from '~/utils/wizard/useWizard';
import ConflictHint from '~/components/wizard/ConflictHint.vue';
import DependencyPreview from '~/components/wizard/DependencyPreview.vue';
import NuxtConfigPanel from '~/components/wizard/NuxtConfigPanel.vue';
import OptionGroup from '~/components/wizard/OptionGroup.vue';
import ProgressStream from '~/components/wizard/ProgressStream.vue';
// 引导期样式随页面一起删除：在页面里 import，删页面时引用一起消失，不用去改 nuxt.config.ts
import '~/assets/styles/wizard.css';

const wizard = useWizard();
const { state, stages, blockedFor, blockConflicts, warnConflicts, infoConflicts, canStart, canPreview } = wizard;

/**
 * 挂载后再拉数据：令牌来自 window.__WIZARD__、选择来自 localStorage 与 URL，
 * 这些服务端都没有（见文件头 ①）。在这之前页面就是骨架态。
 *
 * 这里用 attach() 而不是只 load()：它顺带读一次锁文件状态 ——
 * 于是「跑到一半刷新 /setup」也能直接看到进度，而不是回到一个看似无人操作的选择页。
 */
onMounted(() => {
  void wizard.attach();
});

/** 展示顺序固定：阻断 → 提醒 → 说明。先看到「不能提交的原因」，再看建议。 */
const orderedConflicts = computed(() => [
  ...blockConflicts.value,
  ...warnConflicts.value,
  ...infoConflicts.value,
]);

const leftGroups = computed(() => state.schema?.groups.filter((group) => group.column === 'left') ?? []);
const rightGroups = computed(() => state.schema?.groups.filter((group) => group.column === 'right') ?? []);
const loading = computed(() => !state.schema);
const showProgress = computed(() => ['running', 'done', 'failed'].includes(state.status));

function onUpdate(next: Selection): void {
  wizard.updateSelection(next);
}

/** 两步确认：第一次算计划，第二次才动手。 */
async function onInit(): Promise<void> {
  if (state.status === 'planned') {
    await wizard.start();
    return;
  }
  await wizard.preview();
}
</script>

<template>
  <main class="wizard" :class="{ 'is-running': state.status === 'running' }">
    <header class="wizard__head">
      <h1>Nuxt Shuttle · 初始化</h1>
      <p>
        选完点「初始化项目」。模板会自删引导器、改写配置区间、装上你选的依赖，
        产出一份干净的普通 Nuxt 工程 —— 不会有额外的运行时依赖留在产物里。
      </p>
    </header>

    <div v-if="loading" class="wizard__full">
      <div class="skeleton">
        {{ state.message || '正在读取候选清单…' }}
      </div>
      <div v-if="state.error" class="hint hint--block">
        {{ state.error }}
      </div>
    </div>

    <template v-else>
      <div class="wizard__col">
        <h2>技术栈</h2>
        <p class="group__desc">
          左侧决定「用什么写」，选完基本不会再改 —— 它更像团队的身份，而不是项目的配置。
        </p>
        <OptionGroup
          v-for="group in leftGroups"
          :key="group.key"
          :group="group"
          :model-value="state.selection"
          :blocked="blockedFor(group.key)"
          @update:model-value="onUpdate"
        />
      </div>

      <div class="wizard__col">
        <NuxtConfigPanel
          :groups="rightGroups"
          :model-value="state.selection"
          :blocked-for="blockedFor"
          :plan="state.plan"
          @update:model-value="onUpdate"
        />
      </div>

      <div class="wizard__full">
        <ConflictHint
          :conflicts="orderedConflicts"
          empty-text="当前组合没有已知冲突，可以直接初始化。"
        />
      </div>

      <div class="wizard__full">
        <DependencyPreview
          :schema="state.schema"
          :selection="state.selection"
          :plan="state.plan"
          :previewing="state.previewing"
          @preview="wizard.preview()"
        />
      </div>
    </template>

    <div v-if="showProgress" class="wizard__full">
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
        @retry="wizard.retry()"
        @refresh="wizard.refreshStatus()"
      />
    </div>

    <div v-else class="wizard__footer">
      <span class="wizard__footer-status">
        <template v-if="blockConflicts.length">
          有 {{ blockConflicts.length }} 项阻断级冲突，先按上面的说明调整再提交。
        </template>
        <template v-else-if="state.status === 'planned'">
          计划已计算。确认无误后点「确认并开始初始化」—— 之后会删文件、装依赖，中途不要关闭标签页。
        </template>
        <template v-else>
          尚未计算计划：第一次点击只出预览，不动任何文件。
        </template>
      </span>

      <button type="button" :disabled="!state.schema" @click="wizard.resetSelection()">
        恢复推荐默认
      </button>
      <button type="button" :disabled="!canPreview" @click="wizard.preview()">
        {{ state.previewing ? '计算中…' : '预览变更' }}
      </button>
      <button
        type="button"
        data-primary
        :disabled="!canStart || blockConflicts.length > 0"
        @click="onInit()"
      >
        {{ state.status === 'planned' ? '确认并开始初始化' : '初始化项目' }}
      </button>
    </div>

    <div v-if="!showProgress && state.error" class="wizard__full">
      <div class="hint hint--block">
        {{ state.error }}
      </div>
    </div>
  </main>
</template>
