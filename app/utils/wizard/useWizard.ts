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
import { assertShape, normalizeSelection } from '#shared/wizard/plan.mjs';
import type {
  Conflict,
  InitPlan,
  OptionGroup,
  Rule,
  Selection,
  TemplateConfig,
  WizardSchema,
} from '~/utils/wizard/option-model';
import { STAGES } from '~/utils/wizard/option-model';

export type WizardStatus = 'idle' | 'loading' | 'selecting' | 'planned' | 'running' | 'done' | 'failed';

/** 进度来源：stream = 本页开着 SSE；poll = 本页是刷新后重进的，靠轮询锁文件；idle = 没在跑 */
export type WizardMode = 'idle' | 'stream' | 'poll';

/**
 * 一条展示日志。id 是单调递增的稳定键：日志是「追加 + 超限从头部裁掉」的列表，
 * 用数组下标当 key 的话，每次裁剪都会让所有行的 key 前移，Vue 要整段重渲；
 * 稳定 id 让裁剪只影响真正新增/移除的那几行。
 */
interface LogLine {
  id: number;
  level: 'info' | 'error';
  line: string;
}

/** 还没分配 id 的一条日志（logForEvent 的返回值，由调用方统一发号）。 */
type LogPayload = Omit<LogLine, 'id'>;

/** 日志 id 的发号器。模块级单例，跨 SSE 流与轮询恢复两条通道连续递增。 */
let logSeq = 0;

interface StatusPayload {
  locked: boolean;
  processAlive: boolean;
  initialized: boolean;
  manager: 'pnpm' | 'npm' | 'unknown';
  lock: { stage?: string; error?: string | null; startedAt?: string; logFile?: string | null; selection?: Record<string, unknown> } | null;
  /** 引擎 --log-file 落盘的事件尾部（一行一条 JSON 事件）。CLI 直跑时为空数组 */
  logLines?: string[];
  templateConfig: TemplateConfig | null;
  wizard: { total: number; present: number; missing: string[] };
  engine: { path: string; present: boolean };
}

const STORAGE_KEY = 'nuxt-shuttle:wizard-selection';
const POLL_INTERVAL_MS = 2000;
/**
 * 一次 /status 查询最多等多久。dev 服务卡住时轮询会每 2 秒再发一个请求，
 * 没有上限的话这些请求会一直挂着、越积越多；超时后由 pollDegraded 自愈。
 * 只给**短只读请求**用，/init 的 SSE 长连接（可能跑 30 分钟）不套这个限制。
 */
const STATUS_TIMEOUT_MS = 10_000;

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
  /** 引擎记录的开始时间（锁里的 startedAt）。用于进度页显示已运行时长。 */
  startedAt: null as string | null,
  logs: [] as LogLine[],
  exitCode: null as number | null,
  error: '',
  remote: null as StatusPayload | null,
  /**
   * 轮询通道的瞬时失败标记。轮询每 2 秒打一次 /status，网络抖动、dev 服务
   * 重启间隙都可能让某一次查询失败 —— 那不该被渲染成「初始化失败」：
   * 下一轮大概率就自愈了。降级期间进度页亮一条 warn 提示，成功后自动消失。
   * 主动查询（挂载、「查看最新状态」按钮）不走这条通道，失败照常上报。
   */
  pollDegraded: false,
});

/**
 * 上一轮 /status 日志尾部的签名（行数 + 最后一行）。日志文件只追加，
 * 签名不变就说明这 2 秒里什么都没发生 —— 此时跳过整段替换，省掉一次
 * 最多 800 行的全量重渲（轮询是常态路径，绝大多数轮次都在这个快路径上）。
 */
let lastRemoteLogSig = '';

/**
 * /status 展示字段的签名。一次轮询拿到「内容完全没变」的新对象时，直接赋给
 * state.remote 也会让进度面板（步骤条、选择快照、执行摘要、日志区）整块重渲，
 * 而初始化动辄十几分钟、绝大多数轮次什么都没变。签名相同就留着旧对象。
 * logLines 单独由 lastRemoteLogSig 判增量，所以这里只比较它的长度与最后一行。
 */
let lastRemoteSig = '';

/** 在途的 /status 查询数。轮询用它做「单飞」，见 refreshStatus。 */
let statusInFlight = 0;

let streamController: AbortController | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
/**
 * 轮询的「意愿」标记：pollTimer 只表示「现在有没有定时器在跑」，
 * 而 pollWanted 表示「这条通道是否还应该轮询」。标签页隐藏时我们主动停掉
 * 定时器（见 onVisibilityChange），但意愿还在 —— 回到前台要靠它恢复，
 * 不能把「后台暂停」误当成「轮询已结束」。
 */
let pollWanted = false;
let visibilityHandler: (() => void) | null = null;
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

/**
 * URL query 与 localStorage 都是**不可信输入**：手改过的链接、上一个模板版本
 * 存下的选择、被别的脚本写脏的值，都可能落进来。此前它们被原样塞进 selection，
 * 页面照常渲染，直到点「预览变更」才被服务端 400 打回来，而且看不出是哪一项坏的。
 * 现在先按当前 schema 的候选集过一遍：非法就当没这一项，回落到默认值。
 *
 * 多选组也接受单个字符串（URL 里 `?features=a` 不带逗号时就是这种形态），
 * 保持既有行为不变；单选组收到数组则判非法。
 */
function acceptableValue(group: OptionGroup, value: unknown): boolean {
  if (!group.multiple && Array.isArray(value)) return false;
  const allowed = new Set(group.options.map((option) => option.value));
  const values = Array.isArray(value) ? value : [value];
  return values.every((item) => typeof item === 'string' && allowed.has(item));
}

/** 优先级：URL query > localStorage > options.json 的默认值（每一级都要合法） */
function composeSelection(schema: WizardSchema, query: Selection): Selection {
  const stored = readStoredSelection() ?? {};
  const out: Selection = {};
  for (const group of schema.groups) {
    const fromQuery = query[group.key];
    const fromStore = stored[group.key];
    const fallback = group.default;
    if (acceptableValue(group, fromQuery)) out[group.key] = fromQuery as Selection[string];
    else if (acceptableValue(group, fromStore)) out[group.key] = fromStore as Selection[string];
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

  /**
   * 完整分享链接：与 syncQuery 用同一份序列化，直接从当前选择生成 ——
   * 不读地址栏，因为路由 replace 是异步的，「改完立刻点复制」可能拿上一帧的 URL。
   * 同事打开这个链接，会得到与现在完全相同的选择。
   */
  const shareUrl = computed(() => {
    if (!import.meta.client) return '';
    const params = new URLSearchParams(queryFromSelection(state.selection));
    return `${window.location.origin}/setup${params.toString() ? `?${params}` : ''}`;
  });

  /** 某个分组里不可选的 value 集合，传给 OptionGroup 置灰卡片。 */
  // 空集是绝大多数调用的结果：共用一个冻结的实例，省掉每次渲染每组一个新 Set。
  const EMPTY_BLOCKED: ReadonlySet<string> = new Set<string>();
  function blockedFor(key: string): ReadonlySet<string> {
    return blocked.value.get(key) ?? EMPTY_BLOCKED;
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
    // 重新加载要把上一轮的失败原因清掉：成功路径原本从来不清 state.error，
    // 于是「清单读取失败 → 点重试 → 成功」之后那条红色横幅会永远留在页面上。
    state.error = '';
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

  /**
   * 导入此前导出的 selection.json —— 与选择页的「导出选择文件」形成闭环。
   *
   * 校验与归一化都用 shared 层的同一对函数（服务端 /plan、引擎 CLI 也用它们）：
   * 未知分组、非法值、形状不对一律拒绝，绝不把文件里的任意字段写进状态。
   * 因此不需要新接口、不改引擎输入格式，也不碰五道闸中的任何一条。
   * 导入后丢掉旧计划并退回 selecting —— 那份计划对应的是**导入前**的选择，
   * 留着它等于让「预览即承诺」说谎。
   */
  function importSelection(raw: unknown): { ok: boolean; message: string } {
    if (!state.schema) return { ok: false, message: '候选清单尚未加载，请稍后重试' };
    if (!canStart.value) return { ok: false, message: '当前状态下不能修改选择' };
    try {
      assertShape(state.schema, raw);
    } catch (err) {
      return { ok: false, message: `选择文件不合法：${(err as Error).message}` };
    }
    const normalized = normalizeSelection(state.schema, raw) as Selection;
    state.plan = null;
    state.error = '';
    updateSelection(normalized);
    return { ok: true, message: `已导入 ${Object.keys(normalized).length} 项选择，请点「预览变更」核对计划` };
  }

  function pushLog(level: LogLine['level'], line: string): void {
    state.logs.push({ id: ++logSeq, level, line });
    // 日志只用于展示，不参与判断；截断防止一个卡住的安装把内存吃光
    if (state.logs.length > 800) state.logs.splice(0, state.logs.length - 800);
  }

  /**
   * 离开页面的兜底提醒。装守卫的时机是「引擎还活着」：
   * start() 起流时装一份；SSE 中断降级成轮询、或刷新重进进入轮询时，
   * 由 refreshStatus 的 running 分支补装 —— 引擎不因页面关闭而停止，
   * 这份提醒就必须跟到引擎收场为止（终态分支与 retry 负责拆）。
   */
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

  /**
   * 一条引擎事件对应的展示日志。exit 不产生日志行，返回 null。
   *
   * 为什么抽成纯函数：实时流（SSE）与刷新后的恢复（/status 返回的事件尾部）
   * 吃的是**同一种事件**。两边各写一套格式化，迟早出现「实时看是一条样、
   * 刷新后变了个样」—— 那会被当成新问题来排查。
   * 返回值不带 id：由 pushLog / logsFromRemote 各自的发号器补上。
   */
  function logForEvent(event: Record<string, unknown>, raw: string): LogPayload | null {
    switch (event.type) {
      case 'stage':
        return {
          level: 'info',
          line: `[${Number(event.index ?? 0) + 1}/${event.total ?? STAGES.length}] ${event.name ?? ''}`,
        };
      case 'log':
        return { level: event.level === 'error' ? 'error' : 'info', line: String(event.line ?? '') };
      case 'plan': {
        const enginePlan = event.plan as InitPlan;
        return {
          level: 'info',
          line: `引擎计划：删除 ${enginePlan?.deleteFiles?.length ?? 0} 个文件、安装 ${(enginePlan?.deps?.length ?? 0) + (enginePlan?.devDeps?.length ?? 0)} 个依赖`,
        };
      }
      case 'error':
        return { level: 'error', line: `${event.stage ?? ''} ${String(event.message ?? '未知错误')}`.trim() };
      case 'exit':
        return null;
      default:
        return { level: 'info', line: raw };
    }
  }

  /** /status 返回的事件尾部 → 展示日志。解析失败的单行原样展示，不让一行坏数据炸掉整段。 */
  function logsFromRemote(rawLines: string[]): LogLine[] {
    const out: LogLine[] = [];
    for (const raw of rawLines) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        out.push({ level: 'info', line: raw });
        continue;
      }
      const line = logForEvent(event, raw);
      if (line) out.push({ id: ++logSeq, ...line });
    }
    return out;
  }

  function handleEvent(raw: string): void {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      pushLog('info', raw);
      return;
    }

    if (event.type === 'stage') {
      state.stageIndex = Number(event.index ?? 0);
    } else if (event.type === 'plan') {
      state.enginePlan = event.plan as InitPlan;
      // 预览与执行必须一致。不一致时明确告警而不是静默 —— 那正是本方案最想避免的事。
      const preview = state.plan?.deleteFiles.join('\n');
      const actual = state.enginePlan?.deleteFiles?.join('\n');
      if (preview && actual && preview !== actual) {
        pushLog('error', '⚠ 引擎算出的删除清单与预览不一致，请把本页日志反馈给模板维护者');
      }
    } else if (event.type === 'error') {
      state.error = String(event.message ?? '未知错误');
    } else if (event.type === 'exit') {
      const code = Number(event.code ?? -1);
      state.exitCode = code;
      state.status = code === 0 ? 'done' : 'failed';
      return;
    }

    const line = logForEvent(event, raw);
    if (line) pushLog(line.level, line.line);
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

  /**
   * 断流后的兜底：查一次锁文件，引擎还活着就降级成轮询，进度继续可见。
   *
   * 进度流可能被反向代理掐断、被电脑休眠打断、也可能被用户主动中断 ——
   * 三者的共同点是「引擎多半还在跑」（客户端断开不杀引擎是刻意的）。
   * 原先这里直接判 failed，把「看不到进度」当成「初始化失败」，用户最自然的
   * 反应就是重试，而那正是残锁在场时最不该做的事。降级成已有的轮询通道，
   * 页面表现与「刷新后重进」完全一致。
   */
  async function fallbackToPoll(reason: string): Promise<void> {
    await refreshStatus();
    if (state.remote?.locked && state.remote?.processAlive) {
      state.status = 'running';
      state.mode = 'poll';
      startPolling();
      pushLog('info', `${reason}，已自动切换为每 2 秒查询一次锁文件；引擎仍在后台执行，关闭页面也不会中断它。`);
      return;
    }
    pushLog('info', `${reason}，且未检测到正在执行的初始化。`);
  }

  /** 点「初始化项目」：起 SSE，进入 running。 */
  async function start(): Promise<void> {
    if (!canStart.value) return;
    state.status = 'running';
    state.mode = 'stream';
    state.logs = [];
    state.stageIndex = -1;
    state.startedAt = new Date().toISOString();
    state.exitCode = null;
    state.error = '';
    state.enginePlan = null;
    state.pollDegraded = false;
    lastRemoteLogSig = '';
    lastRemoteSig = '';
    installUnloadGuard();

    streamController = new AbortController();
    let connected = false;
    try {
      const res = await apiFetch('/init', {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        body: JSON.stringify({ selection: state.selection }),
        signal: streamController.signal,
      });
      if (!res.ok) throw new Error(await describeFailure(res));
      if (!res.body) throw new Error('响应没有 body，无法读取进度流');
      connected = true;

      await readStream(res.body);

      // 流读完了但没收到 exit：连接被中途掐断。先试降级成轮询，
      // 只有连「正在执行的初始化」都查不到时才按失败处理。
      if (state.status === 'running') {
        await fallbackToPoll('进度流意外中断');
        if (state.status === 'running') {
          state.status = 'failed';
          state.error = '进度流意外中断，且未检测到正在执行的初始化。请用下方按钮查看最新状态。';
          pushLog('error', state.error);
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        // 「中断进度流」也降级成轮询：用户要的是不再占着连接，不是从此看不到进度。
        // 没查到在跑的初始化时保持 running（与旧版一致）—— 用户主动断开，
        // 不该把「我看不到」渲染成「初始化失败了」。
        await fallbackToPoll('已按用户请求中断进度流');
      } else if (connected) {
        // 流读到一半网络异常：引擎大概率还在跑，降级成轮询；
        // 确认没在跑了才按失败处理。
        await fallbackToPoll('与初始化接口的连接中断');
        if (state.status === 'running') {
          state.status = 'failed';
          state.error = (err as Error).message;
          pushLog('error', state.error);
        }
      } else {
        // 请求本身没建立（403 / 409 / 422…）：失败信息已由 describeFailure 给出，
        // 不做降级 —— 那会用一份「其实没在跑的初始化」盖掉真正的拒绝原因。
        state.error = (err as Error).message;
        state.status = 'failed';
        pushLog('error', state.error);
      }
    } finally {
      streamController = null;
      // 降级成轮询时把 mode 留给轮询通道，只有真正收场时才回 idle。
      // 离开守卫同理：mode 是 poll 意味着引擎多半还在后台跑（fallbackToPoll 已确认过），
      // 此时关标签页依然危险 —— 守卫留到引擎真正收场（refreshStatus 的各终态分支拆它）。
      if (state.mode === 'poll') {
        // 引擎仍在后台执行：什么都不拆
      } else {
        state.mode = 'idle';
        removeUnloadGuard();
      }
    }
  }

  /** 主动断开进度流（不杀引擎 —— 删到一半被打断比看不到进度危险得多）。 */
  function detach(): void {
    streamController?.abort();
    streamController = null;
  }

  /**
   * 读一次状态接口。刷新后重进靠它恢复「现在到底在干什么」。
   *
   * fromPoll 为 true 表示这次调用由轮询定时器发起 —— 它的失败处理走单独一条路：
   * 瞬时失败（网络抖动、服务重启间隙）只亮 pollDegraded 提示，下一轮自动重试，
   * **不**覆盖 state.error。原因：state.error 是失败横幅，写进去之后没有任何
   * 成功路径会清掉它 —— 一次 2 秒一次的偶发失败就能把横幅钉死在页面上，
   * 而用户看到的「初始化失败」与引擎实际状态毫无关系。
   */
  async function refreshStatus(fromPoll = false): Promise<void> {
    // 单飞：上一轮还没回来就跳过这一轮轮询。dev 服务卡住时 2 秒一个请求会无限堆积，
    // 多个响应乱序回来还会互相覆盖状态。手动查询（挂载、按钮）不受这条限制 ——
    // 用户点了就该真的查一次；它们只是共享同一个在途计数。
    if (fromPoll && statusInFlight > 0) return;
    statusInFlight += 1;
    try {
      await queryStatus(fromPoll);
    } finally {
      statusInFlight -= 1;
    }
  }

  /** 真正的一次查询。只由 refreshStatus 调用，别绕开它的在途计数。 */
  async function queryStatus(fromPoll: boolean): Promise<void> {
    try {
      const res = await apiFetch('/status', {
        // 只给这次短查询设上限；/init 的 SSE 长连接自带 signal，不走这里。
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(STATUS_TIMEOUT_MS)
          : undefined,
      });
      if (!res.ok) throw new Error(await describeFailure(res));
      const payload = (await res.json()) as StatusPayload;

      // 展示字段没变就别换 state.remote：赋一个新对象会让整个进度面板重渲，
      // 而初始化动辄十几分钟、绝大多数轮询什么都没变。日志通道另用自己的签名
      // （见 lastRemoteLogSig），所以这里只把日志的行数与最后一行算进比较。
      const { logLines, ...snapshot } = payload;
      const signature = JSON.stringify([
        snapshot,
        logLines?.length ?? 0,
        logLines?.[logLines.length - 1] ?? '',
      ]);
      if (signature !== lastRemoteSig) {
        lastRemoteSig = signature;
        state.remote = payload;
      }
      if (state.pollDegraded) state.pollDegraded = false;

      // 轮询通道的日志：整段替换而不是增量合并 —— 日志文件只追加，
      // 尾部天然覆盖上一轮读到的内容；实时流在场时不动它（两条时序独立，别互相踩）。
      // 签名（行数 + 最后一行）没变就整段跳过：轮询大多数轮次日志都不会变。
      if (state.mode !== 'stream' && logLines?.length) {
        const sig = `${logLines.length}:${logLines[logLines.length - 1] ?? ''}`;
        if (sig !== lastRemoteLogSig) {
          lastRemoteLogSig = sig;
          state.logs = logsFromRemote(logLines);
        }
      }

      if (payload.locked) {
        const stage = payload.lock?.stage ?? '';
        const index = STAGES.findIndex((s) => s.key === stage);
        state.stageIndex = index;
        state.startedAt = payload.lock?.startedAt ?? state.startedAt;
        if (payload.processAlive) {
          // 轮询的开关随状态查询本身走：谁发现「引擎活着而本页没有实时流」，
          // 谁就接管轮询 —— 断流降级、刷新重进、「查看最新状态」按钮共用这一条路。
          if (state.mode !== 'stream') {
            state.mode = 'poll';
            state.status = 'running';
            // 引擎还在跑，关标签页的兜底提醒就要在场：刷新重进走的是这里，
            // start() 里装的那份守卫在「刷新」这件事上帮不上忙。
            installUnloadGuard();
            startPolling();
          }
        } else {
          state.status = 'failed';
          state.mode = 'idle';
          stopPolling();
          // 进程已退出 = 无论结果是成是败，关闭页面都不再有风险
          removeUnloadGuard();
          state.error = payload.lock?.error ?? '上一次初始化没有正常结束（进程已退出但锁未清理）。';
        }
        return;
      }

      if (payload.initialized) {
        state.status = 'done';
        state.mode = 'idle';
        stopPolling();
        removeUnloadGuard();
      } else if (state.mode !== 'stream' && (state.status === 'running' || state.status === 'failed')) {
        // 「本页没有连着进度流」才允许把 running / failed 打回 selecting。
        //
        // 为什么必须有这个前提：锁文件与 SSE 是两条独立的时序。进度页挂载时会调一次本函数，
        // 而那一刻引擎往往刚被拉起、锁还没写出来 —— 拿这个瞬时结论覆盖流里的状态，
        // 一次正在进行的初始化就会显示成「什么都没在跑」，然后被弹回选择页。
        // 引擎清掉锁的瞬间同理：`exit` 事件才是终局判据，不能由一次轮询抢先下结论。
        state.mode = 'idle';
        state.status = 'selecting';
        stopPolling();
        removeUnloadGuard();
      }
    } catch (err) {
      if (fromPoll && state.mode === 'poll' && state.status === 'running') {
        // 轮询中的瞬时失败：标记降级、不写 error 横幅，等下一轮自愈。
        state.pollDegraded = true;
        return;
      }
      state.error = (err as Error).name === 'TimeoutError'
        ? `状态查询超时（${STATUS_TIMEOUT_MS / 1000} 秒无响应）：请确认 pnpm dev 仍在运行，再点「查看最新状态」`
        : (err as Error).message;
    }
  }

  /**
   * 标签页可见性变化：隐藏时暂停轮询，回到前台立即补查一次并恢复。
   *
   * 为什么值得做：后台标签页的定时器照常触发，而每一轮 /status 都要让服务端
   * 读锁文件 + 截 400 行日志 —— 初始化动辄十几分钟，挂后台的那几个小时里
   * 绝大多数查询都注定被用户无视。初始化的推进由引擎进程承载，不依赖页面，
   * 暂停查询没有任何副作用；唯一要做对的是「回前台立刻补一次」，
   * 否则用户切回来要干等最多 2 秒才能看到最新状态。
   */
  function onVisibilityChange(): void {
    if (!pollWanted) return;
    if (document.visibilityState === 'visible') {
      resumePolling();
      void refreshStatus(true);
    } else {
      pausePolling();
    }
  }

  function startPolling(): void {
    pollWanted = true;
    if (!visibilityHandler && import.meta.client) {
      visibilityHandler = onVisibilityChange;
      document.addEventListener('visibilitychange', visibilityHandler);
    }
    resumePolling();
  }

  function resumePolling(): void {
    if (!pollWanted || pollTimer) return;
    pollTimer = setInterval(() => {
      void refreshStatus(true);
    }, POLL_INTERVAL_MS);
  }

  function pausePolling(): void {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  }

  function stopPolling(): void {
    pollWanted = false;
    pausePolling();
    if (visibilityHandler) {
      document.removeEventListener('visibilitychange', visibilityHandler);
      visibilityHandler = null;
    }
  }

  /** 进度页的入口：本页有没有在跑的流，决定走 SSE 还是轮询。 */
  async function attach(): Promise<void> {
    if (!state.schema) await load();
    await refreshStatus();
  }

  /** 从头再来（失败后重试走这里，先清掉本地残留的错误态） */
  function retry(): void {
    stopPolling();
    removeUnloadGuard();
    state.error = '';
    state.exitCode = null;
    state.stageIndex = -1;
    state.startedAt = null;
    state.pollDegraded = false;
    // 新一轮初始化不该沿用上一轮的状态/日志签名，否则首轮查询会被误判成「没变化」。
    lastRemoteLogSig = '';
    lastRemoteSig = '';
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
    shareUrl,
    // 动作
    load,
    attach,
    updateSelection,
    preview,
    importSelection,
    start,
    detach,
    refreshStatus,
    retry,
    resetSelection,
  };
}
