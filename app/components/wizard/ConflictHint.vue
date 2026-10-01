<script setup lang="ts">
/**
 * 三层规则提示：block 红 / warn 黄 / info 灰。
 *
 * 只有 block 会影响「能不能提交」，但三类提示都要显示 ——
 * warn 与 info 的价值是「告诉用户代价是什么」，而不是拦人。
 */
import type { Conflict, RuleLevel } from '~/utils/wizard/option-model';

defineProps<{
  conflicts: Conflict[];
  /** 没有冲突时的占位文案 */
  emptyText?: string;
}>();

const LABEL: Record<RuleLevel, string> = {
  block: '阻断',
  warn: '提醒',
  info: '说明',
};
</script>

<template>
  <div v-if="conflicts.length" class="hint-list">
    <div v-for="(conflict, index) in conflicts" :key="`${conflict.rule ?? index}`" class="hint" :class="`hint--${conflict.level}`">
      <strong>{{ LABEL[conflict.level] }}：</strong>{{ conflict.message }}
    </div>
  </div>
  <p v-else-if="emptyText" class="preview__empty">
    {{ emptyText }}
  </p>
</template>
