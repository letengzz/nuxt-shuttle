#!/usr/bin/env node
/**
 * 产物校验 —— 12 项断言，对应文档 `InitEngine` 第 7 节。
 *
 * 为什么要有这个文件，而不是让引擎「跑完就算成功」：
 * 五阶段里前四阶段每一步都可能**静默半成品** —— 删了 30 个文件里 29 个、
 * marker 区间内容没写进去、装的依赖没落盘。这类问题不会让任何命令报错，
 * 只会让用户在一周后写出一个「首页是重定向到 /setup、而 /setup 已经没了」的站。
 * 所以初始化之后必须有一段独立的、只读的复核：它不信任前四阶段的日志，
 * 只信磁盘上现在是什么。
 *
 * 三条纪律：
 *   ① **独立证据优先**：能用磁盘/快照/node_modules 判的，就不去读 `template.config.json`
 *      自述的结论 —— 自述与被验对象出自同一段代码，那是自证。
 *   ② **一项一条，互不短路**：某一项失败不影响后面的项跑完。用户要的是一次看到全部问题，
 *      而不是修一个跑一次。
 *   ③ **跳过要显式**：`--fast`、`--skip-install` 造成的跳过会被单独计数并打印，
 *      绝不用「通过」掩盖「没验」。
 *
 * CLI：
 *   node scripts/verify.mjs            完整 12 项
 *   node scripts/verify.mjs --fast     跳过第 12 项（类型检查，最慢的一项）
 *   node scripts/verify.mjs --json-lines  每行一条 JSON 事件
 *
 * 退出码：0 = 没有失败项（跳过不算失败）；1 = 至少一项失败；2 = 参数错误
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASELINE_TARGETS } from '../shared/wizard/baseline.mjs';
import { buildPlanFromPicked, installCommands } from '../shared/wizard/plan.mjs';
import {
  FILE_SECTION_KEYS,
  MARKER_FILES,
  blankSections,
  countMarker,
  markerBegin,
  markerEnd,
  readSection,
} from '../shared/wizard/sections.mjs';
import { KEEP_FILES, WIZARD_FILES } from '../shared/wizard/whitelist.mjs';
import { runCommand } from './lib/proc.mjs';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const CONFIG_FILE = 'template.config.json';
const LOCK_FILE = 'template.init.lock';
const BACKUP_DIR = '.init-backup';
const NUXT_CONFIG = 'nuxt.config.ts';
const PACKAGE_JSON = 'package.json';

const TOTAL = 12;

/**
 * 引导器目录 —— 第 4 项断言的核对范围。
 *
 * 不含 `server/plugins`：那个目录在产物里是**合法的**（用户自己的 Nitro 插件就放这儿），
 * 断言整个目录消失会在「初始化后自己加了个插件」时误报。
 * 引导器往那儿放的东西（wizard-token.ts）由第 3 项按白名单逐文件核对。
 */
const WIZARD_DIRS = [
  'app/pages/setup',
  'app/components/wizard',
  'app/utils/wizard',
  'server/api/wizard',
  'server/utils/wizard',
];

/**
 * 引导期专用依赖 —— 第 5 项断言的黑名单。
 *
 * 这个项目刻意做成**零依赖引导**（引导期 `dependencies` 只有 nuxt），所以清单很短，
 * 它的作用是挡回归：将来若有人为了在引导器里少写几行而装上 `h3`、`unbuild`，
 * 产物就会莫名其妙多出两个只在引导期用得上的包 —— 而那时引导器已经被删了。
 */
const WIZARD_ONLY_DEPS = ['unbuild', 'h3'];

/** 手写区必须仍然存在的锚点。与「逐字节比对」互补：锚点在没有任何快照时也能判。 */
const HANDWRITTEN_ANCHORS = ['defineNuxtConfig(', 'compatibilityDate', 'app: {', 'head: {'];

/** 首页不该再出现的东西 —— 引导期那个「把人送到 /setup」的重定向 */
const BOOTSTRAP_REDIRECT = "navigateTo('/setup')";

/** 第 12 项的耗时上限：类型检查在冷启动下几分钟属正常，但卡死必须被终止 */
const TYPECHECK_TIMEOUT_MS = 300_000;

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { __error: err.message };
  }
}

/** 最新的快照目录（时间戳命名，字典序即时间序） */
function latestSnapshotDir(root) {
  const base = resolve(root, BACKUP_DIR);
  if (!existsSync(base)) return null;
  const stamps = readdirSync(base)
    .filter((name) => {
      try {
        return statSync(join(base, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  return stamps.length ? join(base, stamps[stamps.length - 1]) : null;
}

/**
 * 第 12 项要跑的命令。
 *
 * 有 `typecheck` 脚本就跑它（那是用户视角下「类型检查」的正式入口）；
 * 没有（没选 ts-strict）就退回 `nuxt prepare` —— 它不是类型检查，但同样要求
 * nuxt.config.ts 与所有已装模块能被解析，足以证明「产物不是死的」。
 */
function resolveTypecheckCommand(root, lockfile) {
  const pkg = readJsonFile(resolve(root, PACKAGE_JSON));
  const hasScript = typeof pkg.scripts?.typecheck === 'string';
  const bin = lockfile === 'npm' ? 'npm' : 'pnpm';
  const args = hasScript ? ['run', 'typecheck'] : ['exec', 'nuxt', 'prepare'];
  return { bin, args, label: `${bin} ${args.join(' ')}`, hasScript };
}

/* ------------------------------------------------------------------ *
 * 12 项断言
 *
 * 每项返回 `{ ok, detail, skip }`：
 *   ok=false  → FAIL
 *   skip=true → SKIP（不计入通过，也不计入失败）
 * needs='config' 表示它依赖第 1 项读出来的 template.config.json
 * ------------------------------------------------------------------ */

/** 1. template.config.json 存在且可解析 */
function checkConfig(ctx) {
  const file = resolve(ctx.root, CONFIG_FILE);
  if (!existsSync(file)) {
    return { ok: false, detail: `找不到 ${CONFIG_FILE}，这个仓库还没有初始化过` };
  }
  const parsed = readJsonFile(file);
  if (parsed.__error) return { ok: false, detail: `JSON.parse 失败：${parsed.__error}` };
  if (!parsed.selection || typeof parsed.selection !== 'object') {
    return { ok: false, detail: '缺少 selection 字段' };
  }
  if (!parsed.plan || typeof parsed.plan !== 'object') {
    return { ok: false, detail: '缺少 plan 字段' };
  }

  ctx.config = parsed;
  ctx.plan = parsed.plan;
  return { ok: true, detail: `schemaVersion=${parsed.schemaVersion ?? '?'}，${parsed.initializedAt ?? '?'}` };
}

/**
 * 2. selection 与 plan 自洽
 *
 * 用 `plan.picked`（apply 阶段原样记下的「被选中的选项条目」）**重算一遍计划**，
 * 与存储的 plan 逐项比对。这条是「预览与执行一致」的兜底：
 * 服务端预览走 buildPlan，引擎落盘走同一套算法，跑完再重算一次，
 * 三者对不上就说明中间有一处不纯。
 */
function checkSelectionPlan(ctx) {
  const picked = ctx.plan.picked;
  if (!Array.isArray(picked) || picked.length === 0) {
    return {
      ok: false,
      detail: `plan.picked 缺失或为空，无法重算计划；请重新初始化（${CONFIG_FILE} 来自更早的版本）`,
    };
  }

  // selection 是**顶层**字段（`config.selection`），不在 `plan` 里：
  // 早期版本这里读成了 `ctx.plan.selection`，于是每个分组都被判成「不在 selection 中」，
  // 一条断言报了十条错 —— 这种「全错」的形态基本都指向读错了对象，而不是数据全坏。
  const selection = ctx.config.selection ?? ctx.plan.selection ?? {};

  const problems = [];

  let recomputed;
  try {
    recomputed = buildPlanFromPicked(picked, {
      lockfile: ctx.plan.lockfile,
      wizardFiles: WIZARD_FILES,
      keepFiles: KEEP_FILES,
      generatedFilesAll: ctx.plan.generatedFilesAll ?? [],
      conflicts: [],
    });
  } catch (err) {
    return { ok: false, detail: `重算计划失败：${err.message}` };
  }

  for (const key of ['deps', 'devDeps', 'modules', 'cssEntries', 'generatedFiles', 'allowBuilds']) {
    const stored = JSON.stringify(ctx.plan[key] ?? []);
    const again = JSON.stringify(recomputed[key]);
    if (stored !== again) problems.push(`${key} 不一致：存储 ${stored} ≠ 重算 ${again}`);
  }

  // 选择里「有值的分组」必须与 picked 覆盖的分组完全一致
  const fromSelection = Object.entries(selection)
    .filter(([, value]) => (Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined))
    .map(([key]) => key)
    .sort();
  const fromPicked = [...new Set(picked.map((p) => p.group))].sort();
  if (JSON.stringify(fromSelection) !== JSON.stringify(fromPicked)) {
    problems.push(`selection 涉及 ${JSON.stringify(fromSelection)}，picked 只覆盖 ${JSON.stringify(fromPicked)}`);
  }

  // 每个 picked 条目的值必须真的在 selection 里（防止记录与选择脱节）
  for (const entry of picked) {
    const value = selection[entry.group];
    const list = Array.isArray(value) ? value : [value];
    if (!list.includes(entry.value)) problems.push(`picked 里的 ${entry.group}=${entry.value} 不在 selection 中`);
  }

  // 删除清单的安全不变量：逐条枚举、去重升序、无通配符、无 ..
  const del = ctx.plan.deleteFiles;
  if (!Array.isArray(del)) problems.push('deleteFiles 不是数组');
  else {
    if (del.some((p) => p.includes('*') || p.includes('?'))) problems.push('deleteFiles 含通配符，违反「逐条枚举」纪律');
    if (del.some((p) => p.split(/[\\/]/).includes('..'))) problems.push('deleteFiles 含 ..');
    if (JSON.stringify(del) !== JSON.stringify([...new Set(del)].sort())) problems.push('deleteFiles 未去重升序');
  }

  if (problems.length) return { ok: false, detail: problems.join('；') };
  return {
    ok: true,
    detail: `${picked.length} 个选项条目 → deps ${recomputed.deps.length} / devDeps ${recomputed.devDeps.length} / modules ${recomputed.modules.length}`,
  };
}

/** 3. 引导器文件残留为 0（逐个 existsSync，不用通配符） */
function checkWizardFiles(ctx) {
  const left = WIZARD_FILES.filter((rel) => existsSync(resolve(ctx.root, rel)));
  ctx.wizardLeft = left.length;
  if (left.length) {
    const shown = left.slice(0, 4).join('，');
    return { ok: false, detail: `${left.length} 项仍在：${shown}${left.length > 4 ? ` …等 ${left.length} 项` : ''}` };
  }
  return { ok: true, detail: `已核对 ${WIZARD_FILES.length} 项` };
}

/** 4. 引导器目录已清空 */
function checkWizardDirs(ctx) {
  const survivors = [];
  for (const rel of WIZARD_DIRS) {
    const abs = resolve(ctx.root, rel);
    if (!existsSync(abs)) continue;
    // 目录还在时把内容列出来：可能是我清理逻辑漏了，也可能是用户自己在同名目录里放了东西
    const entries = readdirSync(abs);
    survivors.push(`${rel}/（${entries.length ? `残留 ${entries.slice(0, 3).join('、')}` : '空目录'}）`);
  }
  if (survivors.length) return { ok: false, detail: survivors.join('；') };
  return { ok: true, detail: `${WIZARD_DIRS.length} 个目录均已移除` };
}

/**
 * 5. package.json 无引导期专用依赖
 *
 * 注意**不**在这里核对「plan.deps 是否已在 package.json 里」：
 * 那些依赖是安装阶段由 `pnpm add` / `npm install` 写进去的，
 * 而 `--skip-install` 是正常用法 —— 把两件事混在一条断言里，
 * 会得到「用户明确跳过了安装，却被判失败」。声明与落盘属于第 11 项。
 */
function checkPackageDeps(ctx) {
  const file = resolve(ctx.root, PACKAGE_JSON);
  if (!existsSync(file)) return { ok: false, detail: `找不到 ${PACKAGE_JSON}` };
  const pkg = readJsonFile(file);
  if (pkg.__error) return { ok: false, detail: `${PACKAGE_JSON} 不是合法 JSON：${pkg.__error}` };
  ctx.pkg = pkg;

  const deps = pkg.dependencies ?? {};
  const devDeps = pkg.devDependencies ?? {};
  const problems = [];

  for (const name of WIZARD_ONLY_DEPS) {
    if (deps[name]) problems.push(`${name} 出现在 dependencies`);
    if (devDeps[name]) problems.push(`${name} 出现在 devDependencies`);
  }
  if (!deps.nuxt) problems.push('dependencies 里没有 nuxt（引导期与产物期都要它）');

  // 「多出来的包」只提示不判失败：初始化之后自己加依赖是完全正常的演进
  const declared = new Set(['nuxt', ...(ctx.plan?.deps ?? []), ...(ctx.plan?.devDeps ?? [])]);
  const extra = [...Object.keys(deps), ...Object.keys(devDeps)].filter((name) => !declared.has(name));
  if (extra.length) ctx.notes.push(`package.json 里有计划之外的包（你自己加的？）：${extra.join(', ')}`);

  if (problems.length) return { ok: false, detail: problems.join('；') };
  return {
    ok: true,
    detail: `dependencies ${Object.keys(deps).length} 项 / devDependencies ${Object.keys(devDeps).length} 项，无引导期专用包`,
  };
}

/** 6. marker 区间成对、可读、且内容与快照一致；MODULES 额外与 plan.modules 交叉核对 */
function checkMarkers(ctx) {
  const problems = [];
  let keys = 0;
  const texts = new Map();

  for (const file of MARKER_FILES) {
    const abs = resolve(ctx.root, file);
    if (!existsSync(abs)) {
      problems.push(`${file} 不存在`);
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    texts.set(file, text);

    for (const key of FILE_SECTION_KEYS[file]) {
      keys += 1;
      const begin = markerBegin(file, key);
      const end = markerEnd(file, key);
      const beginCount = countMarker(text, begin);
      const endCount = countMarker(text, end);
      if (beginCount !== 1 || endCount !== 1) {
        problems.push(`${file} TEMPLATE:${key} marker 不成对（>>> ${beginCount} 次 / <<< ${endCount} 次）`);
        continue;
      }
      const body = readSection(text, begin, end);
      if (body === null) {
        problems.push(`${file} TEMPLATE:${key} 读不出区间正文`);
        continue;
      }
      const expected = ctx.plan?.sections?.[file]?.[key];
      if (typeof expected === 'string' && body !== expected) {
        problems.push(`${file} TEMPLATE:${key} 与 ${CONFIG_FILE} 记录不一致（可能被手工改过）`);
      }
    }
  }

  // MODULES 交叉核对：把磁盘上的模块名解析出来，与 plan.modules 比 —— 不采信区间里存的东西
  const modulesBody = texts.has(NUXT_CONFIG)
    ? readSection(texts.get(NUXT_CONFIG), markerBegin(NUXT_CONFIG, 'MODULES'), markerEnd(NUXT_CONFIG, 'MODULES'))
    : null;
  if (modulesBody !== null) {
    const onDisk = [...modulesBody.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    const planned = ctx.plan?.modules ?? [];
    if (JSON.stringify(onDisk) !== JSON.stringify(planned)) {
      problems.push(`MODULES 区间为 ${JSON.stringify(onDisk)}，计划是 ${JSON.stringify(planned)}`);
    }
  }

  if (problems.length) return { ok: false, detail: problems.join('；') };
  return { ok: true, detail: `${keys} 个区间成对且已填充` };
}

/** 7. 样式入口与选择一致：不多写（引擎不越权）、不少写（声明就要落地） */
function checkCss(ctx) {
  const abs = resolve(ctx.root, NUXT_CONFIG);
  if (!existsSync(abs)) return { ok: false, detail: `找不到 ${NUXT_CONFIG}` };
  const text = readFileSync(abs, 'utf8');
  const body = readSection(text, markerBegin(NUXT_CONFIG, 'CSS'), markerEnd(NUXT_CONFIG, 'CSS'));
  if (body === null) return { ok: false, detail: 'CSS 区间不成对或读不出来' };

  const onDisk = [...body.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const planned = ctx.plan?.cssEntries ?? [];
  const extra = onDisk.filter((entry) => !planned.includes(entry));
  const missing = planned.filter((entry) => !onDisk.includes(entry));
  const problems = [];

  if (extra.length) problems.push(`多出未选择的入口 ${JSON.stringify(extra)}（若你自己加的，请同步更新 ${CONFIG_FILE}）`);
  if (missing.length) problems.push(`缺少已选择的入口 ${JSON.stringify(missing)}`);
  if (!extra.length && !missing.length && JSON.stringify(onDisk) !== JSON.stringify(planned)) {
    problems.push(`顺序与计划不符：${JSON.stringify(onDisk)} ≠ ${JSON.stringify(planned)}`);
  }
  if (!onDisk.includes('~/assets/styles/base.css')) {
    problems.push('样式入口里没有 ~/assets/styles/base.css（它是固定基线，任何方案都必须有）');
  }

  if (problems.length) return { ok: false, detail: problems.join('；') };
  return { ok: true, detail: onDisk.join(' → ') };
}

/** 8. 首页已替换：引导期那个重定向页必须消失，且换成了有内容的页面 */
function checkHomepage(ctx) {
  const abs = resolve(ctx.root, BASELINE_TARGETS[0]);
  if (!existsSync(abs)) return { ok: false, detail: `找不到 ${BASELINE_TARGETS[0]}` };
  const text = readFileSync(abs, 'utf8');
  if (text.includes(BOOTSTRAP_REDIRECT)) {
    return { ok: false, detail: `仍然包含引导期重定向 ${BOOTSTRAP_REDIRECT}，首页没有换成基线模板` };
  }
  if (text.length < 200) return { ok: false, detail: `只有 ${text.length} 字节，不像一个真实首页` };
  return { ok: true, detail: `${text.split('\n').length} 行` };
}

/** 9. nuxt.config.ts 手写区未被改动 */
function checkHandwritten(ctx) {
  const abs = resolve(ctx.root, NUXT_CONFIG);
  if (!existsSync(abs)) return { ok: false, detail: `找不到 ${NUXT_CONFIG}` };
  const blanked = blankSections(readFileSync(abs, 'utf8'), NUXT_CONFIG);

  // 判据 a（任何情况下都能判）：模板承诺的手写区锚点还在
  const missingAnchors = HANDWRITTEN_ANCHORS.filter((anchor) => !blanked.includes(anchor));
  if (missingAnchors.length) {
    return { ok: false, detail: `手写区缺少 ${JSON.stringify(missingAnchors)}，模板承诺的基线配置被删了` };
  }

  // 判据 b（独立证据优先）：与初始化前的快照逐字节比对
  const snapshotDir = latestSnapshotDir(ctx.root);
  if (snapshotDir) {
    const from = join(snapshotDir, NUXT_CONFIG);
    if (existsSync(from)) {
      const before = blankSections(readFileSync(from, 'utf8'), NUXT_CONFIG);
      if (before !== blanked) {
        return { ok: false, detail: `与快照 ${BACKUP_DIR}/${snapshotDir.split(/[\\/]/).pop()}/ 的手写区不一致` };
      }
      return { ok: true, detail: `与快照逐字节一致（${blanked.split('\n').length} 行）` };
    }
  }

  // 判据 c（快照已删除时的兜底）：与 apply 阶段记下的哈希比对
  const recorded = ctx.plan?.handwritten?.[NUXT_CONFIG];
  if (typeof recorded === 'string') {
    const actual = createHash('sha256').update(blanked, 'utf8').digest('hex');
    if (actual !== recorded) {
      return {
        ok: false,
        detail: `手写区哈希与初始化时不一致（${actual.slice(0, 12)}… ≠ ${recorded.slice(0, 12)}…）；`
          + '如果你确实手工改过这里，那是你的改动、不是初始化缺陷 —— 重新初始化或删掉 '
          + `${CONFIG_FILE} 里的 plan.handwritten 可消除本断言`,
      };
    }
    return { ok: true, detail: `哈希与初始化时一致（快照已不存在，用哈希兜底）` };
  }

  ctx.notes.push(`没有快照也没有 ${CONFIG_FILE}.plan.handwritten，第 9 项只核对了锚点`);
  return { ok: true, detail: '锚点齐全（无快照可做逐字节比对）' };
}

/** 10. 锁文件已清除 */
function checkLock(ctx) {
  if (existsSync(resolve(ctx.root, LOCK_FILE))) {
    return { ok: false, detail: `${LOCK_FILE} 仍在，说明初始化没有正常收尾` };
  }
  return { ok: true, detail: '未留下锁文件' };
}

/**
 * 11. 依赖已声明并安装
 *
 * 两段一起查，因为它们必然同时成立或同时不成立：
 *   ① 声明 —— `plan.deps` / `plan.devDeps` 出现在 package.json 的对应字段
 *      （依赖是被安装命令写进去的，不是引擎直接改的，所以要在这里查）；
 *   ② 落盘 —— `node_modules/<pkg>/package.json` 存在。
 * 只查声明会漏掉「pnpm 写了 package.json 但装到一半失败」，只查落盘会漏掉
 * 「装的是旧版本、与本次选择无关」。
 */
function checkInstalled(ctx) {
  if (ctx.skipInstall) {
    // 依赖是用户**随后**手工装的，此刻还没装 —— 第 12 项必须跟着跳过。
    // 第 12 项跑的是 `nuxt prepare` / `typecheck`，它们会去加载 nuxt.config 里声明的模块；
    // 模块没装就报 `NUXT_B8017 The module X could not be loaded`，而那条错误指的是
    // 「依赖没装」，不是「配置写错了」—— 照着它去改配置是纯浪费时间。
    // 这里只把 depsMissing 置上、不额外改第 12 项：两条路径（跳安装 / 装了但没装齐）
    // 的处置本来就该一样，多一个判据就多一处会漂移的地方。
    ctx.depsMissing = true;
    return { skip: true, detail: '--skip-install：没有跑安装阶段，装完再跑一次 `pnpm verify`' };
  }

  const deps = ctx.pkg?.dependencies ?? {};
  const devDeps = ctx.pkg?.devDependencies ?? {};
  const planDeps = ctx.plan?.deps ?? [];
  const planDev = ctx.plan?.devDeps ?? [];

  const undeclared = [
    ...planDeps.filter((name) => !deps[name]).map((name) => `${name}（dependencies）`),
    ...planDev.filter((name) => !devDeps[name]).map((name) => `${name}（devDependencies）`),
  ];

  const names = [...new Set(['nuxt', ...planDeps, ...planDev])];
  const missing = names.filter(
    (name) => !existsSync(resolve(ctx.root, 'node_modules', ...name.split('/'), 'package.json')),
  );

  if (undeclared.length || missing.length) {
    ctx.depsMissing = true;
    const parts = [];
    if (undeclared.length) {
      parts.push(`${undeclared.length} 个包没写进 package.json：${undeclared.slice(0, 4).join(', ')}${undeclared.length > 4 ? ' …' : ''}`);
    }
    if (missing.length) {
      parts.push(`${missing.length}/${names.length} 个包没落盘：${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ' …' : ''}`);
    }
    // 提示必须给**能直接跑的命令**：依赖的版本由包管理器解析后写进 package.json，
    // 所以少了 `add` 那几条时，光跑 `pnpm install` 是补不回来的
    const commands = installCommands(ctx.plan ?? { lockfile: 'pnpm', deps: [], devDeps: [] });
    const hint = commands.length ? `先执行：${commands.join(' && ')}` : '执行一次安装命令';
    return { ok: false, detail: `${parts.join('；')}；${hint}` };
  }
  return { ok: true, detail: `${names.length} 个包均已声明并安装` };
}

/** 12. 类型检查可跑（有 typecheck 脚本就跑它，否则退回 `nuxt prepare`） */
async function checkTypecheck(ctx) {
  if (ctx.fast) return { skip: true, detail: '--fast：跳过最慢的一项' };
  if (ctx.depsMissing) return { skip: true, detail: '依赖没装齐（见第 11 项），跑了也只会报错' };
  if (!existsSync(resolve(ctx.root, 'node_modules'))) {
    return { skip: true, detail: 'node_modules 不存在，先安装依赖' };
  }

  const { bin, args, label, hasScript } = resolveTypecheckCommand(ctx.root, ctx.plan?.lockfile ?? 'pnpm');

  ctx.notes.push(`第 12 项会执行 \`${label}\`（${hasScript ? 'package.json 里有 typecheck 脚本' : '没有 typecheck 脚本，改为校验 Nuxt 配置能被解析'}）`);

  const result = await runCommand(bin, args, { cwd: ctx.root, timeoutMs: TYPECHECK_TIMEOUT_MS });
  if (result.code === 0) return { ok: true, detail: `${label} 退出码 0` };

  const reason = result.timedOut
    ? `超时（${TYPECHECK_TIMEOUT_MS / 1000} 秒）`
    : result.spawnError
      ? `无法启动：${result.spawnError}`
      : `退出码 ${result.code}`;
  const tail = result.tail.slice(-6).join(' | ');
  return { ok: false, detail: `${label} ${reason}${tail ? ` → ${tail}` : ''}` };
}

const CHECKS = [
  { id: 1, name: `${CONFIG_FILE} 解析`, run: checkConfig },
  { id: 2, name: '选择与计划自洽', run: checkSelectionPlan, needs: 'config' },
  { id: 3, name: '引导器文件残留为 0', run: checkWizardFiles, needs: 'config' },
  { id: 4, name: '引导器目录已清空', run: checkWizardDirs, needs: 'config' },
  { id: 5, name: `${PACKAGE_JSON} 无引导期专用依赖`, run: checkPackageDeps, needs: 'config' },
  { id: 6, name: 'marker 区间成对且已填充', run: checkMarkers, needs: 'config' },
  { id: 7, name: '样式入口与选择一致', run: checkCss, needs: 'config' },
  { id: 8, name: '首页已替换', run: checkHomepage, needs: 'config' },
  { id: 9, name: `${NUXT_CONFIG} 手写区未被改动`, run: checkHandwritten, needs: 'config' },
  { id: 10, name: '锁文件已清除', run: checkLock },
  { id: 11, name: '依赖已安装', run: checkInstalled, needs: 'config' },
  { id: 12, name: '类型检查可跑', run: checkTypecheck, needs: 'config' },
];

// 断言条数与文档里的「12 项」必须一致，写死在这里防止有人删项而忘了改分母
if (CHECKS.length !== TOTAL) {
  throw new Error(`断言条数 ${CHECKS.length} 与文档约定的 ${TOTAL} 项不一致`);
}

/* ------------------------------------------------------------------ *
 * 事件输出
 * ------------------------------------------------------------------ */

/**
 * `runVerify` 被 init.mjs 调用时会传入它自己的出口，输出格式与引擎日志一致；
 * 独立执行时（`node scripts/verify.mjs`）用这个最简出口。
 * 只做一行一事件，不做进度条 —— 校验的输出要能被 `grep PASS` 直接用。
 */
function createEmitter(jsonLines = false) {
  return {
    emit(event) {
      if (jsonLines) {
        process.stdout.write(`${JSON.stringify(event)}\n`);
        return;
      }
      switch (event.type) {
        case 'log':
          process.stdout.write(`  ${event.line}\n`);
          break;
        case 'note':
          process.stdout.write(`  · ${event.message}\n`);
          break;
        case 'error':
          process.stdout.write(`  ✗ ${event.stage ? `[${event.stage}] ` : ''}${event.message}\n`);
          break;
        default:
          process.stdout.write(`  ${JSON.stringify(event)}\n`);
      }
    },
  };
}

const TAG = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' };

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/**
 * 跑完 12 项。
 *
 * @param {string} root                     仓库根目录
 * @param {object} [options]
 * @param {boolean} [options.fast]          跳过第 12 项
 * @param {boolean} [options.skipInstall]   引擎用了 --skip-install，第 11 项改为跳过
 * @param {object}  [options.out]           事件出口（缺省用本文件的最简出口）
 * @returns {Promise<number>} 0 = 无失败项；1 = 有失败项
 *
 * 注意「跳过不算失败」：`--fast` 的用途就是「我只想快速确认产物结构没问题」，
 * 让它返回 1 会把 `--fast` 变成不可用的选项。
 */
export async function runVerify(root, options = {}) {
  const out = options.out ?? createEmitter(Boolean(options.jsonLines));

  const ctx = {
    root: resolve(root),
    config: null,
    plan: null,
    pkg: null,
    skipInstall: Boolean(options.skipInstall),
    fast: Boolean(options.fast),
    depsMissing: false,
    wizardLeft: 0,
    notes: [],
  };

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];

  for (const check of CHECKS) {
    const label = `${String(check.id).padStart(2, ' ')} ${check.name}`;

    if (check.needs === 'config' && !ctx.config) {
      skipped += 1;
      out.emit({ type: 'log', level: 'info', line: `${TAG.skip} ${label}  —— 依赖第 1 项，已跳过` });
      continue;
    }

    let result;
    try {
      // 每项都在自己的 try 里：一项抛错不能让后面的项不跑（纪律 ②）
      result = await check.run(ctx);
    } catch (err) {
      result = { ok: false, detail: `断言自身出错：${err.stack ?? err.message}` };
    }

    if (result.skip) {
      skipped += 1;
      out.emit({ type: 'log', level: 'info', line: `${TAG.skip} ${label}  —— ${result.detail}` });
      continue;
    }
    if (result.ok) {
      passed += 1;
      out.emit({ type: 'log', level: 'info', line: `${TAG.pass} ${label}${result.detail ? `  —— ${result.detail}` : ''}` });
      continue;
    }

    failed += 1;
    failures.push(`${check.id}. ${check.name}：${result.detail}`);
    out.emit({ type: 'log', level: 'error', line: `${TAG.fail} ${label}  —— ${result.detail}` });
  }

  for (const note of ctx.notes) out.emit({ type: 'note', message: note });

  const summary = [
    `verify: ${passed}/${TOTAL} 通过`,
    `引导器残留 ${ctx.wizardLeft}`,
    skipped ? `跳过 ${skipped} 项` : null,
    failed ? `失败 ${failed} 项` : null,
  ].filter(Boolean).join('，');

  out.emit({ type: 'log', level: failed ? 'error' : 'info', line: summary });

  if (failed) {
    out.emit({ type: 'error', stage: 'verify', message: `${failed} 项断言未通过：\n    ${failures.join('\n    ')}` });
    out.emit({ type: 'note', message: `产物需要人工确认。要撤销这次初始化：node scripts/init.mjs --rollback` });
    return 1;
  }
  return 0;
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function printHelp() {
  process.stdout.write(`${[
    'Nuxt Shuttle 产物校验（12 项断言）',
    '',
    '用法：node scripts/verify.mjs [选项]',
    '',
    '  --fast             跳过第 12 项（类型检查，最慢的一项）',
    '  --json-lines       每行输出一条 JSON 事件',
    '  --root <dir>       指定仓库根目录（缺省为当前工作目录）',
    '  -h, --help         显示本帮助',
    '',
    '退出码：0 没有失败项（跳过不计） / 1 至少一项失败 / 2 参数错误',
  ].join('\n')}\n`);
}

export function parseArgs(argv) {
  const out = { fast: false, jsonLines: false, root: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') out.help = true;
    else if (token === '--fast') out.fast = true;
    else if (token === '--json-lines') out.jsonLines = true;
    else if (token === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--root 需要一个路径参数');
      out.root = value;
      index += 1;
    } else throw new Error(`未知参数：${token}`);
  }
  return out;
}

export async function runCli(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`参数错误：${err.message}\n`);
    return 2;
  }
  if (args.help) {
    printHelp();
    return 0;
  }
  return runVerify(args.root ?? process.cwd(), { fast: args.fast, jsonLines: args.jsonLines });
}

/** 直接运行才执行；被 import 时（init 的阶段 5、自测）只提供函数 */
const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`校验器崩溃：${err.stack ?? err.message}\n`);
      process.exitCode = 1;
    });
}

/** 供自测复用 */
export const internals = {
  CHECKS,
  TOTAL,
  WIZARD_DIRS,
  WIZARD_ONLY_DEPS,
  HANDWRITTEN_ANCHORS,
  latestSnapshotDir,
};
