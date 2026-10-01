<script setup lang="ts">
/**
 * 右区容器：渲染「运行形态与工程配置」这一侧的分组，并给出「将会写入哪些配置区间」。
 *
 * 为什么不把分组直接摊在页面里：右区与左区的语义不同 ——
 * 左区是技术栈身份（选完基本不会改），右区是运行形态与工程配置（初始化后常常手动再调）。
 * 把这份差异收在一个组件里，页面只剩下「左 / 右 / 底」三块。
 */
import type { InitPlan, OptionGroup, Selection } from '~/utils/wizard/option-model';

const props = defineProps<{
  groups: OptionGroup[];
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
