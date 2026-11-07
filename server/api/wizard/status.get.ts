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
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
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

/**
 * 单次从文件尾部读多少字节。400 行事件通常远小于这个值；不够时按 2 倍回退扩大。
 * 上限 8 MiB：万一一行日志就有几 MB，也不为了凑满 400 行把整个文件读进内存。
 */
const TAIL_CHUNK_BYTES = 64 * 1024;
const TAIL_MAX_BYTES = 8 * 1024 * 1024;

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
 *
 * 只从**尾部**有界读取，而不是 readFileSync 整个文件：这个接口每 2 秒被轮询一次，
 * 而安装阶段的日志可以长到几 MB。逐轮全量读是 O(文件大小) 的磁盘 I/O 与字符串分配，
 * 与「只看最后 400 行」的语义完全不成比例。做法是从末尾读一段，若不足 400 行
 * 就把窗口翻倍重读（有上限）；从中间截断时第一行可能是半行 JSON / 半个 UTF-8 字符，
 * 丢掉它即可。语义与原先的「全量读 → 过滤空行 → slice(-400)」保持一致，
 * 自测 A18 用多组样本逐一比对两种实现的结果。
 *
 * 函数体刻意保持为无类型标注的纯 JS：自测会把这段源码接上真实 fs 依赖直接执行，
 * 这样优化的正确性有动态验证，又不必为了可测性往产物里多留一个文件。
 */
function readLogTail(lock: WizardLock | null): string[] {
  if (!lock?.logFile) return [];
  let fd;
  try {
    const file = resolve(lock.logFile);
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    if (size === 0) return [];

    let length = Math.min(size, TAIL_CHUNK_BYTES);
    let lines = [];
    for (;;) {
      const buffer = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const n = readSync(fd, buffer, read, length - read, size - length + read);
        if (n <= 0) break;
        read += n;
      }
      lines = buffer.subarray(0, read).toString('utf8').split('\n').filter((line) => line.trim());
      // 不是从头读的：第一行大概率被截断（半行 JSON，甚至半个多字节字符），丢掉。
      if (length < size && lines.length) lines.shift();
      // 尾部已经凑够 400 行（或已读到文件头 / 到上限），最后 400 行必然完整落在窗口里。
      if (lines.length >= LOG_TAIL_LINES || length >= size || length >= TAIL_MAX_BYTES) break;
      length = Math.min(size, Math.min(length * 2, TAIL_MAX_BYTES));
    }
    return lines.slice(-LOG_TAIL_LINES);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* 已关闭就没什么要做的了 */ }
    }
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
