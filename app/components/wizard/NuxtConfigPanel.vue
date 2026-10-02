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
 *
 * 栏目说明也一并撤了：这一侧的语义已经由标题与卡片标题说清，「这一侧决定怎么跑」
 * 是读一次就不再看的字，占着版面反而稀释卡片之间的层次。唯一保留的说明在页首
 * （见 app/pages/setup/index.vue），那句是对整个选择页说的。
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
  <!-- wizard__stack 与左栏共用同一套纵向节奏（列内间距、分组间距都由它定）。
       少了这层 flex 容器，右栏的卡片之间就没有间距，会贴成一片。 -->
  <section class="wizard__stack">
    <h2>Nuxt 配置</h2>

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
