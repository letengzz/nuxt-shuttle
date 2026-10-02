#!/usr/bin/env node
/**
 * 初始化引擎 —— 全项目**唯一逐字节必须正确**的部分。
 *
 * UI 写丑了能改，接口写错了能修，但引擎一次误删就可能把用户已经写好的业务文件带走，
 * 而且这种事故往往在跑完、重启、开发半小时之后才被发现。所以这个文件里：
 *   · 每一个删除项都是一条**具体相对路径**，绝不出现通配符；
 *   · 每一处改写都只碰 marker 区间，区间之外逐字节不动；
 *   · 所有失败都被**累积**而不是中断 —— 半删状态比「跑完但报告失败」危险得多。
 *
 * 五条设计原则（对应文档里的同名小节）：
 *   零依赖    只用 node: 内置模块。引擎要在「还没装依赖」的仓库里跑，
 *             引第三方包会形成鸡生蛋问题。
 *   幂等      同一选择跑两次，产物逐字节相同；--check 第二次返回 0。
 *   可预演    --dry-run 输出将发生的一切，且**不写任何文件**。
 *   可回滚    阶段 2 的快照能还原到「初始化前」。
 *   只动标记区 配置文件只在 marker 区间内替换，手写区逐字节不动。
 *
 * 五阶段：plan → snapshot → install → apply → verify
 * （**先装依赖，再改写配置**。反过来的话，运行中的 dev 服务会在「配置已声明模块、
 *   模块还不在 node_modules」的窗口里重启并报 NUXT_B8017。详见 STAGE_NAMES 上的注释。）
 *
 * CLI：
 *   node scripts/init.mjs --selection ./s.json --dry-run     只打印计划
 *   node scripts/init.mjs --selection ./s.json               实际执行
 *   node scripts/init.mjs --check                            比对磁盘与快照（CI 门禁）
 *   node scripts/init.mjs --template-config ./template.config.json   从快照重放
 *   node scripts/init.mjs --rollback                         恢复到最近一次快照
 *   附加：--json-lines（每行一条 JSON 事件）、--save-plan、--force-experimental、
 *         --skip-install、--fast、--root <dir>
 *
 * 自测友好性：本文件导出 runCli(argv)，返回退出码而**不自己 process.exit**，
 * 这样 scripts/selftest.mjs 可以在同一个进程里直接 import 并驱动它。
 * 受限环境里 spawnSync 可能直接失败，进程内调用是唯一可靠的测试形态。
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BASELINE_TARGETS, baselineTemplatePath, generatedTemplatePath } from '../shared/wizard/baseline.mjs';
import {
  assertShape,
  buildPlan,
  describeSelection,
  installCommands,
  installSteps,
  normalizeSelection,
  validateSelection,
} from '../shared/wizard/plan.mjs';
import {
  FILE_SECTION_KEYS,
  MARKER_FILES,
  assertRenderableTemplate,
  blankSections,
  buildTemplateVars,
  markerBegin,
  markerEnd,
  pickedItems,
  readSection,
  renderSections,
  renderTemplate,
  rewriteSection,
} from '../shared/wizard/sections.mjs';
import { KEEP_FILES, PRUNE_DIRS, WIZARD_FILES, isKeptPath } from '../shared/wizard/whitelist.mjs';
import { runCommand } from './lib/proc.mjs';
import { runVerify } from './verify.mjs';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const LOCK_FILE = 'template.init.lock';
const CONFIG_FILE = 'template.config.json';
const BACKUP_DIR = '.init-backup';
const SELECTION_FILE = '.wizard-selection.json';
const OPTIONS_FILE = 'server/utils/wizard/options.json';
const NUXT_CONFIG = 'nuxt.config.ts';
const PACKAGE_JSON = 'package.json';
const WORKSPACE_FILE = 'pnpm-workspace.yaml';

const SCHEMA_VERSION = '1.0.0';
const TEMPLATE_VERSION = '0.1.0';

/**
 * 五阶段。**「安装依赖」必须排在「改写与自举」之前**，这不是审美问题：
 *
 * `apply` 会把选中的模块写进 `nuxt.config.ts` 的 `modules: [...]`，而引导页本身就跑在
 * `nuxt dev` 里 —— 配置一变，dev 服务立刻重启去加载这些模块。如果那一刻它们还没装，
 * Nuxt 会抛 `NUXT_B8017: The module X could not be loaded`，用户看到的就是
 * 「点一下生成就炸了」。先装后写，重启时模块已经就位。
 *
 * 附带的好处更值钱：安装失败时 `apply` 一次都没跑 —— 引导器文件一个没删、配置一行没改、
 * 生成文件一个没写，仓库与点击前逐字节相同，修好网络直接重试即可。
 *
 * 顺序的**唯一**代价是 `pnpm-workspace.yaml` 的 allowBuilds 得提前落盘（见 writeAllowBuilds）：
 * pnpm 在安装那一刻就按它决定跑不跑依赖的构建脚本，事后补写没用。
 */
const STAGE_NAMES = ['计算计划', '备份快照', '安装依赖', '改写与自举', '校验产物'];
const STAGE_KEYS = ['plan', 'snapshot', 'install', 'apply', 'verify'];

/* ------------------------------------------------------------------ *
 * 参数解析
 * ------------------------------------------------------------------ */

const VALUE_FLAGS = {
  '--selection': 'selection',
  '--template-config': 'templateConfig',
  '--root': 'root',
};

const BOOLEAN_FLAGS = {
  '--dry-run': 'dryRun',
  '--check': 'check',
  '--save-plan': 'savePlan',
  '--json-lines': 'jsonLines',
  '--rollback': 'rollback',
  '--force-experimental': 'forceExperimental',
  '--skip-install': 'skipInstall',
  '--fast': 'fast',
};

export function parseArgs(argv) {
  const out = {
    selection: null,
    templateConfig: null,
    root: null,
    dryRun: false,
    check: false,
    savePlan: false,
    jsonLines: false,
    rollback: false,
    forceExperimental: false,
    skipInstall: false,
    fast: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(VALUE_FLAGS, token)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} 需要一个路径参数`);
      out[VALUE_FLAGS[token]] = value;
      index += 1;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(BOOLEAN_FLAGS, token)) {
      out[BOOLEAN_FLAGS[token]] = true;
      continue;
    }
    throw new Error(`未知参数：${token}（用 --help 看支持哪些）`);
  }

  if (out.selection && out.templateConfig) {
    throw new Error('--selection 与 --template-config 不能同时使用：两者都是输入源，同时给无法判断以哪个为准');
  }
  if (out.rollback && (out.selection || out.templateConfig)) {
    throw new Error('--rollback 不接受选择输入：它只恢复到最近一次快照');
  }
  if (out.check && (out.dryRun || out.rollback)) {
    throw new Error('--check 与 --dry-run / --rollback 互斥：--check 是只读比对，不会执行任何阶段');
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 事件输出：人类可读与 JSON Lines 共用同一套事件对象
 * ------------------------------------------------------------------ */

/**
 * 为什么共用：文档里那条建议不是省事，而是**防漂移**。
 * 两套输出各写一份格式化逻辑，迟早出现「日志里说删了 7 个、JSON 里说 9 个」——
 * 而这类不一致发生在「给机器看的那份」上时，几乎不会被人工发现。
 */
export function createEmitter({ jsonLines, quiet = false }) {
  const emit = (event) => {
    if (jsonLines) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }
    if (quiet) return;
    process.stdout.write(`${humanize(event)}\n`);
  };
  return { emit };
}

function humanize(event) {
  switch (event.type) {
    case 'stage': {
      const bar = '▌'.repeat(event.index + 1);
      return `\n${bar} [${event.index + 1}/${event.total}] ${event.name}`;
    }
    case 'log':
      return `  ${event.level === 'error' ? '✗ ' : ''}${event.line}`;
    case 'plan':
      return humanizePlan(event.plan);
    case 'sections':
      return humanizeSections(event.sections);
    case 'note':
      return `  · ${event.message}`;
    case 'drift':
      return `  DRIFT  ${event.message}`;
    case 'error':
      return `  ✗ [${event.stage}] ${event.message}`;
    case 'exit':
      return event.durationMs === undefined
        ? ''
        : `\n退出码 ${event.code}，用时 ${(event.durationMs / 1000).toFixed(1)} 秒`;
    default:
      return `  ${JSON.stringify(event)}`;
  }
}

function humanizePlan(plan) {
  const lines = [
    '',
    `选择：${describeSelection({ groups: [] }, {}) /* 占位，实际用下面的签名 */}`,
  ];
  lines.length = 0;
  lines.push('', `选择      : ${plan.selectionText}`);
  lines.push(`包管理器  : ${plan.lockfile}`);
  lines.push(`运行时依赖: ${plan.deps.length ? plan.deps.join(', ') : '（无）'}`);
  lines.push(`开发依赖  : ${plan.devDeps.length ? plan.devDeps.join(', ') : '（无）'}`);
  lines.push(`Nuxt 模块 : ${plan.modules.length ? plan.modules.join(', ') : '（无）'}`);
  lines.push(`样式入口  : ${plan.cssEntries.join(' → ')}`);
  lines.push(`将删除    : ${plan.deleteFiles.length} 个文件`);
  lines.push(`将生成    : ${plan.generatedFiles.length} 个文件`);
  lines.push(`将覆盖    : ${(plan.baselineTargets ?? []).join(', ')}`);
  lines.push(`marker 区间: ${plan.sections.join(', ')}`);
  for (const file of plan.deleteFiles) lines.push(`  删除  ${file}`);
  for (const file of plan.generatedFiles) lines.push(`  生成  ${file}`);
  return lines.join('\n');
}

function humanizeSections(sections) {
  const lines = ['', '将写入的区间内容：'];
  for (const [file, keys] of Object.entries(sections)) {
    for (const [key, content] of Object.entries(keys)) {
      lines.push(`  ${file}  TEMPLATE:${key}`);
      // 空行不加缩进：加了会打印出一串「看着有内容、其实只有空格」的行，
      // 让人以为区间正文多了一段空白
      for (const line of content.split('\n')) lines.push(line ? `    ${line}` : '');
    }
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------ *
 * 路径安全
 * ------------------------------------------------------------------ */

/**
 * 把相对路径拼成绝对路径，并保证它落在仓库内。
 *
 * 三种拒绝都要有，缺一不可：
 *   ① 通配符 —— 出现 * 或 ? 说明有人想用模式匹配删文件，那是本方案明令禁止的；
 *   ② `..` 段 —— 显式拒绝，不依赖下面那条前缀检查「顺手」拦下；
 *   ③ 前缀检查 —— 兜底，处理符号链接与盘符差异等前缀之外的情况。
 */
export function safeJoin(root, rel) {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error(`非法路径：${JSON.stringify(rel)}`);
  }
  if (rel.includes('*') || rel.includes('?')) {
    throw new Error(`路径里不允许出现通配符：${rel}`);
  }
  if (rel.split(/[\\/]/).includes('..')) {
    throw new Error(`路径里不允许出现 ..：${rel}`);
  }
  const abs = resolve(root, rel);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (abs !== root && !abs.startsWith(prefix)) {
    throw new Error(`路径越出仓库根目录：${rel} → ${abs}`);
  }
  return abs;
}

/* ------------------------------------------------------------------ *
 * marker 区间：读与写
 *
 * `rewriteSection` / `readSection` 现在住在 `shared/wizard/sections.mjs`，
 * 与 marker 语法（`markerBegin` / `markerEnd`）放在一起。
 * 搬过去的理由：校验器要读回区间、还要抹掉区间来比对「手写区有没有被动过」，
 * 两边必须共用同一套「区间边界算到哪一行」的规则 —— 各写一份的结果是
 * 「引擎写对了、校验器说不对」，而那种红灯会让人去改本来正确的文件。
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * 阶段 0：载入选择、算出计划
 * ------------------------------------------------------------------ */

function readJsonFile(file, label) {
  if (!existsSync(file)) throw new Error(`找不到${label}：${file}`);
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${label}不是合法 JSON：${err.message}`);
  }
}

function loadOptions(root) {
  const file = resolve(root, OPTIONS_FILE);
  if (!existsSync(file)) {
    throw new Error(
      `找不到候选清单 ${OPTIONS_FILE}。它属于引导器，初始化后会被删掉 —— `
      + '要重放已有方案请用 --template-config 指向 template.config.json。',
    );
  }
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** 把「按文件分组的区间」拍平成一颗用于展示的键列表。 */
function flattenSectionKeys(sections) {
  const keys = [];
  for (const [file, entries] of Object.entries(sections)) {
    for (const key of Object.keys(entries)) keys.push(`${file}#${key}`);
  }
  return keys;
}

function planFromOptions(root, rawSelection, args) {
  const options = loadOptions(root);

  try {
    assertShape(options, rawSelection);
  } catch (err) {
    // 位置信息必须带上：否则用户拿着「选择不合法」四个字只能来问人
    throw new Error(`选择不合法：${err.message}`);
  }

  const selection = normalizeSelection(options, rawSelection);
  const conflicts = validateSelection(options, selection, { allowExperimental: args.forceExperimental });
  const blocked = conflicts.filter((item) => item.level === 'block');
  if (blocked.length) {
    const detail = blocked.map((item) => `    - [${item.rule ?? '-'}] ${item.message}`).join('\n');
    throw new Error(`选择存在 ${blocked.length} 项阻断级冲突：\n${detail}`);
  }

  const plan = buildPlan(options, {
    selection,
    wizardFiles: WIZARD_FILES,
    keepFiles: KEEP_FILES,
    lockfile: selection.manager,
    conflicts,
  });

  return { options, selection, plan, conflicts };
}

/**
 * 从「内存里的选择对象」直接算出完整上下文 —— 不读任何文件。
 *
 * 与 `resolvePlan` 的关系：`resolvePlan` 负责「从哪儿拿选择」（命令行文件 / 工作区文件 / 快照），
 * 拿到之后走的就是这里。抽出来的唯一理由是 `scripts/matrix.mjs` 要在**不写任何文件**的前提下
 * 扫完 240 个组合 —— 如果让它自己拼一遍「断言 → 归一化 → 规则 → 计划 → 渲染区间」，
 * 那它验的就是另一套逻辑，而不是引擎真正会跑的这套。
 */
export function planFromRaw(root, rawSelection, args = {}) {
  const { options, selection, plan, conflicts } = planFromOptions(root, rawSelection, args);
  return {
    source: 'inline',
    options,
    selection,
    plan,
    conflicts,
    sections: renderSections(options, selection, plan),
    templateVars: buildTemplateVars(selection, plan),
  };
}

/**
 * 两种输入源：
 *   · --selection / 仓库内的 .wizard-selection.json → 读 options.json 现算计划
 *   · --template-config → 优先直接用快照里存好的 sections 重放
 *
 * 后者存在的意义：初始化之后 options.json 已经被删掉，但 CI 里仍然需要
 * 「从一次初始化复现出完全相同的产物」。快照自足，就能做到。
 */
function resolvePlan(root, args) {
  if (!args.templateConfig) {
    const file = args.selection
      ? resolve(root, args.selection)
      : resolve(root, SELECTION_FILE);
    const label = args.selection ? '--selection 指定的选择文件' : `${SELECTION_FILE}（由引导器接口写入）`;
    const raw = readJsonFile(file, label);
    // 允许直接把 template.config.json 当选择文件传进来：它有 selection 字段
    const input = raw.selection ?? raw;
    const { options, selection, plan, conflicts } = planFromOptions(root, input, args);
    return {
      source: args.selection ? 'selection' : 'workspace-selection',
      options,
      selection,
      plan,
      conflicts,
      sections: renderSections(options, selection, plan),
      templateVars: buildTemplateVars(selection, plan),
    };
  }

  const file = resolve(root, args.templateConfig);
  const config = readJsonFile(file, '--template-config 指定的快照');
  if (!config.selection) throw new Error(`${args.templateConfig} 里缺少 selection 字段`);

  const stored = config.plan ?? {};
  const hasSections = stored.sections && Object.keys(stored.sections).length > 0;
  if (!hasSections) {
    // 早期快照没有存 sections：退回读 options.json 现算（此时 options.json 必须还在）
    const { options, selection, plan, conflicts } = planFromOptions(root, config.selection, args);
    return {
      source: 'snapshot-legacy',
      options,
      selection,
      plan,
      conflicts,
      sections: renderSections(options, selection, plan),
      templateVars: buildTemplateVars(selection, plan),
    };
  }

  const plan = {
    selection: config.selection,
    lockfile: stored.lockfile ?? 'pnpm',
    deps: stored.deps ?? [],
    devDeps: stored.devDeps ?? [],
    modules: stored.modules ?? [],
    cssEntries: stored.cssEntries ?? [],
    allowBuilds: stored.allowBuilds ?? [],
    sections: flattenSectionKeys(stored.sections),
    deleteFiles: stored.deleteFiles ?? [...WIZARD_FILES],
    generatedFiles: stored.generatedFiles ?? [],
    generatedFilesAll: stored.generatedFilesAll ?? [],
    // 重放时没有 options 可查，这两个字段靠快照自足；apply 阶段会以**当前磁盘**
    // 的重算结果覆盖 handwritten，所以这里读到的值只用于「文件缺失时的兜底」
    picked: stored.picked ?? [],
    handwritten: stored.handwritten ?? {},
    keepFiles: [...KEEP_FILES].sort(),
    removeDeps: [],
    conflicts: [],
  };

  return {
    source: 'snapshot',
    options: null,
    selection: config.selection,
    plan,
    conflicts: [],
    sections: stored.sections,
    templateVars: buildTemplateVars(config.selection, plan),
  };
}

/**
 * 模板预检 —— 在**动任何文件之前**确认覆盖区与生成区的模板齐全且能渲染。
 *
 * 为什么不能等 apply 阶段再说：
 * apply 是「覆盖 → 生成 → 删除 → 改写」四段连做。如果某个生成模板缺失，
 * 发现它的时候删除段可能已经跑完一半了 —— 用户得到的是「引导器删了、新东西没生成」的
 * 半成品仓库。这类失败最贵，因为回滚要人工判断哪些该留。
 *
 * 放在这里还有一个好处：`--dry-run` 也就顺带覆盖了模板完整性。
 * `scripts/matrix.mjs` 正是靠「对 176 种组合逐个 dry-run」来一次性验证全矩阵的，
 * 而它不需要创建 176 个仓库。
 *
 * @returns {string[]} 问题列表，空数组表示可以继续
 */
function preflightTemplates(root, ctx) {
  const problems = [];

  for (const rel of BASELINE_TARGETS) {
    const tpl = baselineTemplatePath(rel);
    if (!existsSync(resolve(root, tpl))) {
      problems.push(`覆盖区缺少模板 ${tpl}（它负责生成 ${rel}）`);
    }
  }

  for (const rel of ctx.plan.generatedFiles) {
    try {
      // 拒绝 .vue：`{{ }}` 同时是 Vue 插值语法，会被占位符替换误伤
      assertRenderableTemplate(rel);
    } catch (err) {
      problems.push(err.message);
      continue;
    }
    const tpl = generatedTemplatePath(rel);
    const abs = resolve(root, tpl);
    if (!existsSync(abs)) {
      problems.push(`生成区缺少模板 ${tpl}（${ctx.plan.selection ? '当前选择' : '快照'}声明了 ${rel}）`);
      continue;
    }
    // 占位符必须全部声明：静默产出带 `{{x}}` 的文件，症状是「构建成功、
    // 产物里躺着一行占位符」，而那时已经无从判断它本该是什么
    const { missing } = renderTemplate(readFileSync(abs, 'utf8'), ctx.templateVars);
    if (missing.length) {
      problems.push(`模板 ${tpl} 里有未声明的占位符：${missing.join(', ')}（需要补进 buildTemplateVars）`);
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ *
 * 锁文件
 * ------------------------------------------------------------------ */

function writeLock(root, lock) {
  writeFileSync(resolve(root, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
}

function removeLock(root) {
  const file = resolve(root, LOCK_FILE);
  if (existsSync(file)) unlinkSync(file);
}

/* ------------------------------------------------------------------ *
 * 阶段 2：快照
 * ------------------------------------------------------------------ */

function timestamp() {
  // Windows 不允许文件名含冒号，所以把 : 与 . 都换成 -
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/** 需要进快照的文件：将被删除的 ∪ 将被生成的 ∪ 将被覆盖的 ∪ 将被改写的配置文件。 */
function filesToSnapshot(plan) {
  return [...new Set([
    NUXT_CONFIG,
    PACKAGE_JSON,
    WORKSPACE_FILE,
    '.npmrc',
    CONFIG_FILE,
    ...BASELINE_TARGETS,
    ...plan.deleteFiles,
    ...plan.generatedFiles,
  ])].sort();
}

function snapshot(root, selection, files, stamp, out) {
  const dir = resolve(root, BACKUP_DIR, stamp);
  mkdirSync(dir, { recursive: true });

  const manifest = [];
  for (const rel of files) {
    const from = safeJoin(root, rel);
    if (!existsSync(from)) {
      // 「当时不存在」也是必须记录的信息：回滚时要知道该把这个文件删掉
      manifest.push({ path: rel, existed: false });
      continue;
    }
    const to = resolve(dir, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    manifest.push({ path: rel, existed: true });
  }

  writeFileSync(resolve(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(resolve(dir, 'selection.json'), `${JSON.stringify(selection, null, 2)}\n`, 'utf8');
  out.emit({
    type: 'log',
    level: 'info',
    line: `快照：${manifest.filter((m) => m.existed).length} 个文件 → ${BACKUP_DIR}/${stamp}/（另有 ${manifest.filter((m) => !m.existed).length} 个当时不存在）`,
  });
  return dir;
}

/* ------------------------------------------------------------------ *
 * 阶段 4：apply
 *
 * 注意它排在 install **之后**：这里才第一次把选中的模块写进 nuxt.config.ts，
 * 而那一刻 dev 服务会重启去加载它们。详见 STAGE_NAMES 上的注释。
 * ------------------------------------------------------------------ */

function writeFileTracked(root, rel, content, report, failures) {
  try {
    const abs = safeJoin(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
    report.written.push(rel);
    return true;
  } catch (err) {
    failures.push(`写入 ${rel} 失败：${err.message}`);
    return false;
  }
}

/**
 * 删除动作：逐条、可失败、有记录。
 *
 * 三条校验缺一不可（对应文档里那句「三条缺一不可」）：
 *   ① safeJoin 保证路径在仓库内、无通配符、无 ..；
 *   ② 保留区优先判定 —— 保留判定必须比删除判定更早生效，
 *      万一将来有人把引擎自身误写进删除清单，后果不可逆；
 *   ③ 白名单全等 —— 路径必须与白名单里的某一项完全相同。
 */
function removeFiles(root, files, allowed, report, failures) {
  for (const rel of files) {
    let abs;
    try {
      abs = safeJoin(root, rel);
    } catch (err) {
      failures.push(`拒绝删除：${err.message}`);
      continue;
    }

    if (isKeptPath(rel)) {
      failures.push(`拒绝删除保留区文件：${rel}（它属于引擎或基线，删掉仓库就不完整了）`);
      continue;
    }
    if (!allowed.has(rel)) {
      failures.push(`拒绝删除未在白名单内的文件：${rel}`);
      continue;
    }

    if (!existsSync(abs)) {
      // 幂等的关键：文件不存在不是失败。上一次跑可能已经删过，或者它本来就没生成过。
      report.skipped.push(rel);
      continue;
    }

    try {
      unlinkSync(abs);
      report.removed.push(rel);
    } catch (err) {
      // Windows 下文件被占用是常见情况：记录失败，**不中断**。
      // 中断会留下半删状态，那比「跑完并报告 3 个文件没删掉」危险得多。
      failures.push(`删除 ${rel} 失败：${err.code ?? err.message}`);
      report.failed.push(rel);
    }
  }
}

/**
 * 只清理「读起来是空的」目录。
 *
 * **绝不要用 rm(dir, { recursive: true })**：用户完全可能在 app/pages/setup/ 里
 * 临时放过一个草稿文件，递归删除会一起带走。这里多一个文件就整体跳过 ——
 * 宁可留一个空目录，不可误删一个文件。
 *
 * @param {string[]} removedFilePaths 被删掉的**文件**路径清单（不是目录！）。
 *   候选目录 = 内置清单 ∪ 每个文件所在目录，按深度**从深到浅**处理，
 *   否则删掉 app/pages/setup 之后 app/pages 仍然「非空」，永远清不掉。
 *   误传目录进来不会报错，只会静默地少清理一层 —— 回滚后留下空目录就是这么来的。
 */
function pruneEmptyDirs(root, removedFilePaths, report) {
  const candidates = new Set(PRUNE_DIRS);
  for (const rel of removedFilePaths) {
    const dir = dirname(rel);
    if (dir && dir !== '.') candidates.add(dir.replaceAll('\\', '/'));
  }

  const ordered = [...candidates].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const rel of ordered) {
    let abs;
    try {
      abs = safeJoin(root, rel);
    } catch {
      continue;
    }
    try {
      if (!existsSync(abs) || !statSync(abs).isDirectory()) continue;
      if (readdirSync(abs).length === 0) {
        rmdirSync(abs);
        report.prunedDirs.push(rel);
      }
    } catch {
      // 目录不存在或被占用：忽略。清理是尽力而为，不是断言。
    }
  }
}

/**
 * 把「被选中的选项条目」压成可入快照的形态。
 *
 * 为什么要记它：初始化之后 `options.json`（候选清单）就被删掉了，而校验阶段
 * 仍然要能回答「这份计划真的等于各选项声明之和吗」—— 没有这份记录，
 * 第 2 项断言只能退化成「看起来像个计划」。只保留聚合用得上的字段，
 * `vitePlugin` / `config` 那些渲染用的信息不必留（区间内容已经存在 sections 里）。
 */
function compactPicked(options, selection) {
  return pickedItems(options, selection).map(({ group, value, item }) => ({
    group,
    value,
    item: {
      deps: item.deps ?? [],
      devDeps: item.devDeps ?? [],
      modules: item.modules ?? [],
      css: item.css ?? [],
      files: item.files ?? [],
      allowBuilds: item.allowBuilds ?? [],
    },
  }));
}

/**
 * 改写**一个**文件的 marker 区间。
 *
 * 抽出来是因为它有两个调用时机，且都必须在「仓库还可能被改到一半」的窗口内完成：
 *   · 安装**之前**只改 `pnpm-workspace.yaml`（见 writeAllowBuilds）；
 *   · 安装成功之后，`applyStage` 改全部三个文件（其余两个区间这时早已是空改写，
 *     文本与原文相同 → 直接跳过，幂等）。
 *
 * 返回是否真的写了盘（用于日志与断言）。
 */
function rewriteMarker(root, file, ctx, report, failures) {
  const { sections, plan } = ctx;
  const abs = resolve(root, file);
  if (!existsSync(abs)) {
    failures.push(`找不到 ${file}，无法改写它的 marker 区间`);
    return false;
  }
  const before = readFileSync(abs, 'utf8');

  // 手写区的哈希必须在**改写之前**算：它就是「初始化前的样子」，
  // 事后没有快照时靠它判断手写区有没有被人动过（第 9 项断言的兜底判据）。
  if (file === NUXT_CONFIG) {
    plan.handwritten ??= {};
    plan.handwritten[NUXT_CONFIG] = createHash('sha256').update(blankSections(before, NUXT_CONFIG), 'utf8').digest('hex');
  }

  let text = before;
  for (const key of FILE_SECTION_KEYS[file]) {
    const body = sections?.[file]?.[key];
    if (typeof body !== 'string') {
      failures.push(`${file} 的区间 ${key} 没有渲染结果`);
      continue;
    }
    try {
      text = rewriteSection(text, markerBegin(file, key), markerEnd(file, key), body);
    } catch (err) {
      failures.push(`${file} 的区间 ${key} 改写失败：${err.message}`);
    }
  }

  if (text === before) return false;

  // JSON 文件多一道工序：文本替换完必须整份 parse 一遍才能落盘。
  // 这一步是「用文本替换 JSON」这个做法的安全网 —— 少了它，一次手抖
  // 就会写出一份语法错误的 package.json，而所有后续命令都会失败。
  if (file === PACKAGE_JSON) {
    try {
      JSON.parse(text);
    } catch (err) {
      failures.push(`改写后的 ${PACKAGE_JSON} 不是合法 JSON，已放弃写入（磁盘上仍是原文件）：${err.message}`);
      return false;
    }
  }

  return writeFileTracked(root, file, text, report, failures);
}

/**
 * 安装前唯一要落的文件：`pnpm-workspace.yaml` 的 ALLOW_BUILDS 区间。
 *
 * 为什么不能等 `applyStage` 再写：pnpm 在**安装那一刻**就按这份清单决定要不要跑依赖的
 * 构建脚本（pnpm 11 的 strictDepBuilds 默认拒绝执行），事后补写不会让已经跳过的脚本重跑。
 * 选了 @nuxt/image 时 sharp 的安装脚本就靠它 —— 少了它，症状是「装完了但二进制缺失」，
 * 而报错信息一个字都不会提 allowBuilds。
 *
 * 它是**安装的前置条件，不是初始化产物**：安装没成功就等于这一步没发生过，
 * 调用方用 restoreFile() 从快照原样放回去，于是「装依赖失败 = 仓库逐字节不变」才成立。
 */
function writeAllowBuilds(root, ctx, report, failures) {
  return rewriteMarker(root, WORKSPACE_FILE, ctx, report, failures);
}

/**
 * 把单个文件从快照原样还原（快照记着「当时不存在」的就删掉）。
 *
 * 只用于「失败后把安装前的准备动作退回去」这一种场景。整仓回滚走 runRollback()，
 * 它要把锁与空目录一起收拾干净，职责不同，别合并。
 */
function restoreFile(root, backupDir, rel) {
  const manifestPath = resolve(backupDir, 'manifest.json');
  if (!existsSync(manifestPath)) return false;
  const manifest = readJsonFile(manifestPath, '快照的 manifest.json');
  const entry = manifest.find((item) => item.path === rel);
  if (!entry) return false;

  const abs = safeJoin(root, rel);
  if (!entry.existed) {
    if (existsSync(abs)) unlinkSync(abs);
    return true;
  }
  const from = resolve(backupDir, rel);
  if (!existsSync(from)) return false;
  cpSync(from, abs);
  return true;
}

function applyStage(root, ctx, report, failures, out) {
  const { plan, sections, templateVars } = ctx;

  // 手写区哈希**直接写进 plan**，不留在局部变量里。
  //
  // 小票由 writeConfig 在「安装之后」写出，那时才能记到 installed；它读的就是 plan.handwritten。
  // 两边各留一份局部变量的话，拆分之后就各走各的 —— 快照里写成空对象，
  // 第 9 项于是悄悄退化成「只核锚点」，手写区被改也报不出来。这条 bug 真发生过。
  plan.handwritten ??= {};

  // ① 覆盖区：内容来自 scripts/templates/baseline/**
  for (const rel of BASELINE_TARGETS) {
    const tpl = baselineTemplatePath(rel);
    const tplFile = resolve(root, tpl);
    if (!existsSync(tplFile)) {
      failures.push(`缺少基线模板 ${tpl}：覆盖区不允许静默跳过，请补上模板文件`);
      continue;
    }
    if (writeFileTracked(root, rel, readFileSync(tplFile, 'utf8'), report, failures)) {
      report.overlaid.push(rel);
    }
  }

  // ② 生成区：内容来自 scripts/templates/generated/**，带占位符替换
  for (const rel of plan.generatedFiles) {
    const tpl = generatedTemplatePath(rel);
    const tplFile = resolve(root, tpl);
    if (!existsSync(tplFile)) {
      failures.push(`缺少生成模板 ${tpl}：options.json 声明了 ${rel}，但模板不存在`);
      continue;
    }
    const { text, missing } = renderTemplate(readFileSync(tplFile, 'utf8'), templateVars);
    if (missing.length) {
      // 静默产出一个带 {{占位符}} 的文件，症状是「构建成功、产物里躺着一行占位符」
      failures.push(`模板 ${tpl} 里有未声明的占位符：${missing.join(', ')}`);
      continue;
    }
    if (writeFileTracked(root, rel, text, report, failures)) {
      report.generated.push(rel);
    }
  }

  // ③ 删除区
  const allowed = new Set([
    ...WIZARD_FILES,
    ...(plan.generatedFilesAll ?? []),
  ]);
  removeFiles(root, plan.deleteFiles, allowed, report, failures);

  // ④ marker 区间
  for (const file of MARKER_FILES) rewriteMarker(root, file, ctx, report, failures);

  pruneEmptyDirs(root, report.removed, report);
}

/**
 * 阶段 4 的收尾：写「小票」+ 清空目录。
 *
 * **为什么从 applyStage 里拆出来**：小票要记录 `installed`（安装阶段是否真的跑过），
 * 而安装发生在**这一步之前**（阶段 3）。留在 applyStage 里就只能在同一个函数里
 * 先写小票再安装，而那样 `installed` 永远只能记到「还没装」这一个事实，
 * 于是 `--check` 无法区分「跳安装导致的合法缺失」与「依赖被人删了的漂移」。
 * 顺序上它仍必须在所有破坏性动作之后 —— 小票存在 = 引导器已经清干净了。
 *
 * 另外几个字段是**给校验阶段留的独立证据**，不是装饰：
 *   picked      —— 选择 → 计划的原始记录，让「计划自洽」可被重算而不是只能自证；
 *   handwritten —— 初始化前 nuxt.config.ts 手写区的哈希，快照被删后仍能判断手写区没被动过；
 *   installed   —— 安装阶段是否真的跑过（见上）。
 */
function writeConfig(root, ctx, report, failures, out) {
  const { plan, sections } = ctx;
  const picked = ctx.options ? compactPicked(ctx.options, plan.selection) : (plan.picked ?? []);
  // 手写区哈希由 applyStage 在改写**之前**写进 plan —— 它是「初始化前的样子」，
  // 到这里已经改完了，重算只会得到「初始化后的样子」，那不是判据。
  const handwritten = plan.handwritten ?? {};

  const config = {
    schemaVersion: SCHEMA_VERSION,
    templateVersion: TEMPLATE_VERSION,
    initializedAt: new Date().toISOString(),
    installed: Boolean(plan.installed),
    selection: plan.selection,
    plan: {
      lockfile: plan.lockfile,
      deps: plan.deps,
      devDeps: plan.devDeps,
      modules: plan.modules,
      cssEntries: plan.cssEntries,
      allowBuilds: plan.allowBuilds,
      sections,
      deleteFiles: plan.deleteFiles,
      generatedFiles: plan.generatedFiles,
      generatedFilesAll: plan.generatedFilesAll ?? [],
      picked,
      handwritten,
    },
    removed: [...report.removed].sort(),
    kept: KEEP_FILES,
  };
  writeFileTracked(root, CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, report, failures);
  out.emit({ type: 'log', level: 'info', line: `已写入 ${CONFIG_FILE}（产物快照，永久保留）` });

  pruneEmptyDirs(root, report.removed, report);
  out.emit({
    type: 'log',
    level: 'info',
    line: `删除 ${report.removed.length} 个（跳过 ${report.skipped.length} 个不存在的）、生成 ${report.generated.length} 个、覆盖 ${report.overlaid.length} 个、清理 ${report.prunedDirs.length} 个空目录`,
  });
}

/* ------------------------------------------------------------------ *
 * 阶段 3：install
 *
 * 它排在 apply **之前**：先把依赖装好，下一步改写 nuxt.config.ts 时
 * 模块才已经在 node_modules 里，运行中的 dev 服务重启才不会报 NUXT_B8017。
 * 安装失败则整条 apply 都不执行 —— 仓库保持点击前的样子，可以直接重试。
 *
 * 跑命令的那套（Windows 的 .cmd 绕行、按行转事件、尾部输出与超时）
 * 现在住在 `scripts/lib/proc.mjs`，与 verify 的第 12 项断言共用。
 * 搬过去的理由：两处各写一份的话，「install 能跑、verify 说命令不存在」
 * 这类分叉会出现在最不该出现的地方。
 * ------------------------------------------------------------------ */

/**
 * `--skip-install` 时把要补跑的命令原样打出来。
 *
 * 见 `plan.mjs` 里 `installCommands` 的说明：引擎不写依赖版本，所以此时
 * package.json 里还没有这批包 —— 只说「你自己装一下」会让人白跑一趟。
 */
function emitInstallHint(plan, out, headline) {
  const commands = installCommands(plan);
  out.emit({ type: 'note', message: headline });
  if (!commands.length) {
    out.emit({ type: 'note', message: '这个方案没有额外依赖，只需要确保 npmrc 里已有的依赖装好即可。' });
    return;
  }
  for (const command of commands) out.emit({ type: 'note', message: `  ${command}` });
}

/**
 * 把 pnpm 的 `ERR_PNPM_IGNORED_BUILDS` 翻译成「该往哪写一行」。
 *
 * 为什么值得单独一段代码：这条错误的原文只有两行 —— 包名列表，加一句
 * 「Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts」。
 * 而 `approve-builds` 是**交互式**的，在引擎这种非交互环境里根本没有用武之地；
 * 真正的修法是往 `pnpm-workspace.yaml` 的 `allowBuilds` 里补条目，而错误原文
 * 一个字都没提这件事。不翻译的话，用户看到的是「装依赖失败」加一串包名，
 * 最贵的那一步（定位到哪个文件的哪一行）完全靠猜。
 *
 * @param {string} output 命令输出（尾部若干行即可，错误就在里面）
 * @returns {string[]|null} 逐行提示；不是这个错误时返回 null，别去打扰用户
 */
export function ignoredBuildHint(output) {
  const text = String(output ?? '');
  if (!text.includes('ERR_PNPM_IGNORED_BUILDS')) return null;

  // 列表里是「包名@版本」；作用域包名形如 '@parcel/watcher@2.6.0'，
  // 所以要截到**最后一个** @ 之前（下标 0 的 @ 是作用域前缀，不能截）。
  const names = (/Ignored build scripts:\s*([^\n]+)/.exec(text)?.[1] ?? '')
    .split(',')
    .map((spec) => spec.trim())
    .map((spec) => {
      const at = spec.lastIndexOf('@');
      return at > 0 ? spec.slice(0, at) : spec;
    })
    .filter(Boolean);

  if (!names.length) return null;

  // 拼出来的是**给用户粘进 YAML 的**键，所以作用域名必须带引号 —— 裸写会被解析器拒绝。
  const entries = names.map((name) => `    ${name.startsWith('@') ? `'${name}'` : name}: true`);
  return [
    'pnpm 拒绝执行未经审查的安装脚本，安装就此中断 —— allowBuilds 清单少了下面这几个包。',
    '把它们补进 pnpm-workspace.yaml 的 ALLOW_BUILDS 区间（按需要给 true / false）：',
    ...entries,
    '作用域包名必须加引号。不确定该不该跑脚本时，先在项目里跑一次 `pnpm approve-builds` 看一遍。',
  ];
}

/**
 * 安装阶段。返回是否**真的把依赖装进去了** ——
 * 这个事实要写进快照，否则 `--check` 无法区分「跳安装导致的合法缺失」与「被人删了的漂移」。
 */
async function installStage(root, plan, out, failures) {
  const steps = installSteps(plan);

  if (!steps.length) {
    out.emit({ type: 'log', level: 'info', line: '依赖清单为空，跳过安装' });
    plan.installed = true; // 没有依赖要装，视为已完成（不是「跳过」）
    return;
  }

  for (const step of steps) {
    const result = await runCommand(step.bin, step.args, { cwd: root, out, label: step.command });
    if (result.code !== 0) {
      const why = result.spawnError
        ? `无法启动（${result.spawnError}）`
        : result.timedOut
          ? '超时被终止'
          : `退出码 ${result.code}`;
      const tail = result.tail.slice(-5).join(' | ');
      failures.push(`${step.label}失败：${why}${tail ? `；末尾输出：${tail}` : ''}`);

      // 已知的、可自助修复的失败，在这里就地翻译成下一步动作。
      // 只翻译不兜底：安装确实失败了，退出码该是 1 就是 1 —— 但我们不该让用户
      // 拿着「ERR_PNPM_IGNORED_BUILDS」去搜，明明修法就是一行 YAML。
      for (const line of ignoredBuildHint(result.tail.join('\n')) ?? []) {
        out.emit({ type: 'note', message: line });
      }
      return;
    }
  }
  plan.installed = true;
}

/* ------------------------------------------------------------------ *
 * --check：比对磁盘与快照
 * ------------------------------------------------------------------ */

function runCheck(root, out) {
  const started = Date.now();
  const configFile = resolve(root, CONFIG_FILE);
  if (!existsSync(configFile)) {
    out.emit({ type: 'error', stage: 'check', message: `找不到 ${CONFIG_FILE}：这个仓库还没有初始化过` });
    out.emit({ type: 'exit', code: 1 });
    return 1;
  }

  const config = readJsonFile(configFile, CONFIG_FILE);
  const drifts = [];
  const notes = [];

  // ① 依赖：按快照里的 `installed` 分两种情况处理。
  //
  // 判据只能是 `installed`，不能是「依赖在不在」：
  //   installed === false  → 初始化时跳过了安装，依赖**本就该不在**，缺失是合法的 → 提示
  //   installed === true   → 依赖当时装进去了，现在没了 → **真漂移**，必须报红
  // 少了这个字段就只能二选一猜，猜哪边都错：要么让跳安装的仓库永远红（于是没人看输出），
  // 要么放过「有人删了依赖」这种真问题。
  const pkg = readJsonFile(resolve(root, PACKAGE_JSON), PACKAGE_JSON);
  const declared = new Set([...(config.plan?.deps ?? []), ...(config.plan?.devDeps ?? [])]);
  const actual = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  const missingDeps = [...declared].filter((name) => !actual.has(name));
  if (missingDeps.length) {
    // 只有**明确记录安装了**才算漂移。未记录时保守当提示：
    // 老快照（没有这个字段）与重放出来的仓库，都没有「装过」这个事实，凭它报红是冤枉。
    if (config.installed === true) {
      drifts.push(
        `deps: 缺少 ${missingDeps.length} 个已安装的依赖（${missingDeps.slice(0, 3).join(', ')}${missingDeps.length > 3 ? ' …' : ''}）：` +
        '快照记录安装已完成，但 package.json 里没有它们 —— 被手工删过，或没跑过 pnpm install。',
      );
    } else {
      const why = config.installed === false ? '初始化时跳过了安装' : '快照未记录安装状态';
      const command = installCommands(config.plan ?? {}).join('  &&  ');
      notes.push(`deps: 有 ${missingDeps.length} 个依赖尚未落盘（${why}）。补跑：${command}`);
    }
  }
  for (const name of actual) {
    if (!declared.has(name)) notes.push(`deps: 多出 ${name}（后加的依赖不影响一致性）`);
  }

  // ② marker 区间：逐字节比对
  const sections = config.plan?.sections ?? {};
  for (const [file, entries] of Object.entries(sections)) {
    const abs = resolve(root, file);
    if (!existsSync(abs)) {
      drifts.push(`${file}: 文件不存在`);
      continue;
    }
    const text = readFileSync(abs, 'utf8');
    for (const [key, expected] of Object.entries(entries)) {
      let actualBody;
      try {
        actualBody = readSection(text, markerBegin(file, key), markerEnd(file, key));
      } catch (err) {
        drifts.push(`${file} TEMPLATE:${key}: 读取失败 ${err.message}`);
        continue;
      }
      if (actualBody === null) {
        drifts.push(`${file}: 缺少 marker 区间 TEMPLATE:${key}`);
        continue;
      }
      if (actualBody !== expected) {
        drifts.push(`${file} TEMPLATE:${key}: 区间内容与快照不一致（可能被手工改过）`);
      }
    }
  }

  // ③ 引导器残留
  //
  // 变量名一律用 ASCII：这里原来写成了 `const残留`（const 与 CJK 标识符之间没有空格），
  // 词法分析把 `const残留` 当成**一个**标识符，于是这一行成了「给未声明变量赋值」，
  // 而下一行用的又是另一个名字 `残留` —— ESM 是严格模式，两处都会抛 ReferenceError。
  // 这条路径（--check）当时没跑过，所以问题一直藏着；ASCII 名字让它不可能再发生。
  const wizardLeft = WIZARD_FILES.filter((rel) => existsSync(resolve(root, rel)));
  if (wizardLeft.length) {
    drifts.push(`引导器残留 ${wizardLeft.length} 项：${wizardLeft.slice(0, 3).join(', ')}${wizardLeft.length > 3 ? ' …' : ''}`);
  }

  // ④ 快照声明已删除的文件不该又出现
  const resurrected = (config.removed ?? []).filter((rel) => existsSync(resolve(root, rel)));
  for (const rel of resurrected) drifts.push(`${rel}: 快照记录已删除，但它又出现了`);

  // ⑤ 锁
  if (existsSync(resolve(root, LOCK_FILE))) {
    drifts.push(`${LOCK_FILE}: 仍然存在（初始化未正常收尾，或有人手工创建）`);
  }

  for (const note of notes) out.emit({ type: 'note', message: note });

  const selectionText = Object.entries(config.selection ?? {})
    .map(([key, value]) => `${key}=${Array.isArray(value) ? (value.join('+') || '无') : value}`)
    .join(', ');

  if (drifts.length) {
    for (const drift of drifts) out.emit({ type: 'drift', message: drift });
    out.emit({ type: 'error', stage: 'check', message: `${drifts.length} 项漂移` });
    out.emit({ type: 'exit', code: 1, durationMs: Date.now() - started });
    return 1;
  }

  out.emit({ type: 'log', level: 'info', line: `OK  选择与磁盘一致（${selectionText}）` });
  out.emit({ type: 'exit', code: 0, durationMs: Date.now() - started });
  return 0;
}

/* ------------------------------------------------------------------ *
 * --rollback
 * ------------------------------------------------------------------ */

function runRollback(root, out) {
  const started = Date.now();
  const base = resolve(root, BACKUP_DIR);
  if (!existsSync(base)) {
    out.emit({ type: 'error', stage: 'rollback', message: `没有找到快照目录 ${BACKUP_DIR}/，无法回滚` });
    out.emit({ type: 'exit', code: 1 });
    return 1;
  }

  const stamps = readdirSync(base)
    .filter((name) => {
      try {
        return statSync(resolve(base, name)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
  if (!stamps.length) {
    out.emit({ type: 'error', stage: 'rollback', message: `${BACKUP_DIR}/ 里没有任何快照` });
    out.emit({ type: 'exit', code: 1 });
    return 1;
  }

  // 只回到**最近一次**快照，不提供「回到任意时间点」—— 那个交互一定会有人选错
  const stamp = stamps[stamps.length - 1];
  const dir = resolve(base, stamp);
  const manifest = readJsonFile(resolve(dir, 'manifest.json'), '快照的 manifest.json');

  const configPath = resolve(root, CONFIG_FILE);
  const depsForHint = existsSync(configPath)
    ? [...(JSON.parse(readFileSync(configPath, 'utf8')).plan?.deps ?? [])]
    : [];

  let restored = 0;
  let deleted = 0;
  const failures = [];

  for (const entry of manifest) {
    let abs;
    try {
      abs = safeJoin(root, entry.path);
    } catch (err) {
      failures.push(`跳过非法路径 ${entry.path}：${err.message}`);
      continue;
    }

    if (entry.existed) {
      const from = resolve(dir, entry.path);
      if (!existsSync(from)) {
        failures.push(`快照里缺少 ${entry.path}，无法恢复`);
        continue;
      }
      mkdirSync(dirname(abs), { recursive: true });
      cpSync(from, abs);
      restored += 1;
      continue;
    }

    if (existsSync(abs)) {
      try {
        unlinkSync(abs);
        deleted += 1;
      } catch (err) {
        failures.push(`删除 ${entry.path} 失败：${err.code ?? err.message}`);
      }
    }
  }

  // 锁与「小票」都不属于初始化前的状态：锁必须清掉，否则再也跑不了第二次初始化
  removeLock(root);

  // 传的是**文件路径清单**（pruneEmptyDirs 会对每一项取 dirname 当候选目录）。
  // 早先这里传的是 touchedDirs（已经是目录了），于是候选里出现的是 `app` 和 `.`，
  // 真正需要清理的 `app/stores`、`deploy` 反而没进候选 —— 回滚后留下两个空目录。
  const report = { prunedDirs: [] };
  pruneEmptyDirs(root, manifest.map((entry) => entry.path), report);

  out.emit({
    type: 'log',
    level: 'info',
    line: `恢复 ${restored} 个文件 / 删除 ${deleted} 个新建文件 / 清理 ${report.prunedDirs.length} 个目录`,
  });
  out.emit({ type: 'log', level: 'info', line: `已恢复到 ${BACKUP_DIR}/${stamp} 的状态` });

  if (depsForHint.length) {
    // 明确不卸载依赖：node_modules 的变更不可逆地混合了「引擎装的」与「你自己装的」
    out.emit({
      type: 'log',
      level: 'info',
      line: `依赖不会自动卸载。需要清理时手工执行：pnpm remove ${depsForHint.join(' ')}`,
    });
  }
  for (const failure of failures) out.emit({ type: 'log', level: 'error', line: failure });

  out.emit({ type: 'exit', code: failures.length ? 1 : 0, durationMs: Date.now() - started });
  return failures.length ? 1 : 0;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

async function runInit(root, args, out) {
  const started = Date.now();

  const stage = (index, key) => {
    out.emit({ type: 'stage', index, total: STAGE_NAMES.length, name: STAGE_NAMES[index], key });
  };

  stage(0, 'plan');
  const ctx = resolvePlan(root, args);
  const plan = ctx.plan;

  out.emit({
    type: 'plan',
    plan: {
      ...plan,
      selectionText: describeSelection(ctx.options ?? { groups: [] }, plan.selection),
      baselineTargets: BASELINE_TARGETS,
    },
  });

  // 模板预检放在「计划之后、动手之前」：这一段的失败必须做到仓库逐字节不变，
  // 否则用户面对的是一个删了一半的仓库，而他还什么都没做错
  const problems = preflightTemplates(root, ctx);
  for (const problem of problems) out.emit({ type: 'error', stage: 'plan', message: problem });

  if (args.dryRun) {
    // 预演必须**不写任何文件**（连日志文件都不写），否则用户不敢信任它
    out.emit({ type: 'sections', sections: ctx.sections });
    out.emit({ type: 'note', message: `--dry-run：没有写入任何文件。去掉它才会真正执行（会先快照到 ${BACKUP_DIR}/）` });
    if (args.savePlan) {
      out.emit({ type: 'note', message: '--save-plan 与 --dry-run 同时给出时以 --dry-run 为准，不写计划文件' });
    }
    out.emit({ type: 'exit', code: problems.length ? 1 : 0 });
    return problems.length ? 1 : 0;
  }

  if (problems.length) {
    // 预检没过就**不进入任何阶段**：不写锁、不建快照、不覆盖、不删除。
    // 此时仓库与执行前逐字节相同，用户可以放心去补模板再重试。
    out.emit({
      type: 'note',
      message: '模板预检未通过：没有写入、也没有删除任何文件，仓库与执行前一致。',
    });
    out.emit({ type: 'exit', code: 1 });
    return 1;
  }

  const failures = [];
  const report = { removed: [], failed: [], skipped: [], prunedDirs: [], generated: [], overlaid: [], written: [] };
  const stamp = timestamp();

  try {
    stage(1, 'snapshot');
    writeLock(root, { pid: process.pid, startedAt: new Date().toISOString(), stage: 'snapshot', selection: plan.selection });
    const backupDir = snapshot(root, plan.selection, filesToSnapshot(plan), stamp, out);

    if (args.savePlan) {
      writeFileSync(resolve(backupDir, 'plan.json'), `${JSON.stringify({ plan, sections: ctx.sections }, null, 2)}\n`, 'utf8');
      out.emit({ type: 'log', level: 'info', line: `计划已保存：${BACKUP_DIR}/${stamp}/plan.json` });
    }

    // 阶段 3：安装依赖。**排在 apply 之前** —— 理由见 STAGE_NAMES 上的注释：
    // 配置一旦声明模块，dev 服务就会重启去加载它们，那一刻它们必须已经在 node_modules 里。
    stage(2, 'install');
    if (args.skipInstall) {
      // 这里必须**把命令原样打出来**，不能只说「你自己装一下」。
      // 依赖的版本号由包管理器向 registry 解析后写进 package.json，引擎自己不写版本，
      // 所以此时 package.json 里**还没有**这批依赖 —— 单纯跑一次 `pnpm install`
      // 只会装 nuxt，选择的那批包一个都不会出现。少打一条 `add` 就是半小时的困惑。
      emitInstallHint(plan, out, '--skip-install：未执行安装。要补齐依赖，按顺序执行下面这几条：');
    } else {
      writeLock(root, { pid: process.pid, startedAt: new Date().toISOString(), stage: 'install', selection: plan.selection });
      // allowBuilds 必须赶在 pnpm 之前落盘（pnpm 在安装那一刻就按它决定跑不跑构建脚本）
      writeAllowBuilds(root, ctx, report, failures);
      if (!failures.length) await installStage(root, plan, out, failures);

      if (failures.length) {
        // 安装没成功 → 把 allowBuilds 放回原样，并且**一次 apply 都不执行**：
        // 引导器文件一个没删、配置一行没改、生成文件一个没写。
        // 于是「装依赖失败」不会把仓库变成半成品，修好网络直接重试即可。
        if (restoreFile(root, backupDir, WORKSPACE_FILE)) {
          out.emit({
            type: 'log',
            level: 'info',
            line: `已还原 ${WORKSPACE_FILE}：安装没成功，这一步不算发生过，仓库保持点「初始化项目」之前的样子`,
          });
        }
        emitInstallHint(plan, out, '装依赖失败。修好网络后可以先手工补上依赖，再回来重跑初始化：');
      }
    }

    if (!failures.length) {
      stage(3, 'apply');
      writeLock(root, { pid: process.pid, startedAt: new Date().toISOString(), stage: 'apply', selection: plan.selection });
      applyStage(root, ctx, report, failures, out);

      // 小票必须在 install 之后写：它要记下 `installed`（依赖到底进没进 package.json），
      // 而那是这一刻才知道的事实。写在 apply 里就只能记到「还没装」。
      if (!failures.length) writeConfig(root, ctx, report, failures, out);
    }

    // 破坏性动作全部完成且没有失败 → 删锁。锁只保护「可能被改到一半」的那段时间。
    if (!failures.length) removeLock(root);
  } catch (err) {
    failures.push(`未预期的错误：${err.stack ?? err.message}`);
  }

  stage(4, 'verify');
  let verifyCode = 1;
  try {
    // skipInstall 要传下去：没跑安装阶段时第 11 项（依赖已安装）必须**跳过**而不是失败，
    // 否则 `--skip-install` 这个正常用法会得到一个红色的收尾，并留下一把锁。
    verifyCode = await runVerify(root, { fast: args.fast, skipInstall: args.skipInstall, out });
  } catch (err) {
    failures.push(`校验阶段无法执行：${err.message}`);
  }

  const ok = failures.length === 0 && verifyCode === 0;
  for (const failure of failures) out.emit({ type: 'error', stage: 'init', message: failure });

  if (failures.length) {
    // 失败时**保留**锁并写入 error：重开页面才看得到「上次卡在哪」，
    // 否则用户会看到「什么都没发生」然后点第二次。
    writeLock(root, {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      stage: 'failed',
      selection: plan.selection,
      error: failures.join('\n'),
    });
    out.emit({
      type: 'note',
      message: `锁文件已保留（${LOCK_FILE}），其中记着失败原因。确认要撤销时执行：node scripts/init.mjs --rollback`,
    });
  }

  out.emit({ type: 'exit', code: ok ? 0 : 1, durationMs: Date.now() - started });
  return ok ? 0 : 1;
}

/* ------------------------------------------------------------------ *
 * CLI 入口
 * ------------------------------------------------------------------ */

/**
 * 帮助文本。`writer` 缺省是 process.stdout，可注入 ——
 * 自测要断言「帮助里到底写了哪些 flag」，不能只看真 stdout。
 */
export function printHelp(writer = process.stdout) {
  writer.write(`${[
    'Nuxt Shuttle 初始化引擎',
    '',
    '用法：node scripts/init.mjs [选项]',
    '',
    '  --selection <file>        选择 JSON（缺省读仓库内的 .wizard-selection.json）',
    '  --template-config <file>  以 template.config.json 为输入重放（初始化后仍可用）',
    '  --dry-run                 只打印计划与将写入的区间内容，不写任何文件',
    '  --check                   比对磁盘与 template.config.json，有漂移则退出码 1',
    '  --rollback                恢复到最近一次快照（不卸载依赖）',
    '  --save-plan               把计划写到 .init-backup/<时间戳>/plan.json',
    '  --json-lines              每行输出一条 JSON 事件（供接口转发）',
    '  --skip-install            跳过安装阶段',
    '  --force-experimental      解除实验性选项的阻断（CLI 专属，界面不提供）',
    '  --fast                    跳过耗时的校验项（类型检查）',
    '  --root <dir>              指定仓库根目录（缺省为当前工作目录）',
    '  -h, --help                显示本帮助',
    '',
    '退出码：0 成功 / 1 失败或存在漂移 / 2 参数错误',
  ].join('\n')}\n`);
}

export async function runCli(argv, options = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`参数错误：${err.message}\n`);
    return 2;
  }

  // out 可注入：自测要断言「引擎到底说了什么」而不是只看退出码。
  // 放在 --help 分支之前 —— 帮助文本也走同一条通道，否则自测只能看真 stdout。
  const out = options.out ?? createEmitter({ jsonLines: args.jsonLines, quiet: Boolean(options.quiet) });

  if (args.help) {
    printHelp(out);
    return 0;
  }

  const root = resolve(args.root ?? options.cwd ?? process.cwd());

  if (args.rollback) return runRollback(root, out);
  if (args.check) return runCheck(root, out);

  try {
    return await runInit(root, args, out);
  } catch (err) {
    out.emit({ type: 'error', stage: 'fatal', message: err.message });
    out.emit({ type: 'exit', code: 1 });
    return 1;
  }
}

/** 直接运行才执行；被 import 时（自测）只提供函数。 */
const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`引擎崩溃：${err.stack ?? err.message}\n`);
      process.exitCode = 1;
    });
}

/** 供自测与其它脚本复用 */
export const internals = {
  STAGE_KEYS,
  STAGE_NAMES,
  LOCK_FILE,
  CONFIG_FILE,
  BACKUP_DIR,
  SELECTION_FILE,
  OPTIONS_FILE,
  filesToSnapshot,
  compactPicked,
  preflightTemplates,
  pruneEmptyDirs,
  applyStage,
  writeConfig,
  snapshot,
  planFromRaw,
  resolvePlan,
  ignoredBuildHint,
};
