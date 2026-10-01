<script setup lang="ts">
/**
 * 引导期的首页 —— 唯一的作用是把人送到选择页。
 *
 * 为什么用服务端重定向（redirectCode）而不是客户端 navigateTo：
 * 客户端跳转不会重新请求 HTML，也就拿不到注入在 /setup 里的令牌，
 * 于是「打开首页 → 跳选择页 → 点什么都是 403」。
 *
 * 初始化后本文件会被 scripts/templates/baseline/app/pages/index.vue 覆盖成真正的首页，
 * 所以这里不需要考虑「初始化之后长什么样」。
 */
await navigateTo('/setup', { redirectCode: 302 });
</script>

<template>
  <div />
</template>
