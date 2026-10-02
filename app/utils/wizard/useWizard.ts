/**
 * 引导页的状态机与接口调用。
 *
 * 状态迁移（与设计文档里的图一致）：
 *   idle ──加载 schema──► selecting ──预览──► planned ──初始化──► running ──► done / failed
 *   selecting 与 planned 下改动任一选项都会退回 selecting（计划已过期）
 *
 * 两个刻意的设计决定：
 *
 * ① **状态放在模块级，而不是每次调用 useWizard() 新建一份。**
 *    /setup 与 /setup/progress 是两个路由、用同一个 composable。
 *    进度中途从选择页跳到进度页、或刷新后重进时，事件流与日志必须还在 ——
 *    「刷新就丢进度」尤其糟糕，因为刷新恰恰是用户遇到卡住时最自然的动作。
 *
 * ② **进度流用 fetch + 手写 SSE 解析，不用 EventSource。**
 *    这不是偏好问题：EventSource 无法自定义请求头，也就发不出 x-wizard-token，
 *    而令牌是闸 3 的唯一判据。用 fetch 读 body 流是唯一能带上令牌的做法。
 *    代价是要自己处理「一个事件可能被 TCP 分片切断」，见 readStream()。
 */
import { computed, reactive } from 'vue';
import type { Conflict, InitPlan, Rule, Selection, TemplateConfig, WizardSchema } from '~/utils/wizard/option-model';
import { STAGES } from '~/utils/wizard/option-model';

export type WizardStatus = 'idle' | 'loading' | 'selecting' | 'planned' | 'running' | 'done' | 'failed';

/** 进度来源：stream = 本页开着 SSE；poll = 本页是刷新后重进的，靠轮询锁文件；idle = 没在跑 */
export type WizardMode = 'idle' | 'stream' | 'poll';

interface LogLine {
  level: 'info' | 'error';
  line: string;
}

interface StatusPayload {
  locked: boolean;
  processAlive: boolean;
  initialized: boolean;
  manager: 'pnpm' | 'npm' | 'unknown';
  lock: { stage?: string; error?: string | null; startedAt?: string } | null;
  templateConfig: TemplateConfig | null;
  wizard: { total: number; present: number; missing: string[] };
  engine: { path: string; present: boolean };
}

const STORAGE_KEY = 'nuxt-shuttle:wizard-selection';
const POLL_INTERVAL_MS = 2000;

const state = reactive({
  status: 'idle' as WizardStatus,
  mode: 'idle' as WizardMode,
  /** 面向用户的整体说明（骨架态、令牌失效、失败原因） */
  message: '',
  schema: null as WizardSchema | null,
  selection: {} as Selection,
  /** 前端即时反馈用的规则命中（仅提示，服务端才是判据） */
  conflicts: [] as Conflict[],
  /** 「预览变更」算出的计划 */
  plan: null as InitPlan | null,
  /** 引擎自己算出的计划。与 plan 不一致就说明两边漂移了，必须显式告警 */
  enginePlan: null as InitPlan | null,
  previewing: false,
  /** 当前阶段下标，-1 表示还没开始 */
  stageIndex: -1,
  logs: [] as LogLine[],
  exitCode: null as number | null,
  error: '',
  remote: null as StatusPayload | null,
});

let streamController: AbortController | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unloadHandler: ((event: BeforeUnloadEvent) => void) | null = null;

/* ------------------------------------------------------------------ *
 * 令牌与请求
 * ------------------------------------------------------------------ */

interface WizardGlobals {
  wizardToken: string;
  apiBase: string;
}

function wizardGlobals(): WizardGlobals | null {
  if (!import.meta.client) return null;
  return (window as unknown as { __WIZARD__?: WizardGlobals }).__WIZARD__ ?? null;
}

/**
 * 带上令牌的请求。
 * 令牌由 dev-only 的 Nitro 插件注入到 / 与 /setup 的 HTML 里，
 * 跨站页面读不到我们的响应体，所以拿不到它。
 */
function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const globals = wizardGlobals();
  const headers = new Headers(init.headers);
  if (globals?.wizardToken) headers.set('x-wizard-token', globals.wizardToken);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(`${globals?.apiBase ?? '/api/wizard'}${path}`, { ...init, headers });
}

/** 把非 2xx 响应翻译成一句能照着排查的话，而不是「请求失败」。 */
async function describeFailure(res: Response): Promise<string> {
  let detail = '';
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as { statusMessage?: string; message?: string; data?: { reason?: string } };
    detail = parsed.data?.reason ?? parsed.statusMessage ?? parsed.message ?? text.slice(0, 300);
  } catch {
    detail = res.statusText;
  }
  if (res.status === 403) return `令牌校验失败（403）：${detail}。刷新页面会拿到新令牌。`;
  if (res.status === 404) return `接口不存在（404）：${detail}。开发服务可能不是以 dev 模式启动的。`;
  if (res.status === 409) return `已存在初始化锁（409）：${detail}`;
  if (res.status === 422) return `选择存在阻断级冲突（422）：${detail}`;
  if (res.status === 400) return `选择不合法（400）：${detail}`;
  return `${res.status} ${detail}`;
}

/* ------------------------------------------------------------------ *
 * 规则：前端即时反馈
 * ------------------------------------------------------------------ */

function matchCondition(key: string, expect: string | string[], selection: Selection): boolean {
  const actual = selection[key];
  if (Array.isArray(expect)) {
    return Array.isArray(actual) ? actual.some((v) => expect.includes(v)) : expect.includes(actual as string);
  }
  return actual === expect;
}

function ruleMatches(rule: Rule, selection: Selection): boolean {
  return Object.entries(rule.when).every(([key, expect]) => matchCondition(key, expect, selection));
}

/**
 * 本地跑一遍规则，只为「改一下就立刻有反应」。
 *
 * 这里确实与 shared/wizard/plan.mjs 的 validateSelection 重复了一份逻辑，
 * 是**故意**的：实时反馈如果也走一次网络，每次点击都要等一个往返。
 * 但它永远只是提示 —— 提交前的最终判据在服务端（见 WizardBackend 的 L3 校验），
 * 所以两边不一致的后果是「提示慢了/多了」，而不是「放过了非法组合」。
 */
function conflictsFor(schema: WizardSchema, selection: Selection): Conflict[] {
  const hits: Conflict[] = [];
  for (const rule of schema.rules) {
    if (ruleMatches(rule, selection)) {
      hits.push({ level: rule.level, message: rule.message, rule: rule.id ?? null });
    }
  }
  return hits;
}

/**
 * 被 block 规则禁掉的选项：分组 key → 该分组里不可选的 value 集合。
 *
 * 算法：对每条 block 规则，逐个条件看「其余条件都命中时，剩下这一项是否被禁」。
 * 单条件规则（如 vuetify-experimental）即「该项整体禁用」。
 * 这样加一条新规则只改 options.json，前端不用动。
 */
function blockedMap(schema: WizardSchema | null, selection: Selection): Map<string, Set<string>> {
  const blocked = new Map<string, Set<string>>();
  if (!schema) return blocked;

  const add = (key: string, values: string | string[]): void => {
    const set = blocked.get(key) ?? new Set<string>();
    for (const v of Array.isArray(values) ? values : [values]) set.add(v);
    blocked.set(key, set);
  };

  for (const rule of schema.rules) {
    if (rule.level !== 'block' || rule.experimental) continue;
    const keys = Object.keys(rule.when);
    if (keys.length === 1) {
      add(keys[0] as string, rule.when[keys[0] as string] as string | string[]);
      continue;
    }
    for (const key of keys) {
      const othersHold = keys
        .filter((k) => k !== key)
        .every((k) => matchCondition(k, rule.when[k] as string | string[], selection));
      if (othersHold) add(key, rule.when[key] as string | string[]);
    }
  }
  return blocked;
}

/* ------------------------------------------------------------------ *
 * 选择状态：URL 与 localStorage
 * ------------------------------------------------------------------ */

/** 把选择序列化进 URL query，同事之间可以直接发链接对齐技术栈。 */
function selectionFromQuery(query: Record<string, unknown>): Selection {
  const out: Selection = {};
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === 'string' && value) out[key] = value.includes(',') ? value.split(',') : value;
  }
  return out;
}

function queryFromSelection(selection: Selection): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(selection)) {
    const text = Array.isArray(value) ? value.join(',') : String(value);
    if (text) out[key] = text;
  }
  return out;
}

function readStoredSelection(): Selection | null {
  if (!import.meta.client) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Selection) : null;
  } catch {
    return null;
  }
}

function storeSelection(selection: Selection): void {
  if (!import.meta.client) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
  } catch {
    // 隐私模式下写入会抛错。记不住上次选择不影响功能，静默即可。
  }
}

/** 优先级：URL query > localStorage > options.json 的默认值 */
function composeSelection(schema: WizardSchema, query: Selection): Selection {
  const stored = readStoredSelection() ?? {};
  const out: Selection = {};
  for (const group of schema.groups) {
    const fromQuery = query[group.key];
    const fromStore = stored[group.key];
    const fallback = group.default;
    if (fromQuery !== undefined) out[group.key] = fromQuery;
    else if (fromStore !== undefined) out[group.key] = fromStore;
    else out[group.key] = Array.isArray(fallback) ? [...fallback] : fallback;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 组合式入口
 * ------------------------------------------------------------------ */

export function useWizard() {
  const route = useRoute();
  const router = useRouter();

  const blocked = computed(() => blockedMap(state.schema, state.selection));

  const blockConflicts = computed(() => state.conflicts.filter((c) => c.level === 'block'));
  const warnConflicts = computed(() => state.conflicts.filter((c) => c.level === 'warn'));
  const infoConflicts = computed(() => state.conflicts.filter((c) => c.level === 'info'));

  const canStart = computed(() => state.status === 'selecting' || state.status === 'planned');
  const canPreview = computed(() => canStart.value && !state.previewing);

  /** 某个分组里不可选的 value 集合，传给 OptionGroup 置灰卡片。 */
  function blockedFor(key: string): Set<string> {
    return blocked.value.get(key) ?? new Set<string>();
  }

  function recomputeConflicts(): void {
    if (!state.schema) return;
    state.conflicts = conflictsFor(state.schema, state.selection);
  }

  function syncQuery(): void {
    if (!import.meta.client) return;
    const query = queryFromSelection(state.selection);
    const current = JSON.stringify(route.query);
    if (JSON.stringify(query) === current) return;
    void router.replace({ query });
  }

  /** 加载候选清单。骨架态 → selecting 的唯一入口。 */
  async function load(): Promise<void> {
    if (state.schema || state.status === 'loading') return;
    state.status = 'loading';
    state.message = '正在读取候选清单…';
    try {
      const res = await apiFetch('/schema');
      if (!res.ok) throw new Error(await describeFailure(res));
      const schema = (await res.json()) as WizardSchema;
      state.schema = schema;
      state.selection = composeSelection(schema, selectionFromQuery(route.query as Record<string, unknown>));
      recomputeConflicts();
      // 本地存过一次的选择，说明以前来过 —— 直接进 selecting，不再假装是首次访问
      state.status = 'selecting';
      state.message = '';
    } catch (err) {
      state.status = 'failed';
      // 不能清空成 ''：骨架上的文案会回落成「正在读取候选清单…」，
      // 于是一个已经失败、永远不会有结果的页面，看着像还在加载。
      state.message = '候选清单读取失败';
      state.error = (err as Error).message;
    }
  }

  /** 改任一选项：写回状态、重算提示、同步 URL、把过期计划丢掉。 */
  function updateSelection(next: Selection): void {
    state.selection = next;
    if (state.status === 'planned') state.status = 'selecting';
    recomputeConflicts();
    storeSelection(state.selection);
    syncQuery();
  }

  /** 「预览变更」：调服务端算计划。与 init 走同一个函数，所以预览即承诺。 */
  async function preview(): Promise<void> {
    if (!canPreview.value) return;
    state.previewing = true;
    state.error = '';
    try {
      const res = await apiFetch('/plan', {
        method: 'POST',
        body: JSON.stringify({ selection: state.selection }),
      });
      if (!res.ok) throw new Error(await describeFailure(res));
      const payload = (await res.json()) as { plan: InitPlan; conflicts: Conflict[] };
      state.plan = payload.plan;
      // 服务端归一化后的选择才是准的（补了默认值、排了序、去了重）
      state.selection = payload.plan.selection;
      state.conflicts = payload.conflicts;
      state.status = 'planned';
    } catch (err) {
      state.error = (err as Error).message;
      state.status = 'selecting';
    } finally {
      state.previewing = false;
    }
  }

  function pushLog(level: LogLine['level'], line: string): void {
    state.logs.push({ level, line });
    // 日志只用于展示，不参与判断；截断防止一个卡住的安装把内存吃光
    if (state.logs.length > 800) state.logs.splice(0, state.logs.length - 800);
  }

  function installUnloadGuard(): void {
    if (!import.meta.client || unloadHandler) return;
    // 从点下按钮到跑完，中间会删文件并装依赖。此时关掉标签页会留下半成品仓库，
    // 那是最难排查的状态 —— 浏览器原生弹窗拦一下是唯一有效的兜底。
    unloadHandler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', unloadHandler);
  }

  function removeUnloadGuard(): void {
    if (!unloadHandler) return;
    window.removeEventListener('beforeunload', unloadHandler);
    unloadHandler = null;
  }

  function handleEvent(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      pushLog('info', raw);
      return;
    }

    switch (event.type) {
      case 'stage': {
        const index = Number(event.index ?? 0);
        state.stageIndex = index;
        pushLog('info', `[${index + 1}/${event.total ?? STAGES.length}] ${event.name ?? ''}`);
        break;
      }
      case 'log': {
        pushLog(event.level === 'error' ? 'error' : 'info', String(event.line ?? ''));
        break;
      }
      case 'plan': {
        const enginePlan = event.plan as InitPlan;
        state.enginePlan = enginePlan;
        // 预览与执行必须一致。不一致时明确告警而不是静默 —— 那正是本方案最想避免的事。
        const preview = state.plan?.deleteFiles.join('\n');
        const actual = enginePlan?.deleteFiles?.join('\n');
        if (preview && actual && preview !== actual) {
          pushLog('error', '⚠ 引擎算出的删除清单与预览不一致，请把本页日志反馈给模板维护者');
        }
        pushLog('info', `引擎计划：删除 ${enginePlan?.deleteFiles?.length ?? 0} 个文件、安装 ${(enginePlan?.deps?.length ?? 0) + (enginePlan?.devDeps?.length ?? 0)} 个依赖`);
        break;
      }
      case 'error': {
        state.error = String(event.message ?? '未知错误');
        pushLog('error', `${event.stage ?? ''} ${state.error}`.trim());
        break;
      }
      case 'exit': {
        const code = Number(event.code ?? -1);
        state.exitCode = code;
        state.status = code === 0 ? 'done' : 'failed';
        break;
      }
      default:
        pushLog('info', raw);
    }
  }

  /**
   * 读 SSE 流。
   * 事件之间以空行分隔；一次 read() 可能只给半个事件，所以必须自己攒 buffer。
   */
  async function readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let index = buffer.indexOf('\n\n'); index !== -1; index = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of block.split('\n')) {
          if (line.startsWith('data:')) handleEvent(line.slice(5).trim());
        }
      }
    }
    // 收尾：最后一段可能没有以空行结束
    for (const line of buffer.split('\n')) {
      if (line.startsWith('data:')) handleEvent(line.slice(5).trim());
    }
  }

  /** 点「初始化项目」：起 SSE，进入 running。 */
  async function start(): Promise<void> {
    if (!canStart.value) return;
    state.status = 'running';
    state.mode = 'stream';
    state.logs = [];
    state.stageIndex = -1;
    state.exitCode = null;
    state.error = '';
    state.enginePlan = null;
    installUnloadGuard();

    streamController = new AbortController();
    try {
      const res = await apiFetch('/init', {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        body: JSON.stringify({ selection: state.selection }),
        signal: streamController.signal,
      });
      if (!res.ok) throw new Error(await describeFailure(res));
      if (!res.body) throw new Error('响应没有 body，无法读取进度流');

      await readStream(res.body);

      // 流读完了但没收到 exit：连接被中途掐断。
      // 引擎仍在后台跑（这是有意的），所以要引导用户去看锁文件而不是重跑。
      if (state.status === 'running') {
        state.status = 'failed';
        state.error = '进度流意外中断。初始化**可能仍在继续**，请先查看下方状态，不要直接重试。';
        pushLog('error', state.error);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        pushLog('error', '已按用户请求中断进度流。引擎进程可能仍在后台执行。');
        return;
      }
      state.error = (err as Error).message;
      state.status = 'failed';
      pushLog('error', state.error);
    } finally {
      removeUnloadGuard();
      streamController = null;
      state.mode = 'idle';
    }
  }

  /** 主动断开进度流（不杀引擎 —— 删到一半被打断比看不到进度危险得多）。 */
  function detach(): void {
    streamController?.abort();
    streamController = null;
  }

  /** 读一次状态接口。刷新后重进靠它恢复「现在到底在干什么」。 */
  async function refreshStatus(): Promise<void> {
    try {
      const res = await apiFetch('/status');
      if (!res.ok) throw new Error(await describeFailure(res));
      const payload = (await res.json()) as StatusPayload;
      state.remote = payload;

      if (payload.locked) {
        const stage = payload.lock?.stage ?? '';
        const index = STAGES.findIndex((s) => s.key === stage);
        state.stageIndex = index;
        if (payload.processAlive) {
          if (state.mode !== 'stream') state.mode = 'poll';
          state.status = 'running';
        } else {
          state.status = 'failed';
          state.mode = 'idle';
          state.error = payload.lock?.error ?? '上一次初始化没有正常结束（进程已退出但锁未清理）。';
        }
        return;
      }

      if (payload.initialized) {
        state.status = 'done';
        state.mode = 'idle';
      } else if (state.mode !== 'stream' && (state.status === 'running' || state.status === 'failed')) {
        // 「本页没有连着进度流」才允许把 running / failed 打回 selecting。
        //
        // 为什么必须有这个前提：锁文件与 SSE 是两条独立的时序。进度页挂载时会调一次本函数，
        // 而那一刻引擎往往刚被拉起、锁还没写出来 —— 拿这个瞬时结论覆盖流里的状态，
        // 一次正在进行的初始化就会显示成「什么都没在跑」，然后被弹回选择页。
        // 引擎清掉锁的瞬间同理：`exit` 事件才是终局判据，不能由一次轮询抢先下结论。
        state.mode = 'idle';
        state.status = 'selecting';
      }
    } catch (err) {
      state.error = (err as Error).message;
    }
  }

  function startPolling(): void {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      void refreshStatus().then(() => {
        if (!state.remote?.locked) stopPolling();
      });
    }, POLL_INTERVAL_MS);
  }

  function stopPolling(): void {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  /** 进度页的入口：本页有没有在跑的流，决定走 SSE 还是轮询。 */
  async function attach(): Promise<void> {
    if (!state.schema) await load();
    await refreshStatus();
    if (state.status === 'running' && state.mode === 'poll') startPolling();
  }

  /** 从头再来（失败后重试走这里，先清掉本地残留的错误态） */
  function retry(): void {
    stopPolling();
    state.error = '';
    state.exitCode = null;
    state.stageIndex = -1;
    state.status = state.schema ? 'selecting' : 'idle';
    state.mode = 'idle';
  }

  function resetSelection(): void {
    if (!state.schema) return;
    updateSelection(composeSelection(state.schema, {}));
  }

  return {
    // 状态
    state,
    stages: STAGES,
    // 派生
    blockedFor,
    blockConflicts,
    warnConflicts,
    infoConflicts,
    canStart,
    canPreview,
    // 动作
    load,
    attach,
    updateSelection,
    preview,
    start,
    detach,
    refreshStatus,
    retry,
    resetSelection,
  };
}
