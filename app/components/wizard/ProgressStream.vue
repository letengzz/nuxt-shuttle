<script setup lang="ts">
/**
 * 进度面板：五阶段步骤条 + 原始日志 + 执行摘要。
 *
 * 两种驱动方式共用一个面板：
 *   stream —— 本页开着 SSE，实时推进
 *   poll   —— 本页是刷新后重进的，靠 /api/wizard/status 每 2 秒看一次锁文件
 * 两边的表现必须一致，否则「刷新后看到的东西不一样」会让用户以为出了新问题。
 *
 * 一条原则：**错误原文不美化**。失败时把引擎的原始输出整段放在可折叠区里 ——
 * 排障时那行字比任何友好文案都有用。
 */
import type { InitPlan } from '~/utils/wizard/option-model';

const props = defineProps<{
  stages: readonly { key: string; label: string }[];
  stageIndex: number;
  status: string;
  mode: string;
  logs: { level: 'info' | 'error'; line: string }[];
  exitCode: number | null;
  error: string;
  enginePlan: InitPlan | null;
  remote: {
    locked: boolean;
    processAlive: boolean;
    initialized: boolean;
    manager: string;
    lock: { stage?: string; error?: string | null; startedAt?: string } | null;
    wizard: { total: number; present: number };
  } | null;
}>();

const emit = defineEmits<{ detach: []; retry: []; refresh: [] }>();

const logBox = ref<HTMLElement | null>(null);

/** 新日志到达就滚到底：否则用户要手动拖，而失败往往发生在最后几行。 */
watch(
  () => props.logs.length,
  async () => {
    await nextTick();
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
  },
);

function stepClass(index: number): Record<string, boolean> {
  return {
    'is-active': index === props.stageIndex && props.status === 'running',
    'is-done': props.status === 'done' || (props.stageIndex > -1 && index < props.stageIndex),
  };
}
</script>

<template>
  <section class="progress">
    <h2>初始化进度</h2>

    <ol class="steps">
      <li v-for="(stage, index) in stages" :key="stage.key" :class="stepClass(index)">
        {{ index + 1 }}. {{ stage.label }}
      </li>
    </ol>

    <div v-if="mode === 'poll'" class="hint hint--info">
      本页没有连着实时进度流，正在通过锁文件每 2 秒查看一次。引擎在独立进程里继续执行，
      关闭或刷新页面都不会中断它。
    </div>

    <div v-if="error" class="hint hint--block">
      {{ error }}
    </div>

    <div v-if="status === 'done'" class="summary">
      <strong>初始化完成。</strong>
      <p>
        引导器已自删（引导文件残留
        <template v-if="remote">{{ remote.wizard.present }} / {{ remote.wizard.total }}</template>
        <template v-else>未知</template>
        ），产物是一份干净的普通 Nuxt 工程。下一步：
      </p>
      <pre class="log__line">pnpm dev        # 启动开发服务，现在打开的就是你自己的首页</pre>
      <p>
        <a href="/">打开首页</a>（整页跳转，避免用被删除的路由继续导航）
      </p>
    </div>

    <details class="preview" open>
      <summary>执行摘要与原始日志（{{ logs.length }} 行）</summary>

      <dl class="stack-kv">
        <template v-if="enginePlan">
          <dt>包管理器</dt><dd>{{ enginePlan.lockfile }}</dd>
          <dt>运行时依赖</dt><dd>{{ enginePlan.deps.length }} 个</dd>
          <dt>开发依赖</dt><dd>{{ enginePlan.devDeps.length }} 个</dd>
          <dt>Nuxt 模块</dt><dd>{{ enginePlan.modules.length }} 个</dd>
          <dt>删除文件</dt><dd>{{ enginePlan.deleteFiles.length }} 个</dd>
          <dt>生成文件</dt><dd>{{ enginePlan.generatedFiles.length }} 个</dd>
          <dt>样式入口</dt><dd>{{ enginePlan.cssEntries.join(' → ') }}</dd>
        </template>
        <template v-else>
          <dt>引擎计划</dt><dd>尚未上报</dd>
        </template>

        <template v-if="remote">
          <dt>锁文件</dt>
          <dd>{{ remote.locked ? `存在（阶段：${remote.lock?.stage ?? '未知'}）` : '不存在' }}</dd>
          <dt>引擎进程</dt>
          <dd>{{ remote.locked ? (remote.processAlive ? '存活' : '已退出（残锁）') : '—' }}</dd>
          <dt>已初始化</dt><dd>{{ remote.initialized ? '是' : '否' }}</dd>
          <dt>引导文件残留</dt><dd>{{ remote.wizard.present }} / {{ remote.wizard.total }}</dd>
        </template>
      </dl>

      <div ref="logBox" class="log">
        <p v-if="!logs.length" class="preview__empty">
          暂无输出。
        </p>
        <p
          v-for="(entry, index) in logs"
          :key="index"
          class="log__line"
          :class="{ 'log__line--error': entry.level === 'error' }"
        >
          {{ entry.line }}
        </p>
      </div>
    </details>

    <div class="wizard__footer">
      <span class="wizard__footer-status">
        <template v-if="status === 'running'">执行中，请不要关闭标签页。</template>
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
  </section>
</template>
