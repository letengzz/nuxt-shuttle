<script setup lang="ts">
/**
 * 右区容器：渲染「运行形态与工程配置」这一侧的分组，并给出「将会写入哪些配置区间」。
 *
 * 为什么不把分组直接摊在页面里：右区与左区的语义不同 ——
 * 左区是技术栈身份（选完基本不会改），右区是运行形态与工程配置（初始化后常常手动再调）。
 * 把这份差异收在一个组件里，页面只剩下「左 / 右 / 底」三块。
 */
// 类型改名为 OptionGroupSpec：下面还要 import 同名的**组件** OptionGroup，
// 而 `<script setup>` 里一个标识符只能有一个声明 —— 两者同名会被
// @vue/compiler-sfc 直接判成「different imports aliased to same local name」而报错。
import type { InitPlan, OptionGroup as OptionGroupSpec, Selection } from '~/utils/wizard/option-model';
// 必须显式 import：Nuxt 对 components/wizard/ 下的组件按目录加前缀注册，
// 自动导入的名字是 WizardOptionGroup，模板里写 <OptionGroup> 会**静默**变成一个
// 未解析的自定义元素 —— 不报错、不警告，页面只是整块空白。
import OptionGroup from '~/components/wizard/OptionGroup.vue';

const props = defineProps<{
  groups: OptionGroupSpec[];
  modelValue: Selection;
  blockedFor: (key: string) => Set<string>;
  plan?: InitPlan | null;
}>();

const emit = defineEmits<{ 'update:modelValue': [Selection] }>();

/** 引擎会改写的 marker 区间键。计划算出来之后才有值 —— 那是「改哪里」的准确答案。 */
const sections = computed(() => props.plan?.sections ?? []);
</script>

<template>
  <section>
    <h2>Nuxt 配置</h2>
    <p class="group__desc">
      这一侧决定「怎么跑」。初始化后想调整，直接编辑 nuxt.config.ts 的手写区即可，不需要重跑引擎。
    </p>

    <OptionGroup
      v-for="group in groups"
      :key="group.key"
      :group="group"
      :model-value="modelValue"
      :blocked="blockedFor(group.key)"
      @update:model-value="emit('update:modelValue', $event)"
    />

    <div v-if="sections.length" class="preview">
      <h3>将写入的配置区间</h3>
      <ul class="preview__list">
        <li v-for="section in sections" :key="section">
          TEMPLATE:{{ section }}
        </li>
      </ul>
    </div>
  </section>
</template>
