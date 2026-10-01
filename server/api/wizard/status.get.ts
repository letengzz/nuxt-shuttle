/**
 * GET /api/wizard/status —— 锁状态与上一次执行的结果。
 *
 * 为什么需要它：初始化可能在删到一半时失败（引擎会**保留**锁并写入 error），
 * 此时用户重开页面如果只看到一个「什么都没发生」的界面，就会再点一次 ——
 * 而仓库正处于最不该被再点一次的状态。
 *
 * 它同时回答三个问题：
 *   ① 现在有锁吗？是有人在跑，还是进程已死留下的残锁？
 *   ② 上一次成功了吗？（template.config.json 是否存在）
 *   ③ 引导器还在吗？（引导文件是否已被清空 —— 用于判断该走「初始化」还是「已完成」）
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { WIZARD_FILES } from '#shared/wizard/whitelist.mjs';
import type { TemplateConfig } from '#shared/wizard/types';
import { assertWizardReadable, isLockProcessAlive, readLock } from '../../utils/wizard/guard';

/** 初始化成功后由引擎写下的「小票」，永久保留。 */
const CONFIG_FILE = 'template.config.json';

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

export default defineEventHandler((event) => {
  assertWizardReadable(event);

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
    engine: { path: 'scripts/init.mjs', present: existsSync(resolve(root, 'scripts', 'init.mjs')) },
    wizard: wizardPresence(root),
  };
});
