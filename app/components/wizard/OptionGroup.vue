<script setup lang="ts">
/**
 * 渲染一个分组。三种控件形态由 options.json 的 `renderAs` 决定，组件不猜。
 *
 * 为什么用原生 <input type="radio|checkbox">：
 * ① 键盘导航、屏幕阅读器语义、焦点管理全部白送，自己用 div 造要写两百行还写不对；
 * ② 引导期是零依赖的（dependencies 里只有 nuxt），不能用组件库；
 * ③ 这些组件会在初始化时被删除 —— 不值得为它引入任何依赖。
 * 样式靠 :checked 与 :has() 完成，见 app/assets/styles/wizard.css。
 */
import type { OptionGroup, Selection } from '~/utils/wizard/option-model';

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

function onChange(event: Event): void {
  pick((event.target as HTMLSelectElement).value);
}
</script>

<template>
  <fieldset class="group">
    <legend>{{ group.label }}</legend>
    <p v-if="group.desc" class="group__desc">
      {{ group.desc }}
    </p>

    <!-- 单选按钮组：左侧技术栈用它。标签一行、说明另起一行缩进，
         与 Spring Initializr 的左栏一致 —— 扫视时先比名字，不用先读一屏说明。 -->
    <div v-if="group.renderAs === 'radios'" class="radio-stack">
      <label
        v-for="opt in group.options"
        :key="opt.value"
        class="radio"
        :class="{ 'is-active': isSelected(opt.value), 'is-blocked': blocked.has(opt.value) }"
      >
        <input
          type="radio"
          :name="group.key"
          :value="opt.value"
          :checked="isSelected(opt.value)"
          :disabled="blocked.has(opt.value)"
          @change="pick(opt.value)"
        >
        <span class="radio__head">
          <strong>{{ opt.label }}</strong>
          <span v-if="opt.experimental" class="radio__flag">实验性</span>
        </span>
        <span v-if="opt.desc" class="radio__desc">{{ opt.desc }}</span>
        <span v-if="opt.note" class="radio__note">{{ opt.note }}</span>
        <span v-if="opt.experimental" class="radio__note">
          {{ opt.experimentalReason || '尚未稳定，需用 CLI 的 --force-experimental 显式开启' }}
        </span>
      </label>
    </div>

    <!-- 卡片单选：渲染模式用它（右侧，需要容纳每项更长的说明） -->
    <div v-else-if="group.renderAs === 'cards'" class="card-stack">
      <label
        v-for="opt in group.options"
        :key="opt.value"
        class="card"
        :class="{ 'is-active': isSelected(opt.value), 'is-blocked': blocked.has(opt.value) }"
      >
        <input
          type="radio"
          :name="group.key"
          :value="opt.value"
          :checked="isSelected(opt.value)"
          :disabled="blocked.has(opt.value)"
          @change="pick(opt.value)"
        >
        <strong>{{ opt.label }}</strong>
        <span class="desc">{{ opt.desc }}</span>
        <!-- 卡片底部这行小字是刻意的：用户不是不知道该选哪个，而是不知道选了会带来什么 -->
        <span v-if="opt.note" class="note">{{ opt.note }}</span>
        <span v-if="opt.experimental" class="note">
          实验性：{{ opt.experimentalReason || '尚未稳定，需用 CLI 的 --force-experimental 显式开启' }}
        </span>
      </label>
    </div>

    <!-- 复选行：模块 / 工程开关 -->
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

    <!-- 下拉单选：取值多但语义简单的分组（包管理器） -->
    <div v-else class="select-row">
      <label :for="`select-${group.key}`">{{ group.label }}</label>
      <select :id="`select-${group.key}`" :value="String(current ?? '')" @change="onChange">
        <option
          v-for="opt in group.options"
          :key="opt.value"
          :value="opt.value"
          :disabled="blocked.has(opt.value)"
        >
          {{ opt.label }}
        </option>
      </select>
    </div>
  </fieldset>
</template>
