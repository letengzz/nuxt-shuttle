/**
 * GET /api/wizard/status —— 锁状态、上一次执行的结果，以及事件日志的尾部。
 *
 * 为什么需要它：初始化可能在删到一半时失败（引擎会**保留**锁并写入 error），
 * 此时用户重开页面如果只看到一个「什么都没发生」的界面，就会再点一次 ——
 * 而仓库正处于最不该被再点一次的状态。
 *
 * 它同时回答四个问题：
 *   ① 现在有锁吗？是有人在跑，还是进程已死留下的残锁？
 *   ② 上一次成功了吗？（template.config.json 是否存在）
 *   ③ 引导器还在吗？（引导文件是否已被清空 —— 用于判断该走「初始化」还是「已完成」）
 *   ④ 日志尾部：刷新后的进度页没有实时流，只能靠这里拿日志（事件原文，一行一条）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WIZARD_FILES } from '#shared/wizard/whitelist.mjs';
import type { TemplateConfig } from '#shared/wizard/types';
import {
  assertWizardReadable,
  isLockProcessAlive,
  readLock,
  type WizardLock,
} from '../../utils/wizard/guard';

/** 初始化成功后由引擎写下的「小票」，永久保留。 */
const CONFIG_FILE = 'template.config.json';

/** 返回给前端的日志行数上限。展示用，只保留尾部 —— 失败的原因总在最后几行。 */
const LOG_TAIL_LINES = 400;

/** 从 lockfile 反推当前用的是哪个包管理器。两者都在说明仓库被改过两套。 */
function detectManager(root: string): 'pnpm' | 'npm' | 'unknown' {
  const hasPnpm = existsSync(resolve(root, 'pnpm-lock.yaml'));
  const hasNpm = existsSync(resolve(root, 'package-lock.json'));
  if (hasPnpm && !hasNpm) return 'pnpm';
  if (hasNpm && !hasPnpm) return 'npm';
  return 'unknown';
}

function readTemplateConfig(root: string): TemplateConfig | null {
  const file = resolve(root, CONFIG_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as TemplateConfig;
  } catch (err) {
    // 解析不了就如实回报，不假装「没初始化过」—— 那会让用户以为可以重跑
    return {
      schemaVersion: 'unreadable',
      templateVersion: 'unknown',
      initializedAt: '',
      selection: {},
      plan: { lockfile: 'pnpm', deps: [], devDeps: [], modules: [], cssEntries: [], allowBuilds: [] },
      removed: [],
      kept: [`无法解析 ${CONFIG_FILE}：${(err as Error).message}`],
    };
  }
}

function wizardPresence(root: string) {
  const missing = WIZARD_FILES.filter((rel) => !existsSync(resolve(root, rel)));
  return {
    total: WIZARD_FILES.length,
    present: WIZARD_FILES.length - missing.length,
    missing,
  };
}

/**
 * 事件日志的尾部（原始 JSON 事件行，一行一条）。
 *
 * 路径来自锁文件、由引擎写入，前端用与 SSE 完全相同的解析器处理它 ——
 * 所以这里**不做任何格式化**，读了什么就原样给什么。读取失败只影响日志展示，
 * 不能因此把整个状态接口打红：进度页先要知道「卡在哪一步」，再谈日志。
 */
function readLogTail(lock: WizardLock | null): string[] {
  if (!lock?.logFile) return [];
  try {
    const file = resolve(lock.logFile);
    if (!existsSync(file)) return [];
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line.trim());
    return lines.slice(-LOG_TAIL_LINES);
  } catch {
    return [];
  }
}

export default defineEventHandler((event) => {
  assertWizardReadable(event);

  // 轮询接口的响应绝不能被缓存：状态每 2 秒查一次，任何一层缓存（浏览器、
  // 代理、dev 服务自身的启发式缓存）都会把「实时进度」变成「迟到的进度」，
  // 而且锁消失后缓存里的旧状态还会让页面误判。
  setResponseHeader(event, 'cache-control', 'no-store');

  const root = process.cwd();
  const lock = readLock();

  return {
    dev: Boolean(import.meta.dev),
    lock,
    locked: lock !== null,
    /** 锁里的 pid 还活着 = 真的在跑；false 说明是上一次失败留下的残锁 */
    processAlive: isLockProcessAlive(lock),
    initialized: existsSync(resolve(root, CONFIG_FILE)),
    templateConfig: readTemplateConfig(root),
    manager: detectManager(root),
    /** 引擎 --log-file 落盘的事件尾部：刷新后重进的进度页靠它恢复日志 */
    logLines: readLogTail(lock),
    engine: { path: 'scripts/init.mjs', present: existsSync(resolve(root, 'scripts', 'init.mjs')) },
    wizard: wizardPresence(root),
  };
});
