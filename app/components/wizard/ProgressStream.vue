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
 *
 * 职责边界：**只渲染会滚动的进度内容**。执行期那几个按钮（中断 / 查看最新状态 /
 * 返回并重试）在 ProgressActions 里，由页面放进底部吸附区 —— 它们必须一直可见，
 * 混进这一层就会被长日志顶出屏幕。
 */
import type { InitPlan, WizardSchema } from '~/utils/wizard/option-model';

const props = defineProps<{
  stages: readonly { key: string; label: string }[];
  stageIndex: number;
  status: string;
  mode: string;
  logs: { id: number; level: 'info' | 'error'; line: string }[];
  error: string;
  enginePlan: InitPlan | null;
  /** 引擎记录的开始时间（start 时取本机时钟，轮询后以锁文件里的为准） */
  startedAt: string | null;
  /** 候选清单：把锁文件里记录的选择快照翻译成人类可读的标签用 */
  schema: WizardSchema | null;
  /** 轮询通道的瞬时失败标记（useWizard.pollDegraded）：亮一条可自愈的提示 */
  pollDegraded: boolean;
  remote: {
    locked: boolean;
    processAlive: boolean;
    initialized: boolean;
    manager: string;
    lock: { stage?: string; error?: string | null; startedAt?: string; logFile?: string | null; selection?: Record<string, unknown> } | null;
    wizard: { total: number; present: number };
  } | null;
}>();

const logBox = ref<HTMLElement | null>(null);

/**
 * 智能跟随：只有当视口本来就贴着底部时，新日志才把视口拉到底。
 *
 * 为什么不是「来一行就滚一次」：失败的原因往往在**前**几行（比如 install 阶段
 * 第一条 registry 报错），用户往上翻日志时，每来一行就被拽回底部，
 * 根本读不成。判断「用户是否贴底」（距底 48px 以内算贴底——容忍亚像素误差），
 * 贴底才跟随；用户上翻了就让他读完，自己滚回去再恢复跟随。
 */
const followBottom = ref(true);

function onLogScroll(): void {
  const el = logBox.value;
  if (!el) return;
  followBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

watch(
  () => props.logs.length,
  async () => {
    if (!followBottom.value) return;
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

/** 当前正在执行的阶段。aria-current 让屏幕阅读器直接念出「这一步正在进行」。 */
function stepCurrent(index: number): 'step' | undefined {
  return index === props.stageIndex && props.status === 'running' ? 'step' : undefined;
}

/**
 * 完成提示里的启动命令。包管理器是引擎按 lockfile 探测的事实，不是固定值 ——
 * 以前硬编码 `pnpm dev`，npm 仓库的用户会拿到一条跑不通的命令。
 * 引擎计划（plan 事件）是第一判据；poll 模式下没等到 plan 事件时退回 /status 的探测结果。
 */
const managerBin = computed(() => {
  const lockfile = props.enginePlan?.lockfile;
  if (lockfile === 'npm' || lockfile === 'pnpm') return lockfile;
  const remote = props.remote?.manager;
  if (remote === 'npm' || remote === 'pnpm') return remote;
  return 'pnpm';
});

/* 已运行时长：startedAt 在手才显示。每秒跳一次的只有这一个 ref，代价可以忽略。 */
const now = ref(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  tickTimer = setInterval(() => {
    // 终态（done / failed）后不再写 now：写一次 state 就是一次组件重渲，
    // 页面挂在后台几小时的话白烧几万次渲染。
    if (props.status === 'running') now.value = Date.now();
  }, 1000);
});
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
});

const elapsedText = computed(() => {
  if (props.status !== 'running' || !props.startedAt) return '';
  const started = Date.parse(props.startedAt);
  if (!Number.isFinite(started)) return '';
  const totalSec = Math.max(0, Math.floor((now.value - started) / 1000));
  const minutes = Math.floor(totalSec / 60);
  return minutes ? `${minutes} 分 ${totalSec % 60} 秒` : `${totalSec} 秒`;
});

/**
 * 「本次初始化的选择」：来自锁文件里的选择快照（引擎启动时写入）。
 *
 * 它存在的理由：刷新后重进、或换标签页打开时，enginePlan（plan 事件）早已不在
 * 模块级状态里 —— 用户看到的进度页只有阶段与日志，看不出「正在初始化成什么」。
 * 锁文件快照恰好补上这个缺口；引擎跑完后锁被删除，这个块也随之消失，不与
 * 执行摘要里的依赖清单重复。标签尽量用候选名翻译，schema 没到手时原样显示 value。
 */
const selectionSummary = computed(() => {
  const selection = props.remote?.lock?.selection;
  if (!selection || typeof selection !== 'object') return [];
  const groups = props.schema?.groups ?? [];
  const rows: { key: string; label: string; value: string }[] = [];
  for (const [key, raw] of Object.entries(selection)) {
    if (raw === undefined || raw === null || raw === '') continue;
    const group = groups.find((g) => g.key === key);
    const values = Array.isArray(raw) ? raw : [raw];
    const text = values.map((v) => group?.options.find((o) => o.value === v)?.label ?? String(v)).join('、');
    if (!text) continue;
    rows.push({ key, label: group?.label ?? key, value: text });
  }
  return rows;
});

/**
 * 「复制日志」：把当前展示的日志整段写进剪贴板，供贴进 issue / 发给维护者。
 *
 * 为什么复制**展示层**而不是读引擎日志文件：展示层已经做了事件 → 可读行
 * 的翻译（logForEvent），失败时用户看到什么就能复制什么，不用再解释
 * 「日志文件里那行 JSON 事件怎么读」。剪贴板被拒（非安全上下文等）时
 * 降级成可选中文字的原样输出 —— 日志区本来就允许选中，只把按钮做成加速器。
 */
const copyState = ref<'idle' | 'copied' | 'failed'>('idle');
let copyTimer: ReturnType<typeof setTimeout> | null = null;

/** 「复制」与「下载」共用同一份展示层文本，避免两处拼接日后各说各话。 */
const logText = computed(() => props.logs.map((entry) => entry.line).join('\n'));

async function copyLogs(): Promise<void> {
  try {
    await navigator.clipboard.writeText(logText.value);
    copyState.value = 'copied';
  } catch {
    copyState.value = 'failed';
  }
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copyState.value = 'idle';
    copyTimer = null;
  }, 2500);
}

/**
 * 下载日志：剪贴板权限被拒、或日志长到不适合粘贴时，直接存成 .log 贴 issue。
 * 与「复制日志」同源（展示层已翻译成可读行），不读引擎的完整日志文件 ——
 * 用户看到什么就拿到什么，不必解释 JSON 事件怎么读。
 */
function downloadLogs(): void {
  const url = URL.createObjectURL(new Blob([logText.value], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `nuxt-shuttle-init-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.log`;
  anchor.click();
  URL.revokeObjectURL(url);
}

onUnmounted(() => {
  if (copyTimer) clearTimeout(copyTimer);
});
</script>

<template>
  <section class="progress">
    <h2>初始化进度</h2>

    <ol class="steps">
      <li
        v-for="(stage, index) in stages"
        :key="stage.key"
        :class="stepClass(index)"
        :aria-current="stepCurrent(index)"
      >
        {{ index + 1 }}. {{ stage.label }}
      </li>
    </ol>

    <p v-if="elapsedText" class="steps__elapsed">
      已运行 {{ elapsedText }}
    </p>

    <!-- 选择快照：只在「锁还在、引擎计划还没到手」的恢复场景有信息增量；
         引擎跑完锁被删，这个块随之消失。 -->
    <div v-if="selectionSummary.length" class="summary">
      <strong>本次初始化的选择</strong>
      <dl class="stack-kv">
        <template v-for="row in selectionSummary" :key="row.key">
          <dt>{{ row.label }}</dt>
          <dd>{{ row.value }}</dd>
        </template>
      </dl>
    </div>

    <div v-if="mode === 'poll'" class="hint hint--info">
      本页没有连着实时进度流，正在通过锁文件每 2 秒查看一次。引擎在独立进程里继续执行，
      关闭或刷新页面都不会中断它。
    </div>

    <!-- 轮询通道的瞬时失败：可自愈，所以是 warn 不是 block —— 不写成「初始化失败」，
         只说明这一轮查询没打通，下一轮（2 秒后）会自动重试。 -->
    <div v-if="pollDegraded" class="hint hint--warn" role="status" aria-live="polite">
      状态查询暂时失败（网络抖动或开发服务正在重启），下一轮会自动重试，无需刷新页面。
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
      <pre class="log__line">{{ managerBin }} dev        # 启动开发服务，现在打开的就是你自己的首页</pre>
      <p>
        <a href="/">打开首页</a>（整页跳转，避免用被删除的路由继续导航）
      </p>
    </div>

    <details class="preview" open>
      <summary>执行摘要与原始日志（{{ logs.length }} 行）</summary>

      <!-- 复制的是展示层文本（事件已被翻译成可读行）：排障时用户看到什么就能贴什么 -->
      <div class="log-tools">
        <button
          type="button"
          :disabled="!logs.length"
          :title="logs.length ? '把当前展示的日志整段复制到剪贴板，可直接贴进 issue' : '暂无日志可复制'"
          @click="copyLogs()"
        >
          {{ copyState === 'copied' ? '已复制' : copyState === 'failed' ? '复制失败，请手动选中日志区复制' : '复制日志' }}
        </button>
        <button
          type="button"
          :disabled="!logs.length"
          title="把当前展示的日志存成 .log 文件；页面日志最多保留 800 行，全文见执行摘要里的「日志文件」"
          @click="downloadLogs()"
        >
          下载日志
        </button>
      </div>

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
          <!-- 引擎完整落盘日志的位置：页面日志被截到 800 行（尾部），排障要全文时按这里去找 -->
          <template v-if="remote.lock?.logFile">
            <dt>日志文件</dt><dd>{{ remote.lock.logFile }}</dd>
          </template>
        </template>
      </dl>

      <!-- role="log"：ARIA 的日志语义自带 polite 宣告，屏幕阅读器知道这里是
           追加式输出，不会每次更新都从头念一遍。 -->
      <div ref="logBox" class="log" role="log" @scroll="onLogScroll">
        <p v-if="!logs.length" class="preview__empty">
          暂无输出。
        </p>
        <p
          v-for="entry in logs"
          :key="entry.id"
          class="log__line"
          :class="{ 'log__line--error': entry.level === 'error' }"
        >
          {{ entry.line }}
        </p>
      </div>
    </details>
  </section>
</template>
