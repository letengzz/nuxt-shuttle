/**
 * 五道安全闸与锁文件读写。
 *
 * 这里是引导器**唯一**被允许「判断能不能动手」的地方。四个接口的准入门槛不同
 * （读接口不需要查锁），但「怎么判断」必须共用 —— 分散写会让某个接口在日后改动时
 * 悄悄放宽，而这类漏洞不会报错、不会让测试变红，只会静默存在。
 *
 * 闸的顺序不能调换：dev → 本机 → 令牌 → 锁。
 * 令牌排在锁前面，是为了让两种拒绝返回可区分的状态码：
 * 403 是「你没资格」，409 是「你确实在重复执行」—— 排查时这两者的处置完全不同。
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { H3Event } from 'h3';
import type { Selection } from '#shared/wizard/types';

/** 锁文件名。引擎与服务端都从这一份常量取值，不做第二次拼写。 */
export const LOCK_FILENAME = 'template.init.lock';

/** 允许触发初始化的来源地址：IPv4 回环、IPv6 回环、双栈下的 IPv4 映射形式。 */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * 进程级令牌。
 *
 * 为什么是「进程级」而不是「每次页面渲染换一个新值」：
 * 换新值会让多标签页、以及「失败后原地重试」当场失效（旧页面拿着上一轮的令牌，一路 403），
 * 而本模板的失败路径恰恰要求用户能原地重试。真正的「一次性」约束由闸 4 的锁承担，
 * 令牌负责的是另一件事：**跨站页面读不到它**（CSRF 场景下攻击者的 JS 拿不到我们的响应体）。
 */
let token: string | null = null;

/** 由 dev-only 的 Nitro 插件在服务启动时调用，生成并记住本次进程的令牌。 */
export function issueWizardToken(): string {
  if (!token) token = randomUUID().replaceAll('-', '');
  return token;
}

export function getWizardToken(): string | null {
  return token;
}

/**
 * 常数时间比较。
 * 令牌是 32 位十六进制，逐字符 `===` 会在第一个不同字符处提前返回 ——
 * 单机场景下这个侧信道没什么用，但把比较写成常数时间没有代价，就不留这个尾巴。
 */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 锁文件的内容：引擎在执行的每个阶段更新它，所以 `status` 接口能报出「卡在哪一步」。 */
export interface WizardLock {
  pid?: number;
  startedAt?: string;
  /** 当前阶段名，与引擎的五阶段同名：plan / snapshot / apply / install / verify */
  stage?: string;
  /** 开始时的选择快照，`--rollback` 靠它恢复 */
  selection?: Selection;
  /** 失败原因原文。成功时不存在此字段 */
  error?: string | null;
}

export function lockFilePath(): string {
  return resolve(process.cwd(), LOCK_FILENAME);
}

export function readLock(): WizardLock | null {
  const file = lockFilePath();
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8').trim();
    return raw ? (JSON.parse(raw) as WizardLock) : {};
  } catch (err) {
    // 损坏的锁文件绝不能当成「没有锁」—— 那会让第二次初始化跑在最糟的起点上。
    return { stage: 'unknown', error: `锁文件无法解析：${(err as Error).message}` };
  }
}

/** 锁里的 pid 是否还活着。用信号 0 探测，不发送任何真实信号。 */
export function isLockProcessAlive(lock: WizardLock | null): boolean {
  if (!lock?.pid) return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 闸 1：仅开发模式。
 * 生产构建里 Nitro 会把 `import.meta.dev` 静态替换成 `false`，
 * 于是整个分支变成死代码被压缩掉，对外表现就是这四个接口不存在（404）。
 */
export function assertDevOnly(): void {
  if (!import.meta.dev) {
    throw createError({ statusCode: 404, statusMessage: 'Not Found' });
  }
}

/** 闸 2：仅本机访问。局域网内其他机器即使猜到令牌也无法触发。 */
export function assertLoopback(event: H3Event): void {
  // xForwardedFor 必须显式关掉：打开它等于允许客户端自称来自 127.0.0.1
  const remote = getRequestIP(event, { xForwardedFor: false });
  if (remote && !LOOPBACK.has(remote)) {
    throw createError({
      statusCode: 403,
      // statusMessage 保持简短：h3 未来会默认对它做清洗，长文案应该放在 message 里
      statusMessage: 'Forbidden',
      message: `初始化只能在运行开发服务的本机执行（来源 ${remote}）`,
      data: { remote },
    });
  }
}

/** 闸 3：令牌。令牌只出现在 /setup 的渲染结果里，跨站脚本读不到响应体。 */
export function assertWizardToken(event: H3Event): void {
  const expected = getWizardToken();
  const actual = getHeader(event, 'x-wizard-token');
  if (!expected || !actual || !safeEqual(actual, expected)) {
    throw createError({
      statusCode: 403,
      statusMessage: 'Forbidden',
      message: '令牌校验失败，请刷新页面后重试',
    });
  }
}

/**
 * 闸 4：单次初始化锁。
 * 区分「有进程在跑」与「进程已死但锁没清」——两者的处置方式相反，
 * 前者只能等，后者该看 status 决定重试还是回滚。
 */
export function assertNoLock(): void {
  if (!existsSync(lockFilePath())) return;
  const lock = readLock();
  const alive = isLockProcessAlive(lock);
  throw createError({
    statusCode: 409,
    statusMessage: 'Conflict',
    message: alive
      ? '检测到正在执行的初始化（template.init.lock），请等待它结束'
      : '检测到未清理的初始化锁（template.init.lock），请先查看 /api/wizard/status 的结果，再决定重试还是回滚',
    data: { lock, processAlive: alive },
  });
}

/**
 * 只读接口的门槛：dev + 本机 + 令牌。
 * 刻意**不含**锁 —— schema / plan / status 在初始化进行中依然要能访问，
 * 否则进度页自己都读不到状态。
 */
export function assertWizardReadable(event: H3Event): void {
  assertDevOnly();
  assertLoopback(event);
  assertWizardToken(event);
}

/** 会动手的接口的门槛：只读门槛 + 单次锁。目前只有 /api/wizard/init 用得上。 */
export function assertWizardAllowed(event: H3Event): void {
  assertWizardReadable(event);
  assertNoLock();
}
