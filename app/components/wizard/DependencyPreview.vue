<script setup lang="ts">
/**
 * 预览变更弹窗：依赖清单 + 文件变更 + 配置区间。
 *
 * 为什么从「右栏顶部常驻的折叠区」改成弹窗：
 * 它回答的是「点下去会发生什么」，属于**一次性核对**，不是要常驻盯着的配置 ——
 * 常驻在右栏时，展开高度会不断挤压下面那些真正要反复调的控件；缩成一行标题又等于没显示。
 * 拆成弹窗之后两边都拿到了自己需要的空间：右栏只剩控件，计划要看时才铺开。
 *
 * 两种数据来源，视觉上必须能区分开：
 *   ① **估算**（本地算，随勾选实时变化）—— 只用于「还没算出计划」时的数量提示；
 *   ② **计划**（服务端算，点「预览变更」后得到）—— 这才是承诺，也是引擎真正会执行的那一份。
 * 把两者混在一起显示，用户就没法判断「我看到的到底算不算数」。
 *
 * 用原生 <dialog> + showModal()：焦点陷阱、Esc 关闭、遮罩层、背景惰性化
 * 都是浏览器给的，而引导期是零依赖的（dependencies 里只有 nuxt），不能引组件库。
 */
import type { InitPlan, Selection, WizardSchema } from '~/utils/wizard/option-model';

const props = defineProps<{
  open: boolean;
  schema: WizardSchema | null;
  selection: Selection;
  plan: InitPlan | null;
  previewing: boolean;
  /** 算计划失败的原因。弹窗盖住了页面，错误必须显示在弹窗里才看得到。 */
  error?: string;
}>();

const emit = defineEmits<{ close: []; preview: [] }>();

const dialog = ref<HTMLDialogElement | null>(null);

/**
 * `<dialog>` 的开关是命令式的（showModal / close），状态却在父组件 —— 把两边对齐。
 * flush: 'post' 让 dialog 已经挂到 DOM 之后再执行，避免首次挂载时 ref 还是空的。
 */
watch(
  () => props.open,
  (open) => {
    const el = dialog.value;
    if (!el) return;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  },
  { flush: 'post' },
);

onMounted(() => {
  // 父组件在挂载前就把 open 置了 true 的情况（例如从 URL 直接进预览）
  if (props.open && dialog.value && !dialog.value.open) dialog.value.showModal();
});

function close(): void {
  const el = dialog.value;
  if (!el || !el.open) {
    // 兜底：万一时序错开，也要让父组件把状态收回去，否则按钮会永远点不动
    emit('close');
    return;
  }
  el.close();
}

/** Esc 与点遮罩都走这里。程序化 close() 时父组件已经是 false，不会再发一次。 */
function onNativeClose(): void {
  if (props.open) emit('close');
}

/** panel 铺满了 dialog 的盒子（.modal 无 padding），
 *  所以「事件目标是 dialog 自己」只可能是点在遮罩上。 */
function onBackdropClick(event: MouseEvent): void {
  if (event.target === dialog.value) close();
}

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

const lead = computed(() => {
  if (props.previewing) return '正在计算变更计划…';
  if (props.plan) return '预览即承诺：初始化时执行的正是这一份计划，不会多删也不会少装。';
  return `还没算出计划${estimate.value.total ? `（按当前选择约 ${estimate.value.total} 个依赖）` : ''}。`;
});

const note = computed(() => {
  const plan = props.plan;
  if (!plan) return '点「重新计算」按当前选择生成计划。';
  const { deps, devDeps, deleteFiles, generatedFiles } = plan;
  return `运行时 ${deps.length} + 开发 ${devDeps.length} 个依赖 · 删除 ${deleteFiles.length} 个文件 · 生成 ${generatedFiles.length} 个文件`;
});
</script>

<template>
  <dialog
    ref="dialog"
    class="modal modal--wide"
    aria-labelledby="preview-modal-title"
    @click="onBackdropClick"
    @close="onNativeClose"
  >
    <div class="modal__panel">
      <header class="modal__head">
        <h2 id="preview-modal-title" class="modal__title">
          依赖与变更预览
        </h2>
        <button type="button" class="modal__close" aria-label="关闭" @click="close()">
          ×
        </button>
      </header>

      <div class="modal__body">
        <p class="modal__lead">
          {{ lead }}
        </p>

        <div v-if="previewing" class="skeleton">
          正在计算变更计划…
        </div>

        <div v-else-if="error" class="hint hint--block">
          {{ error }}
        </div>

        <div v-else-if="!plan" class="hint hint--warn">
          尚未算出计划。点下方「重新计算」。
        </div>

        <div v-else class="preview__grid">
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

          <!-- 将写入的配置区间：原先挂在右栏底部，与依赖清单同源（都是计划的产物），
               一起搬进弹窗 —— 右栏于是只剩「控件」，语义干净。 -->
          <div>
            <h3>将写入的配置区间（{{ plan.sections.length }}）</h3>
            <ul v-if="plan.sections.length" class="preview__list">
              <li v-for="section in plan.sections" :key="section">
                TEMPLATE:{{ section }}
              </li>
            </ul>
            <p v-else class="preview__empty">
              无
            </p>
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
      </div>

      <footer class="modal__foot">
        <span class="modal__note">{{ note }}</span>
        <button v-if="!plan && !previewing" type="button" @click="emit('preview')">
          重新计算
        </button>
        <button type="button" @click="close()">
          关闭
        </button>
      </footer>
    </div>
  </dialog>
</template>
