<script setup lang="ts">
/**
 * 底部折叠区：实时依赖预览 + 变更计划。
 *
 * 两种数据来源，视觉上必须能区分开：
 *   ① **估算**（本地算，随勾选实时变化）—— 只用于折叠标题上的数量，让用户对「会装多少东西」有预期；
 *   ② **计划**（服务端算，点「预览变更」后得到）—— 这才是承诺，也是引擎真正会执行的那一份。
 * 把两者混在一起显示，用户就没法判断「我看到的到底算不算数」。
 */
import type { InitPlan, Selection, WizardSchema } from '~/utils/wizard/option-model';

const props = defineProps<{
  schema: WizardSchema | null;
  selection: Selection;
  plan: InitPlan | null;
  previewing: boolean;
}>();

const emit = defineEmits<{ preview: [] }>();

const open = ref(false);

/** 计划是用户主动要的（点了按钮或展开折叠），算出来就直接展开 —— 不该让他再点一次。 */
watch(
  () => props.plan,
  (plan) => {
    if (plan) open.value = true;
  },
);

/** 本地估算：只做并集去重，不做排序与规则判断 —— 它是数量提示，不是计划。 */
const estimate = computed(() => {
  const deps = new Set<string>();
  const devDeps = new Set<string>();
  if (!props.schema) return { deps, devDeps, total: 0 };

  for (const group of props.schema.groups) {
    const picked = props.selection[group.key];
    const values = Array.isArray(picked) ? picked : [picked];
    for (const option of group.options) {
      if (!values.includes(option.value)) continue;
      for (const dep of option.deps ?? []) deps.add(dep);
      for (const dep of option.devDeps ?? []) devDeps.add(dep);
    }
  }
  return { deps, devDeps, total: deps.size + devDeps.size };
});

const summary = computed(() => {
  if (props.previewing) return '正在计算变更计划…';
  if (!props.plan) return `依赖与变更预览（尚未计算 · 按当前选择约 ${estimate.value.total} 个依赖）`;
  const { deps, devDeps, deleteFiles, generatedFiles } = props.plan;
  return `依赖与变更预览（运行时 ${deps.length} + 开发 ${devDeps.length} 个依赖 · 删除 ${deleteFiles.length} 个文件 · 生成 ${generatedFiles.length} 个文件）`;
});

/** 展开就顺手算一次：用户想看的正是展开后的内容，不该再点一次按钮。 */
function onToggle(event: Event): void {
  open.value = (event.target as HTMLDetailsElement).open;
  if (open.value && !props.plan && !props.previewing) emit('preview');
}
</script>

<template>
  <details class="preview" :open="open" @toggle="onToggle">
    <summary>{{ summary }}</summary>

    <div v-if="plan" class="preview__grid">
      <div>
        <h3>运行时依赖（{{ plan.deps.length }}）</h3>
        <ul v-if="plan.deps.length" class="preview__list">
          <li v-for="dep in plan.deps" :key="dep">{{ dep }}</li>
        </ul>
        <p v-else class="preview__empty">
          无
        </p>
      </div>

      <div>
        <h3>开发依赖（{{ plan.devDeps.length }}）</h3>
        <ul v-if="plan.devDeps.length" class="preview__list">
          <li v-for="dep in plan.devDeps" :key="dep">{{ dep }}</li>
        </ul>
        <p v-else class="preview__empty">
          无
        </p>
      </div>

      <div>
        <h3>Nuxt 模块（{{ plan.modules.length }}）</h3>
        <ul v-if="plan.modules.length" class="preview__list">
          <li v-for="mod in plan.modules" :key="mod">{{ mod }}</li>
        </ul>
        <p v-else class="preview__empty">
          无（modules 数组为空）
        </p>
      </div>

      <div>
        <h3>样式入口（顺序即优先级）</h3>
        <ol class="preview__list">
          <li v-for="entry in plan.cssEntries" :key="entry">{{ entry }}</li>
        </ol>
      </div>

      <div>
        <h3>将删除的文件（{{ plan.deleteFiles.length }}）</h3>
        <ul class="preview__list">
          <li v-for="file in plan.deleteFiles" :key="file">{{ file }}</li>
        </ul>
        <p class="preview__empty">
          白名单逐条枚举，不使用任何通配匹配。
        </p>
      </div>

      <div>
        <h3>将生成的文件（{{ plan.generatedFiles.length }}）</h3>
        <ul v-if="plan.generatedFiles.length" class="preview__list">
          <li v-for="file in plan.generatedFiles" :key="file">{{ file }}</li>
        </ul>
        <p v-else class="preview__empty">
          无
        </p>
      </div>
    </div>
  </details>
</template>
