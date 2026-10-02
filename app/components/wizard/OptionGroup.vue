<script setup lang="ts">
/**
 * 渲染一个分组。两种控件形态由 options.json 的 `renderAs` 决定，组件不猜：
 *   `radios` —— 横向单选按钮组。组内互斥，候选彼此相邻才好比。
 *   `checks` —— 「右上角新增 + 下方可滑动列表」的多选面板。候选默认不占版面，
 *               说明与「会装什么」收进「新增」弹窗，需要时再看。
 *
 * 形态之上套一层统一的「卡片」：每个分组都是一张带左侧品牌色竖条的卡片，
 * 组标题就是卡片标题 —— 单选组由 <legend> 骑在上边框上，多选组由 .panel 的面板头充当。
 *
 * 分组说明（`group.desc`）**不再渲染在页面上**：七段说明里只有页首那句是对整页说的，
 * 其余六段都在重复标题已经表达的事（如「UI 框架：决定组件从哪来」），撤掉卡片之间才有层次。
 * `group.desc` 仍有一个去处 —— 多选弹窗的引导语，那里是「正要挑东西」的上下文。
 *
 * 为什么用原生 <input> 与 <dialog>：
 * ① 键盘导航、屏幕阅读器语义、焦点管理、Esc 关闭、焦点陷阱、遮罩层全部白送，
 *    自己用 div 造要写两百行还写不对；
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

/**
 * 是不是「多选面板」形态。
 * 多选面板把标题放进面板头（右上角要挂「新增」），所以它没有 <legend>，
 * 分组名改由 fieldset 的 aria-label 提供 —— 见模板里的注释。
 */
const isPanel = computed(() => props.group.renderAs === 'checks');

/** 面板里列出的是**已加入的项**，按 options.json 的顺序而不是点击顺序。 */
const selected = computed(() => {
  const picked = current.value;
  const list = Array.isArray(picked) ? picked : [];
  return props.group.options.filter((opt) => list.includes(opt.value));
});

/* ------------------------------------------------------------------ *
 * 「新增」弹窗
 * ------------------------------------------------------------------ */

const picker = ref<HTMLDialogElement | null>(null);

/**
 * 草稿：勾选先落在草稿上，点「确定」才写回。
 * 直接改 selection 会让「取消」失去意义 —— 用户会以为没生效，其实已经改了。
 */
const draft = ref<string[]>([]);

function openPicker(): void {
  const picked = current.value;
  draft.value = Array.isArray(picked) ? [...picked] : [];
  picker.value?.showModal();
}

function closePicker(): void {
  picker.value?.close();
}

function toggleDraft(value: string, checked: boolean): void {
  // 只有「加进来」需要拦；「移出去」永远允许 —— 否则某个选项被规则禁掉之后，
  // 它会卡在列表里出不去，用户只能清空重来。
  if (checked && props.blocked.has(value)) return;
  draft.value = checked
    ? [...new Set([...draft.value, value])]
    : draft.value.filter((v) => v !== value);
}

function confirmDraft(): void {
  // 写回时按 options.json 的顺序排一遍：勾选顺序会经 URL 与 localStorage 泄漏出去，
  // 同样的选择应该得到同样的链接。
  const next = props.group.options.map((opt) => opt.value).filter((v) => draft.value.includes(v));
  emit('update:modelValue', { ...props.modelValue, [props.group.key]: next });
  closePicker();
}

/** 点遮罩关闭。panel 铺满了 dialog 的盒子（.modal 无 padding），
 *  所以「事件目标是 dialog 自己」只可能是点在遮罩上。 */
function onBackdropClick(event: MouseEvent): void {
  if (event.target === picker.value) closePicker();
}

/* ------------------------------------------------------------------ *
 * 单选与移除
 * ------------------------------------------------------------------ */

function pick(value: string): void {
  if (props.blocked.has(value)) return;
  emit('update:modelValue', { ...props.modelValue, [props.group.key]: value });
}

/** 从面板里移掉一项。不做 blocked 拦截 —— 理由同 toggleDraft。 */
function remove(value: string): void {
  const list = Array.isArray(current.value) ? [...current.value] : [];
  emit('update:modelValue', {
    ...props.modelValue,
    [props.group.key]: list.filter((v) => v !== value),
  });
}

function isSelected(value: string): boolean {
  const selectedValue = current.value;
  return Array.isArray(selectedValue) ? selectedValue.includes(value) : selectedValue === value;
}

/**
 * 悬停提示：把「说明 + 会装什么 + 实验性原因」拼成一段。
 *
 * 两种形态都靠它兜住细节 —— 卡片时代那些一直占着版面的小字，现在改成需要时才展开。
 * 用 title 而不是自造 tooltip 是因为按 HTML-AAM，title 就是表单控件的
 * accessible description，屏幕阅读器拿得到同一份内容，不是只给鼠标用的。
 */
function hintFor(opt: OptionItem): string {
  const parts = [opt.desc, opt.note];
  if (opt.files?.length) parts.push(`附带文件：${opt.files.join('、')}`);
  if (opt.experimental) {
    parts.push(`实验性：${opt.experimentalReason || '尚未稳定，需用 CLI 的 --force-experimental 显式开启'}`);
  }
  return parts.filter(Boolean).join('\n');
}
</script>

<template>
  <!-- 单选组：fieldset 自己就是卡片（.group--card），<legend> 只能待在上边框上，
       正好当卡片标题 —— 它不是可换位置的装饰，是 fieldset 语义的一部分。
       多选面板：卡片由 .panel 充当（面板头右侧要挂「新增」），fieldset 退成无框容器，
       分组名交给 aria-label —— 否则屏幕阅读器只会念出「分组」两个字。 -->
  <fieldset
    class="group"
    :class="isPanel ? 'group--panel' : 'group--card'"
    :aria-label="isPanel ? group.label : undefined"
  >
    <legend v-if="!isPanel">{{ group.label }}</legend>

    <!-- 横向单选按钮组：每个候选占一个「○ 名称」的小块，整组左右排开、一行放不下才换行。
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

    <!-- 多选面板：标题与「新增」在面板头，下面是**已加入项**的可滑动列表。
         为什么不再把全部候选摊成复选行：模块与工程开关是「按需追加」，
         候选多数时候是没被选中的，把它们的说明一直挂在版面上，
         换来的是「每次都要滚过一段与自己无关的文字」。 -->
    <div v-else-if="group.renderAs === 'checks'" class="panel">
      <div class="panel__head">
        <h3 class="panel__title">{{ group.label }}</h3>
        <span class="panel__count">{{ selected.length }} / {{ group.options.length }}</span>
        <button type="button" class="panel__add" @click="openPicker()">
          新增
        </button>
      </div>

      <ul class="panel__list">
        <li
          v-for="opt in selected"
          :key="opt.value"
          class="panel__item"
          :title="hintFor(opt)"
        >
          <span class="panel__item-label">{{ opt.label }}</span>
          <span v-if="opt.experimental" class="radio__flag">实验性</span>
          <button
            type="button"
            class="panel__remove"
            :aria-label="`移除 ${opt.label}`"
            @click="remove(opt.value)"
          >
            移除
          </button>
        </li>
        <li v-if="!selected.length" class="panel__empty">
          还没有添加，点右上角「新增」挑一个。
        </li>
      </ul>
    </div>

    <!-- 兜底：renderAs 落到联合类型之外时必须**吵**。
         静默不渲染的后果是「某个分组整块消失」，而控制台干干净净 —— 极难定位。
         服务端的 assertShape 只校验选择、不校验这个字段，所以守在这里。 -->
    <div v-else class="hint hint--block">
      未知的控件形态 renderAs={{ group.renderAs }}，分组「{{ group.label }}」未能渲染。请检查 server/utils/wizard/options.json。
    </div>

    <!-- 「新增」弹窗。用原生 <dialog> + showModal()：焦点陷阱、Esc、遮罩、
         背景惰性化都是浏览器给的，零依赖也拿得到一套正确的模态行为。 -->
    <dialog
      v-if="isPanel"
      ref="picker"
      class="modal modal--picker"
      :aria-labelledby="`picker-title-${group.key}`"
      @click="onBackdropClick"
    >
      <div class="modal__panel">
        <header class="modal__head">
          <h2 :id="`picker-title-${group.key}`" class="modal__title">
            新增 · {{ group.label }}
          </h2>
          <button type="button" class="modal__close" aria-label="关闭" @click="closePicker()">
            ×
          </button>
        </header>

        <div class="modal__body">
          <p class="modal__lead">
            <template v-if="group.desc">{{ group.desc }} </template>
            勾选后点「确定」写回；已选中的取消勾选即为移除。
          </p>

          <label
            v-for="opt in group.options"
            :key="opt.value"
            class="pick"
            :class="{ 'is-checked': draft.includes(opt.value), 'is-blocked': blocked.has(opt.value) }"
          >
            <input
              type="checkbox"
              :value="opt.value"
              :checked="draft.includes(opt.value)"
              :disabled="blocked.has(opt.value)"
              @change="toggleDraft(opt.value, ($event.target as HTMLInputElement).checked)"
            >
            <strong>{{ opt.label }}</strong>
            <span class="desc">{{ opt.desc }}</span>
            <span v-if="opt.files?.length" class="desc">
              附带文件：{{ opt.files.join('、') }}
            </span>
            <span v-if="opt.note" class="desc">{{ opt.note }}</span>
            <span v-if="opt.experimental" class="desc desc--warn">
              实验性：{{ opt.experimentalReason || '尚未稳定，需用 CLI 的 --force-experimental 显式开启' }}
            </span>
            <span v-if="blocked.has(opt.value)" class="desc desc--warn">
              与当前其余选择冲突，不可选。
            </span>
          </label>
        </div>

        <footer class="modal__foot">
          <span class="modal__note">已勾选 {{ draft.length }} / {{ group.options.length }} 项</span>
          <button type="button" @click="closePicker()">
            取消
          </button>
          <button type="button" data-primary @click="confirmDraft()">
            确定
          </button>
        </footer>
      </div>
    </dialog>
  </fieldset>
</template>
