<script setup lang="ts">
/**
 * 进度页底部吸附区的内容：状态一句 + 操作按钮（失败时多一段自助说明）。
 *
 * 为什么从 ProgressStream 里拆出来：进度面板是「往下滚的内容」，操作条是「必须一直
 * 留在视线里的东西」—— 尤其「中断进度流」，日志刷起来之后你得能立刻按到它。
 * 两者混在一个组件里就只能一起待在滚动区，日志一长按钮就滚出屏幕。
 * 拆开之后进度页的结构与选择页完全同构：外壳固定一屏高 + 内容层自己滚 + 吸附区钉在下方。
 *
 * 面板本身（阶段条 / 日志 / 执行摘要）不在这里，它跟着内容一起滚。
 *
 * 注意产物形态：这个组件的根是 `.wizard__footer` 本身，父级只负责给它一个
 * `.wizard__dock` 容器 —— 吸附区「不被压缩」那条样式（flex: none）挂在容器上，
 * 挂在内容上是不生效的。
 */
defineProps<{
  status: string;
  exitCode: number | null;
}>();

const emit = defineEmits<{ detach: []; retry: []; refresh: [] }>();
</script>

<template>
  <!-- 一条分隔线把它和上面的进度面板分开：底部操作条不属于内容区，
       没有这条线时它看起来像日志框的最后一行。 -->
  <div class="wizard__footer">
    <span class="wizard__footer-status">
      <template v-if="status === 'running'">执行中，请不要关闭标签页。</template>
      <template v-else-if="status === 'done'">初始化已完成。</template>
      <template v-else-if="status === 'failed'">
        退出码 {{ exitCode ?? '—' }}。失败时引擎会<strong>保留</strong>锁文件，避免你在半删状态下重跑。
      </template>
    </span>

    <button v-if="status === 'running'" type="button" @click="emit('detach')">
      中断进度流
    </button>
    <button v-if="status === 'failed'" type="button" @click="emit('refresh')">
      查看最新状态
    </button>
    <button v-if="status === 'failed'" type="button" @click="emit('retry')">
      返回并重试
    </button>
  </div>

  <p v-if="status === 'failed'" class="preview__empty">
    如果确认需要撤销这次未完成的初始化，在仓库根目录执行 <code>node scripts/init.mjs --rollback</code>；
    锁文件里保留了开始时的选择快照与失败原因。
  </p>
</template>
