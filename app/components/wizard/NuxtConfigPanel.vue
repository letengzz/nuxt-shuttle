<script setup lang="ts">
/**
 * 右栏容器：渲染「运行形态与工程配置」这一侧的分组。
 *
 * 为什么不把分组直接摊在页面里：右栏与左栏的语义不同 ——
 * 左栏是技术栈身份（选完基本不会改），右栏是运行形态与工程配置（初始化后常常手动再调）。
 * 把这份差异收在一个组件里，页面只剩下「左栏 / 右栏 / 底部操作条」三块。
 *
 * 这里只放控件，不放任何「计划产物」。原先它底部挂着「将写入的配置区间」，
 * 但那与依赖清单、删除文件同源，都是**预览变更**的结果 ——
 * 已经一起搬进 DependencyPreview 的弹窗，右栏于是语义单一：改配置的地方。
 */
// 类型改名为 OptionGroupSpec：下面还要 import 同名的**组件** OptionGroup，
// 而 `<script setup>` 里一个标识符只能有一个声明 —— 两者同名会被
// @vue/compiler-sfc 直接判成「different imports aliased to same local name」而报错。
import type { OptionGroup as OptionGroupSpec, Selection } from '~/utils/wizard/option-model';
// 必须显式 import：Nuxt 对 components/wizard/ 下的组件按目录加前缀注册，
// 自动导入的名字是 WizardOptionGroup，模板里写 <OptionGroup> 会**静默**变成一个
// 未解析的自定义元素 —— 不报错、不警告，页面只是整块空白。
import OptionGroup from '~/components/wizard/OptionGroup.vue';

defineProps<{
  groups: OptionGroupSpec[];
  modelValue: Selection;
  blockedFor: (key: string) => Set<string>;
}>();

const emit = defineEmits<{ 'update:modelValue': [Selection] }>();
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
  </section>
</template>
