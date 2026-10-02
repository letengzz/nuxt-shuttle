<script setup lang="ts">
/**
 * 渲染一个分组。两种控件形态由 options.json 的 `renderAs` 决定，组件不猜：
 * `radios` = 横向单选按钮组，`checks` = 复选行。
 *
 * 为什么用原生 <input type="radio|checkbox">：
 * ① 键盘导航、屏幕阅读器语义、焦点管理全部白送，自己用 div 造要写两百行还写不对；
 * ② 引导期是零依赖的（dependencies 里只有 nuxt），不能用组件库；
 * ③ 这些组件会在初始化时被删除 —— 不值得为它引入任何依赖。
 * 样式靠 :checked 与 :has() 完成，见 app/assets/styles/wizard.css。
 */
import type { OptionGroup, OptionItem, Selection } from '~/utils/wizard/option-model';

const props = defineProps<{
  group: OptionGroup;
  modelValue: Selection;
  /** 本分组里被 block 规则禁掉的 value */
  blocked: Set<string>;
}>();

const emit = defineEmits<{ 'update:modelValue': [Selection] }>();

const current = computed(() => props.modelValue[props.group.key]);

function pick(value: string): void {
  if (props.blocked.has(value)) return;
  emit('update:modelValue', { ...props.modelValue, [props.group.key]: value });
}

function toggle(value: string, checked: boolean): void {
  if (props.blocked.has(value)) return;
  const list = Array.isArray(current.value) ? [...current.value] : [];
  const next = checked ? [...new Set([...list, value])] : list.filter((v) => v !== value);
  emit('update:modelValue', { ...props.modelValue, [props.group.key]: next });
}

function isSelected(value: string): boolean {
  const selected = current.value;
  return Array.isArray(selected) ? selected.includes(value) : selected === value;
}

/**
 * 横向单选按钮的悬停提示：把「说明 + 会装什么 + 实验性原因」拼成一段。
 *
 * 布局上把这几行从可见区拿掉、换取「一行扫完所有候选」的对比效率，
 * 但信息不能丢 —— 它们原本存在的理由是「用户不是不知道该选哪个，
 * 而是不知道选了会带来什么」，所以收进 title 而不是删掉。
 */
function hintFor(opt: OptionItem): string {
  const parts = [opt.desc, opt.note];
  if (opt.experimental) {
    parts.push(`实验性：${opt.experimentalReason || '尚未稳定，需用 CLI 的 --force-experimental 显式开启'}`);
  }
  return parts.filter(Boolean).join('\n');
}
</script>

<template>
  <fieldset class="group">
    <legend>{{ group.label }}</legend>
    <p v-if="group.desc" class="group__desc">
      {{ group.desc }}
    </p>

    <!-- 横向单选按钮组：左右两栏的单选组都用它。
         每个候选占一个「○ 名称」的小块，整组左右排开、一行放不下才换行 ——
         候选彼此相邻，差别一眼可比；组内只有一个能选中，横向排布也正好呼应这一点。
         说明与「会装什么」收进 title 悬停显示：信息没有删，只是从「一直占着版面」
         改成「需要时才展开」。用 title 而不是自造 tooltip，是因为按 HTML-AAM，
         title 就是表单控件的 accessible description，屏幕阅读器拿得到同一份内容。 -->
    <div v-if="group.renderAs === 'radios'" class="radio-row">
      <label
        v-for="opt in group.options"
        :key="opt.value"
        class="radio"
        :class="{ 'is-blocked': blocked.has(opt.value) }"
        :title="hintFor(opt)"
      >
        <input
          type="radio"
          :name="group.key"
          :value="opt.value"
          :checked="isSelected(opt.value)"
          :disabled="blocked.has(opt.value)"
          @change="pick(opt.value)"
        >
        <span class="radio__label">{{ opt.label }}</span>
        <span v-if="opt.experimental" class="radio__flag">实验性</span>
      </label>
    </div>

    <!-- 复选行：模块 / 工程开关。多选，且每项都有一行说明要读，所以保持纵向。 -->
    <div v-else-if="group.renderAs === 'checks'" class="row-stack">
      <label
        v-for="opt in group.options"
        :key="opt.value"
        class="row"
        :class="{ 'is-blocked': blocked.has(opt.value) }"
      >
        <input
          type="checkbox"
          :value="opt.value"
          :checked="isSelected(opt.value)"
          :disabled="blocked.has(opt.value)"
          @change="toggle(opt.value, ($event.target as HTMLInputElement).checked)"
        >
        <strong>{{ opt.label }}</strong>
        <span class="desc">{{ opt.desc }}</span>
        <!-- 勾选后展开「会带来什么」：附带生成的文件 -->
        <span v-if="isSelected(opt.value) && opt.files?.length" class="desc">
          附带文件：{{ opt.files.join('、') }}
        </span>
        <span v-if="isSelected(opt.value) && opt.note" class="desc">{{ opt.note }}</span>
      </label>
    </div>

    <!-- 兜底：renderAs 落到联合类型之外时必须**吵**。
         静默不渲染的后果是「某个分组整块消失」，而控制台干干净净 —— 极难定位。
         服务端的 assertShape 只校验选择、不校验这个字段，所以守在这里。 -->
    <div v-else class="hint hint--block">
      未知的控件形态 renderAs={{ group.renderAs }}，分组「{{ group.label }}」未能渲染。请检查 server/utils/wizard/options.json。
    </div>
  </fieldset>
</template>
