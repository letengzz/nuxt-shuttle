#!/usr/bin/env node
/**
 * 引擎自测 —— 零依赖、进程内驱动、含变异组。
 *
 * 为什么不能用 Vitest：引擎要在「还没装依赖」的仓库里跑（那是它的存在意义）。
 * 如果自测依赖 Vitest，就变成「装了依赖才能验引擎、而引擎坏了就装不上依赖」。
 * 所以自测也是一份只用 `node:` 内置模块的脚本。
 *
 * 为什么必须含**变异测试**：
 * 「跑一遍通过」只能证明门禁没崩，证明不了它能拦住东西。
 * 所以每个关键断言都配一个变异实验：把被测对象**故意改坏一格**，断言必须变红。
 * 比如「删掉 deleteFiles 里的一项 → 第 3 项断言必须报红」——
 * 如果删掉之后还是绿的，那个断言就是装饰。
 *
 * 分组（对应 `Quality` 第 5.1 节）：
 *   A 用法与元数据   B 计划正确性   C 幂等        D 手写区保护
 *   E marker 与缩进  F 门禁行为     G 全矩阵      H 变异性（变异实验）
 *   R 冲突规则命中（`--rules` 可单独跑）
 *
 * 沙箱约定见 `scripts/lib/sandbox.mjs`：固定沙箱根、每用例一个子目录、全程不删目录、
 * 进程内驱动引擎（受限环境里 `spawnSync` 会返回 EBUSY）。
 *
 * CLI：
 *   node scripts/selftest.mjs            跑全部分组
 *   node scripts/selftest.mjs --group D  只跑某一组（可重复）
 *   node scripts/selftest.mjs --rules    只跑冲突规则组（等价于 --group R）
 *   node scripts/selftest.mjs --list     列出分组与断言名，不执行
 *
 * 退出码：0 全绿 / 1 有失败 / 2 参数错误
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  assertRenderableTemplate,
  blankSections,
  countMarker,
  detectEol,
  markerBegin,
  markerEnd,
  readSection,
  renderTemplate,
  rewriteSection,
} from '../shared/wizard/sections.mjs';
import { KEEP_FILES, WIZARD_FILES, isKeptPath } from '../shared/wizard/whitelist.mjs';
import { runCli as engineCli, internals as engineInternals, parseArgs as engineParseArgs } from './init.mjs';
import { enumerate, parseArgs as matrixParseArgs, scan as scanMatrix } from './matrix.mjs';
import { capturingEmitter, ensureDir, exists, makeRepo, readText, runDir, writeJson } from './lib/sandbox.mjs';
import { checkRequires, exitCodeFor, formatState, internals as gatesInternals, parseCommand } from './run-gates.mjs';
import { parseArgs as verifyParseArgs, runVerify } from './verify.mjs';

const TEMPLATE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 测试里用到的文件写入（比在每条断言里 `await import('node:fs')` 清楚得多） */
function writeText(dir, rel, text) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
  return abs;
}

/* ------------------------------------------------------------------ *
 * 极简断言框架
 *
 * 不引第三方断言库（见文件头）。每条断言返回 true / 直接抛错，
 * 抛错信息里带上「期望什么、实际什么」—— 自测失败时最贵的是定位时间。
 * ------------------------------------------------------------------ */

const CASES = [];

function group(key, title) {
  const suite = {
    key,
    title,
    check(name, fn) {
      CASES.push({ group: key, title, name, fn });
      return suite;
    },
  };
  return suite;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function eq(actual, expected, label) {
  const a = typeof actual === 'string' ? actual : JSON.stringify(actual);
  const b = typeof expected === 'string' ? expected : JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}：期望 ${b}，实际 ${a}`);
}

function includes(haystack, needle, label) {
  assert(String(haystack).includes(needle), `${label}：${JSON.stringify(String(haystack).slice(0, 200))} 里找不到 ${JSON.stringify(needle)}`);
}

function hasAll(list, expected, label) {
  const missing = expected.filter((item) => !list.includes(item));
  assert(missing.length === 0, `${label}：缺少 ${JSON.stringify(missing)}（实际 ${JSON.stringify(list)}）`);
}

/**
 * 取出某条规则的声明列表（已 trim）。判「有这条声明」时必须用它，不能 includes(css, 'height:')：
 * 「height:」是「max-height:」的子串，后者会把前者的判据蒙过去 ——
 * 这正是把固定高度改回上限时，门禁却照绿的原因（与 <dialog> 那次同类的坑）。
 * 找不到规则时返回 null，由调用方 assert，避免在断言里抛 TypeError（崩溃比失败更难查）。
 */
function declarations(css, selector) {
  const pattern = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const body = pattern.exec(css)?.[1];
  return body === undefined ? null : body.split(';').map((d) => d.trim()).filter(Boolean);
}

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

const RUN_DIR = ensureDir(runDir());
const OPTIONS = JSON.parse(readFileSync(join(TEMPLATE_ROOT, engineInternals.OPTIONS_FILE), 'utf8'));

/** 每个用例要一份干净的仓库（用例会故意改坏文件，不能共用） */
function freshRepo(label) {
  return makeRepo(join(RUN_DIR, label), TEMPLATE_ROOT);
}

/** 只有主用例复用一个仓库：它只读不写 */
const SHARED_REPO = freshRepo('shared');

const BY_KEY = new Map(OPTIONS.groups.map((g) => [g.key, g]));
const DEFAULTS = normalizeSelection(OPTIONS, {});

/** 取「某个选择」的完整上下文（不碰文件系统） */
function ctxOf(raw, extra = {}) {
  return engineInternals.planFromRaw(SHARED_REPO, raw, extra);
}

/** 完整初始化一次（进程内驱动，跳过安装与耗时段） */
async function initRepo(dir, raw, extraArgs = []) {
  writeJson(dir, '.wizard-selection.json', raw);
  const out = capturingEmitter();
  const code = await engineCli(['--root', dir, '--skip-install', '--fast', ...extraArgs], { out });
  return { code, out };
}

function verifyRepo(dir, options = {}) {
  const out = capturingEmitter();
  // 沙箱里的仓库全是 `--skip-install` 跑出来的，第 11 项（依赖已安装）本就该 SKIP。
  // 默认带上它，断言里的「失败项」才只反映被测的那一项 —— 否则第 11 项常年报红，
  // 一条「退出码是 1」的断言会被它蒙对，被测项红不红反而看不出来。
  return { out, promise: runVerify(dir, { fast: true, skipInstall: true, ...options, out }) };
}

/**
 * 把仓库拨到「安装阶段已经成功跑过」的状态。
 *
 * 为什么需要它：自测全程用 `--skip-install`，依赖从未落盘，快照里 `installed` 是 false。
 * 在这种仓库上根本测不出「依赖本该在却被删了」—— 「跳过安装导致的缺失」与「被删掉的缺失」
 * 在磁盘上长得一模一样，而 `--check` 恰恰要靠这两个的差别决定报不报红。
 * 所以先把快照声明的依赖按占位版本写进 package.json（--check 只比名字集合，不比版本），
 * 再把 `installed` 拨成 true，之后做的破坏才是真漂移。
 */
function simulateInstalled(dir) {
  const config = JSON.parse(readText(dir, 'template.config.json'));
  const pkg = JSON.parse(readText(dir, 'package.json'));
  pkg.dependencies ??= {};
  pkg.devDependencies ??= {};
  for (const name of config.plan?.deps ?? []) pkg.dependencies[name] ??= '^0.0.0';
  for (const name of config.plan?.devDeps ?? []) pkg.devDependencies[name] ??= '^0.0.0';
  writeText(dir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  config.installed = true;
  writeText(dir, 'template.config.json', `${JSON.stringify(config, null, 2)}\n`);
}

/* ================================================================== *
 * A 用法与元数据
 * ================================================================== */

{
  const g = group('A', '用法与元数据');

  g.check('A1 --help 覆盖所有 flag', async () => {
    const out = capturingEmitter();
    const code = await engineCli(['--help'], { out });
    eq(code, 0, '--help 退出码');
    const text = out.text();
    hasAll(text, [
      '--selection', '--template-config', '--dry-run', '--check', '--rollback',
      '--save-plan', '--json-lines', '--skip-install', '--force-experimental', '--fast', '--root',
    ], '--help 输出');
  });

  g.check('A2 未知参数 → 退出码 2 且报出参数名', async () => {
    const code = await engineCli(['--nope']);
    eq(code, 2, '未知参数退出码');
    let parsed = null;
    try {
      parsed = engineParseArgs(['--nope']);
    } catch (err) {
      includes(err.message, '--nope', '错误文案');
    }
    assert(parsed === null, 'parseArgs 不该接受未知参数');
  });

  g.check('A3 互斥参数被拒绝', async () => {
    const pairs = [
      [['--selection', 'a.json', '--template-config', 'b.json'], 'selection 与 template-config'],
      [['--rollback', '--selection', 'a.json'], 'rollback 与 selection'],
      [['--check', '--dry-run'], 'check 与 dry-run'],
      [['--check', '--rollback'], 'check 与 rollback'],
    ];
    for (const [argv, label] of pairs) {
      let threw = false;
      try {
        engineParseArgs(argv);
      } catch {
        threw = true;
      }
      assert(threw, `${label} 应当被拒绝`);
      eq(await engineCli(argv), 2, `${label} 的 CLI 退出码`);
    }
  });

  g.check('A4 值参数缺值 → 退出码 2', async () => {
    eq(await engineCli(['--selection']), 2, '缺值退出码');
    eq(await engineCli(['--root']), 2, '--root 缺值退出码');
  });

  g.check('A5 三个脚本都带 isDirectRun 守卫', async () => {
    for (const rel of ['scripts/init.mjs', 'scripts/verify.mjs', 'scripts/matrix.mjs']) {
      const text = readFileSync(join(TEMPLATE_ROOT, rel), 'utf8');
      includes(text, 'isDirectRun', `${rel} 的守卫`);
      includes(text, 'process.exitCode', `${rel} 应当用 exitCode 而不是 process.exit()`);
    }
  });

  g.check('A6 引擎脚本只用 node: 内置模块（零依赖）', async () => {
    const files = [
      'scripts/init.mjs', 'scripts/verify.mjs', 'scripts/matrix.mjs',
      'scripts/lib/proc.mjs', 'scripts/lib/sandbox.mjs',
      'shared/wizard/plan.mjs', 'shared/wizard/sections.mjs',
      'shared/wizard/whitelist.mjs', 'shared/wizard/baseline.mjs',
    ];
    const bad = [];
    for (const rel of files) {
      for (const line of readFileSync(join(TEMPLATE_ROOT, rel), 'utf8').split('\n')) {
        const match = /^\s*import\s[^'"]*['"]([^'"]+)['"]/i.exec(line);
        if (!match) continue;
        const spec = match[1];
        // 允许：node: 内置、相对路径（自己的兄弟模块）
        if (!spec.startsWith('node:') && !spec.startsWith('.')) bad.push(`${rel} → ${spec}`);
      }
    }
    eq(bad, [], '非法 import（引擎必须零依赖）');
  });

  g.check('A7 verify / matrix 的参数解析', async () => {
    eq(verifyParseArgs(['--fast', '--json-lines']).fast, true, 'verify --fast');
    eq(verifyParseArgs(['--root', 'x']).root, 'x', 'verify --root');
    let threw = false;
    try {
      verifyParseArgs(['--nope']);
    } catch {
      threw = true;
    }
    assert(threw, 'verify 未知参数应抛错');

    eq(matrixParseArgs(['--dry-run-all', '--json']).json, true, 'matrix --json');
    eq(matrixParseArgs(['--filter', 'ui=nuxt-ui']).filter.ui, 'nuxt-ui', 'matrix --filter');
    threw = false;
    try {
      matrixParseArgs(['--filter', 'nope']);
    } catch {
      threw = true;
    }
    assert(threw, 'matrix 非法 --filter 应抛错');
  });

  g.check('A8 白名单与保留区不重叠', async () => {
    const overlap = WIZARD_FILES.filter((rel) => KEEP_FILES.includes(rel) || isKeptPath(rel));
    eq(overlap, [], '同时出现在删除白名单与保留区');
    const wildcards = [...WIZARD_FILES, ...KEEP_FILES].filter((rel) => /[*?]/.test(rel));
    eq(wildcards, [], '白名单里不该出现通配符');
  });

  g.check('A9 选择页必须真的触发数据加载', async () => {
    // 这条来自一次真实故障：state 是模块级单例，load() 被导出了却没人调用，
    // 页面永远停在「正在读取候选清单…」。服务端、接口、令牌全都正常，
    // 因为问题只在客户端 —— 靠读接口的探针永远发现不了。
    const page = readFileSync(join(TEMPLATE_ROOT, 'app/pages/setup/index.vue'), 'utf8');
    includes(page, 'onMounted(', '选择页的挂载钩子');
    assert(/onMounted\([\s\S]{0,200}?wizard\.(load|attach)\(/.test(page),
      'onMounted 里必须调用 wizard.load() 或 wizard.attach()，否则页面停在骨架态');

    // 进度页同理：它的入口是 attach()
    const progress = readFileSync(join(TEMPLATE_ROOT, 'app/pages/setup/progress.vue'), 'utf8');
    assert(/onMounted\([\s\S]{0,200}?wizard\.attach\(/.test(progress), '进度页的挂载钩子应调用 attach()');

    // 变异：把调用删掉，上面那条必须变红 —— 否则它只是装饰。
    // 正则要同时容下 `void` 与 `await`：选择页的挂载钩子改成 async 之后用的是 await，
    // 只认 void 的话变异会**静默失效**（这一步自己就是这么被抓出来的）。
    const mutated = page.replace(/(?:void |await )?wizard\.(load|attach)\(\);/g, '/* 删掉 */');
    assert(mutated !== page, '变异没生效：源码里找不到可删的调用');
    assert(!/onMounted\([\s\S]{0,200}?wizard\.(load|attach)\(/.test(mutated), '变异后不该再有调用');
  });

  g.check('A10 后端只声明引擎真正支持的 renderAs', async () => {
    // 前端的渲染分支与后端的联合类型必须对齐，否则某个分组会静默退化成默认形态。
    const types = readFileSync(join(TEMPLATE_ROOT, 'shared/wizard/types.ts'), 'utf8');
    const line = /export type RenderAs =([^;]+);/.exec(types);
    assert(line !== null, '找不到 RenderAs 联合类型');
    const declared = [...line[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();

    // 组件里被真正实现的分支
    const component = readFileSync(join(TEMPLATE_ROOT, 'app/components/wizard/OptionGroup.vue'), 'utf8');
    const used = new Set();
    for (const m of component.matchAll(/group\.renderAs === '([^']+)'/g)) used.add(m[1]);

    // 兜底分支（renderAs 落在联合类型之外）必须是**可见的报错**，不能是空 div：
    // 静默不渲染的后果是「某个分组整块消失」而控制台干干净净，最难定位。
    assert(
      /<div v-else class="hint hint--block">/.test(component),
      'v-else 兜底必须是可见报错，不能静默不渲染',
    );

    const options = JSON.parse(readFileSync(join(TEMPLATE_ROOT, 'server/utils/wizard/options.json'), 'utf8'));
    const inUse = [...new Set(options.groups.map((grp) => grp.renderAs))].sort();

    eq(declared, ['checks', 'radios'], '类型里声明的形态');
    hasAll([...used], inUse, '组件已实现的形态（options.json 里用到的每个都得有分支）');
    eq([...used].sort(), declared, '实现与声明必须一一对应，不留无人使用的形态');

    // 形态与语义的对应关系：单选组一律横向单选按钮，多选组一律「新增 + 可滑动列表」面板。
    // 这条是 2026-10-02 定下的界面约定（此前单选用过纵向卡片与下拉，多选用过纵向复选行），
    // 钉在这里是为了防止「某个分组又冒出一个不属于任何形态的控件」。
    for (const grp of options.groups) {
      eq(grp.renderAs, grp.multiple ? 'checks' : 'radios', `${grp.key} 的控件形态`);
    }

    // 多选面板是「右上角新增 + 下方固定高度列表 + 选择弹窗」三件套。
    // 三个部件**缺任何一个都会静默退化**：少了弹窗，「新增」就是个点不动的空按钮；
    // 高度不写死，列表一长就回到「把整页撑长」的老样子 —— 那正是这次要摆脱的。
    const css = readFileSync(join(TEMPLATE_ROOT, 'app/assets/styles/wizard.css'), 'utf8');
    includes(component, 'class="panel__add"', '多选面板右上角的「新增」按钮');
    // 这里不能用 includes(component, '<dialog')：注释里也出现了「<dialog>」，
    // 拿它当判据的话，模板里的弹窗被删掉也照样能过（第一版就是这么写的，变异测试当场抓出来）。
    // 改成要求「同一个标签里既有 <dialog 又有这个类名」—— `[^>]*` 跨不过 `>`，
    // 注释里那个已经闭合的 <dialog> 自然落选。
    assert(
      /<dialog\s[^>]*class="modal modal--picker"/.test(component),
      '多选面板的「新增」弹窗必须是原生 <dialog class="modal modal--picker">',
    );
    // 列表高度必须是**写死**的，不是只给上限（2026-10-02 第三版约定）：
    // 只给上限时，列表会随选择项数在「两个空位」到 200px 之间伸缩，把下面的面板推上推下，
    // 两个多选面板也永远对不齐 —— 而它们就并排站在同一栏里。
    const listDecls = declarations(css, '.panel__list');
    assert(listDecls !== null, '找不到 .panel__list 规则（选择器被改过？）');
    assert(
      listDecls.some((d) => /^height:\s*var\(--panel-list-h\)$/.test(d)),
      '列表高度必须写死（.panel__list 需要 `height: var(--panel-list-h)`）—— '
      + '改回 max-height 就是「随内容伸缩」，两块面板立刻不等高',
    );
    assert(
      /\.panel\s*\{[^}]*--panel-list-h\s*:/.test(css),
      '--panel-list-h 必须定义在 .panel 上：两块多选面板共用同一个高度才谈得上对齐',
    );

    // 底部吸附区（2026-10-02 第三版约定）：冲突提示 + 操作条不随内容滚。
    // 静态能查的是**结构**：页面必须分成「滚动区」与「吸附区」两层，操作条在吸附区里。
    // 而「滚起来它真的不动」是运行时行为，静态断言证明不了 —— 交给 CDP 那套实测。
    // 为什么值得钉：把 footer 挪回滚动区里，页面照样渲染、没有报错，
    // 只是又跟着一起滚了 —— 这类回归肉眼不看滚动是发现不了的。
    const page = readFileSync(join(TEMPLATE_ROOT, 'app/pages/setup/index.vue'), 'utf8');
    assert(page.includes('class="wizard__body"'), '页内容（页首 + 两栏 + 进度面板）必须包在 .wizard__body 里');
    const dockAt = page.indexOf('class="wizard__dock"');
    assert(dockAt > 0, '页面必须有 .wizard__dock（底部吸附区）');
    assert(
      page.indexOf('class="wizard__footer"') > dockAt,
      '操作条必须放在 .wizard__dock 里（出现在它之前，就等于还留在滚动区，会跟着一起滚）',
    );
    assert(
      /\.wizard\s*\{[^}]*height:\s*100dvh/.test(css),
      '外壳必须固定一屏高（.wizard 需要 height: 100dvh），否则吸附区被内容推到屏幕外',
    );
    const bodyDecls = declarations(css, '.wizard__body');
    assert(bodyDecls !== null, '找不到 .wizard__body 规则（滚动区不见了？）');
    assert(
      bodyDecls.some((d) => /^min-height:\s*0$/.test(d)) && bodyDecls.some((d) => /^overflow:/.test(d)),
      '滚动区必须是能自己滚的 flex 子项：.wizard__body 同时需要 overflow 与 min-height: 0 —— '
      + '少了 min-height: 0 它会被内容撑破、整页又滚起来，吸附是**静默**失效的',
    );
    assert(
      /\.wizard__dock\s*\{[^}]*flex:\s*none/.test(css),
      '.wizard__dock 不能被压缩（需要 flex: none），否则内容一长它先被挤扁',
    );

    // 卡片化 + 撤掉分组说明（2026-10-02 第二版约定）：每个分组是一张卡片，
    // 说明只留页首那一句。为什么值得钉 —— 「给某个分组加回一段说明」是**不会报错**的改动：
    // 没有这条门禁，下一个人把 desc 加回来时测试全绿，而界面已经不是约定的样子了。
    //
    // 判据写成 class="group__desc" 而不是裸的 group__desc：wizard.css 与组件注释里都写着
    // 这个词（都在讲「已经撤掉了」），用裸子串当判据的话，规则被加回来也照样绿 ——
    // 和 <dialog> 那一次的坑是同一个（注释命中判据）。
    for (const rel of [
      'app/components/wizard/OptionGroup.vue',
      'app/components/wizard/NuxtConfigPanel.vue',
      'app/pages/setup/index.vue',
    ]) {
      assert(
        !/class="group__desc"/.test(readFileSync(join(TEMPLATE_ROOT, rel), 'utf8')),
        `${rel} 不应再渲染分组说明（页面上只保留页首那一句）`,
      );
    }
    assert(
      !/\n\.group__desc\s*\{/.test(css),
      'wizard.css 里不该再有 .group__desc 规则（说明已撤掉，留着就是给幽灵元素备样式）',
    );

    // 两种形态必须落到**同一套**卡片语言上：单选组的 fieldset 与多选组的面板
    // 各自画一遍卡片，任一处漏掉左竖条，两栏看起来就是两种风格。
    assert(
      /isPanel \? 'group--panel' : 'group--card'/.test(component),
      '分组容器要按形态挂 .group--card / .group--panel',
    );
    assert(
      /\.group--card\s*\{[^}]*border-left:\s*3px solid var\(--brand-500\)/.test(css)
        && /\.panel\s*\{[^}]*border-left:\s*3px solid var\(--brand-500\)/.test(css),
      '卡片与面板都要有那条 3px 品牌色左竖条（少一处两栏就不是一套语言）',
    );
    // 单选卡片的标题是骑在上边框上的 <legend>，靠这条规则给底色与内边距。
    // 规则没了不会报错，只会让标题压在边框线上 —— 所以钉住。
    assert(
      /\.group--card > legend\s*\{/.test(css),
      '单选卡片的标题需要 .group--card > legend 才不至于压在卡片边框上',
    );
  });

  g.check('A11 引擎阶段顺序：先装依赖、再改写配置', async () => {
    // 为什么这条值得单独立一个门禁：顺序错了**不崩、不报错**，只在运行中的 dev 服务里
    // 炸出 `NUXT_B8017 The module X could not be loaded` —— apply 先把模块写进 nuxt.config.ts，
    // 而 dev 服务一看到配置变了就重启去加载它们，那一刻模块还没装。
    // 2026-10-02 就是这么翻车的：安装失败（registry 不通）→ 9 个模块一个没装 →
    // 配置里却已经声明了它们 → 页面上一片 NUXT_B8017，用户以为「点一下生成就把项目搞坏了」。
    //
    // 静态能查的四件事：① 引擎与前端的阶段顺序/文案一致；② 安装调用排在 apply 之前；
    // ③ apply 守在「安装没失败」后面；④ 安装前那唯一一次写盘不许碰 nuxt.config.ts。
    const init = readFileSync(join(TEMPLATE_ROOT, 'scripts/init.mjs'), 'utf8');

    const keysMatch = /const STAGE_KEYS = \[([^\]]+)\]/.exec(init);
    const namesMatch = /const STAGE_NAMES = \[([^\]]+)\]/.exec(init);
    assert(keysMatch !== null && namesMatch !== null, '找不到 STAGE_KEYS / STAGE_NAMES（被改名了？）');
    const keys = [...keysMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    const names = [...namesMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);

    eq(keys, ['plan', 'snapshot', 'install', 'apply', 'verify'], '引擎阶段顺序（install 必须在 apply 之前）');
    eq(names.length, keys.length, '阶段名与阶段键数量必须相等');

    // 前端阶段条自己写了一份 STAGES；两份漂移的症状是「进度条指错阶段」，比对长度不够，顺序也要对。
    const front = readFileSync(join(TEMPLATE_ROOT, 'app/utils/wizard/option-model.ts'), 'utf8');
    const pairs = [...front.matchAll(/\{ key: '([^']+)', label: '([^']+)' \}/g)];
    assert(pairs.length === keys.length, `前端 STAGES 应解析出 ${keys.length} 项，实际 ${pairs.length} 项（写法变了？）`);
    eq(pairs.map((m) => m[1]), keys, '前端阶段条的 key 顺序必须与引擎一致');
    eq(pairs.map((m) => m[2]), names, '前端阶段条的文案必须与引擎一致');

    // 判据锚在**带实参的调用点**上：注释里也写着 installStage / applyStage 这两个词，
    // 用裸子串会被注释骗过去（<dialog> 与 group__desc 那两次都是这么栽的）。
    const installAt = init.indexOf('await installStage(root, plan, out, failures)');
    const applyAt = init.indexOf('applyStage(root, ctx, report, failures, out);');
    assert(installAt > 0, '找不到 installStage 的调用点');
    assert(applyAt > 0, '找不到 applyStage 的调用点');
    assert(
      installAt < applyAt,
      '安装必须排在 apply 之前：apply 才把模块写进 nuxt.config.ts，'
      + '模块还不在 node_modules 里时 dev 服务重启就会报 NUXT_B8017',
    );

    assert(
      /if \(!failures\.length\) \{\s*stage\(3, 'apply'\)/.test(init),
      'apply 必须包在 `if (!failures.length)` 里：安装失败就该一次 apply 都不跑，仓库保持点击前的样子',
    );

    // 安装前唯一一次写盘只许碰 pnpm-workspace.yaml。提前写 nuxt.config 的 modules
    // 等于把这个 bug 原样放回来，而且连「安装失败」这个触发条件都不再需要。
    const allow = /function writeAllowBuilds\(root, ctx, report, failures\) \{\s*return rewriteMarker\(root, (\w+)/.exec(init);
    assert(allow !== null, '找不到 writeAllowBuilds（安装前落 allowBuilds 的那一步）');
    eq(allow[1], 'WORKSPACE_FILE', '安装前只许写 pnpm-workspace.yaml（NUXT_CONFIG 得等安装成功之后）');

    // 失败时要把 allowBuilds 从快照还原，否则「装依赖失败 = 仓库逐字节不变」不成立
    assert(
      /if \(failures\.length\) \{[\s\S]{0,400}?restoreFile\(root, backupDir, WORKSPACE_FILE\)/.test(init),
      '安装失败必须把 pnpm-workspace.yaml 还原回去，否则仓库不再等于「点初始化之前」',
    );

    // 第 12 项（`nuxt prepare` / `typecheck`）在依赖没装齐时必须跳过 —— 它会加载
    // nuxt.config 里声明的模块，装不上就报 `NUXT_B8017 The module X could not be loaded`，
    // 而那条错误指的是「依赖没装」，长得却像「配置写错了」。
    // `--skip-install` 这条路径此前是漏的：第 11 项跳过了，没人置 depsMissing，第 12 项于是照跑。
    const verify = readFileSync(join(TEMPLATE_ROOT, 'scripts/verify.mjs'), 'utf8');
    assert(
      /if \(ctx\.skipInstall\) \{[\s\S]{0,900}?ctx\.depsMissing = true;[\s\S]{0,200}?return \{ skip: true, detail: '--skip-install/
        .test(verify),
      '第 11 项因 --skip-install 跳过时也必须置 depsMissing，否则第 12 项会跑 nuxt prepare 并报 NUXT_B8017',
    );
  });

  g.check('A12 安装失败要给可自助的下一步：把 ERR_PNPM_IGNORED_BUILDS 翻成该写的那几行', async () => {
    // 为什么这条值得卡：那条错误的原文只有「包名列表」加一句「跑 pnpm approve-builds」，
    // 而 approve-builds 是**交互式**命令，在引擎里没有用武之地；真正的修法是往
    // pnpm-workspace.yaml 的 allowBuilds 里补条目，原文一个字都没提。
    // 2026-10-02 就是这么卡住的：用户拿到一串包名，只能来问人。
    //
    // 判据直接钉在**实测捕获的真实输出**上，不是自己编一句像样的错误。
    const hint = engineInternals.ignoredBuildHint;
    const real = '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @parcel/watcher@2.6.0, esbuild@0.28.2, unrs-resolver@1.12.2\n'
      + 'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.';

    const lines = hint(real);
    assert(Array.isArray(lines) && lines.length > 0, '识别不出 ERR_PNPM_IGNORED_BUILDS');

    // 这几行是给用户**直接粘进 YAML** 的，所以三件事要一起对：包名去掉版本号、
    // 作用域名带引号、取值写成布尔。
    eq(
      lines.filter((line) => /^\s{2,}[^\s]+: (true|false)$/.test(line)).map((line) => line.trim()),
      ["'@parcel/watcher': true", 'esbuild: true', 'unrs-resolver: true'],
      '提示里的 YAML 条目',
    );
    includes(lines.join('\n'), 'pnpm-workspace.yaml', '提示要指出该改哪个文件');

    // 不是这个错就别出声 —— 每条失败都塞一段猜测，等于把真正有用的那行淹掉。
    eq(hint('ERR_PNPM_META_FETCH_FAIL GET https://registry.npmjs.org/x: fetch failed'), null, '其他错误不该出提示');
    eq(hint('ERR_PNPM_IGNORED_BUILDS'), null, '只有错误码、没有包名列表时不该出提示');
    eq(hint(''), null, '空输出不该出提示');

    // 还有调用点：函数写得再好，安装失败的分支不调它也是死代码。
    assert(
      /if \(result\.code !== 0\) \{[\s\S]{0,700}?ignoredBuildHint\(result\.tail\.join\('\\n'\)\)/.test(
        readFileSync(join(TEMPLATE_ROOT, 'scripts/init.mjs'), 'utf8'),
      ),
      '安装失败的分支必须调用 ignoredBuildHint 并把提示发给用户',
    );
  });

  g.check('A13 初始化进度是独立整页，不再内嵌在选择页下方', async () => {
    // 为什么值得卡：把进度面板挪回选择页下方，页面照样渲染、一条报错都没有 ——
    // 只是「跑起来之后该看什么」又变回两处（选择页内嵌 + /setup/progress），
    // 而两处共用 useWizard 的同一份模块级状态，刷新后看到的东西不一样。
    // 这类回归静态看不出来，只能把结构钉死。
    const setup = readFileSync(join(TEMPLATE_ROOT, 'app/pages/setup/index.vue'), 'utf8');
    const progress = readFileSync(join(TEMPLATE_ROOT, 'app/pages/setup/progress.vue'), 'utf8');
    const panel = readFileSync(join(TEMPLATE_ROOT, 'app/components/wizard/ProgressStream.vue'), 'utf8');
    const actions = readFileSync(join(TEMPLATE_ROOT, 'app/components/wizard/ProgressActions.vue'), 'utf8');
    const composable = readFileSync(join(TEMPLATE_ROOT, 'app/utils/wizard/useWizard.ts'), 'utf8');

    // ① 选择页里不许再出现进度面板。判据锚定 `<ProgressStream` 这个开标签：
    //    裸词 ProgressStream 会命中注释（注释里正在解释这件事），和 <dialog> 那次是同一个坑。
    assert(!/<ProgressStream/.test(setup), '选择页不该再渲染进度面板');
    // import 单独锚定成整行。这里不能用裸词 ProgressStream —— 它会被注释命中
    // （本页的注释正在解释「进度不在这里」），而 `^import …ProgressStream.vue';$`
    // 只认真正的 import 行，注释怎么改都骗不过它。
    assert(!/^import .*ProgressStream\.vue';$/m.test(setup), '选择页不该再 import 进度面板');
    assert(/<ProgressStream/.test(progress), '进度面板现在只由进度页渲染');

    // ② 点下「确认并开始初始化」要整页过去，而且必须**先起流再跳**：
    //    顺序反过来的话，进度页挂载时状态还是 planned，会被它自己的兜底判成
    //    「没有初始化在跑」弹回选择页 —— 用户看到的是点完按钮原地不动。
    const started = setup.indexOf('void wizard.start();');
    assert(started > 0, '确认按钮必须调用 start()');
    assert(
      setup.indexOf("navigateTo('/setup/progress')", started) > started,
      '起流之后必须整页跳到进度页',
    );
    assert(
      !/await wizard\.start\(\)/.test(setup),
      '不能 await start()：那要等完整个初始化（几分钟）才跳转，进度页永远看不到实时进度',
    );

    // ③ 刷新 /setup 也要能分流过去，否则「跑到一半刷新」会停在一个看似无人操作的选择页。
    assert(
      /onMounted\([\s\S]{0,400}?shouldShowProgress\.value[\s\S]{0,160}?navigateTo\('\/setup\/progress'\)/.test(setup),
      '选择页的挂载钩子必须在发现已有初始化时整页跳到进度页',
    );

    // ④ 分流判据必须要求**进程存活**。只看「锁存在」的话，失败后残留的锁会让选择页
    //    每次打开都把人甩去进度页，而进度页的「返回并重试」又把人送回来 ——
    //    两页来回弹，谁也到不了能操作的地方。判据的不对称是刻意的：
    //    选择页送过去的情形，进度页一定接得住。
    assert(
      /state\.remote\?\.locked\s*&&\s*state\.remote\?\.processAlive/.test(setup),
      '选择页的分流判据必须要求进程仍存活（残锁要留在进度页看失败原因）',
    );
    assert(
      /if \(!hasRun\.value\) await navigateTo\('\/setup'\)/.test(progress),
      '进度页在「确实没有初始化在跑」时必须回选择页',
    );
    // 判据本身跨两行，所以用 [\s\S] 抓到第一个 `);` 为止
    const hasRunDecl = /const hasRun = computed\(\(\) =>[\s\S]{0,300}?\);/.exec(progress)?.[0] ?? '';
    assert(hasRunDecl.includes('locked'), '进度页的判据必须认得锁文件');
    assert(
      !hasRunDecl.includes('processAlive'),
      '进度页的判据不能要求进程存活 —— 残锁（进程已退出）正是最需要看失败原因的时候',
    );
    // 但必须认得「本页正开着进度流」：点下确认是**先起流、再整页过来**，
    // 引擎要过一会儿才写出锁文件。少这一条，进度页会在这段窗口里把自己判成
    // 「没有初始化在跑」弹回选择页 —— 用户看到的是点完按钮闪一下又回来。
    // 这个窗口靠读代码看不出来（流与锁都「应该有」），是 CDP 实跑抓出来的。
    assert(
      hasRunDecl.includes("state.mode === 'stream'"),
      '进度页的判据必须认得流态（引擎写出锁文件之前的那段窗口）',
    );

    // ⑤ 竞态：进度页挂载时会读一次 /api/wizard/status，而那一刻引擎往往刚被拉起、锁还没写出来。
    //    轮询结论不许覆盖「本页正连着进度流」时的 running —— 否则刚点完按钮，
    //    页面显示成「什么都没在跑」。
    assert(
      /if \(payload\.initialized\)[\s\S]{0,900}?state\.mode !== 'stream'[\s\S]{0,700}?state\.status = 'selecting'/
        .test(composable),
      '本页正连着进度流时，refreshStatus 不许把 running 打回 selecting',
    );

    // ⑥ 操作条必须待在吸附区，不能跟着日志滚。日志区是 320px 定高、失败时动辄几百行，
    //    混在面板里的「中断进度流」按钮会被顶出屏幕 —— 而那正是它最该被按到的时候。
    assert(!/class="wizard__footer"/.test(panel), '进度面板里不该再有操作条');
    assert(/class="wizard__footer"/.test(actions), '操作条应在 ProgressActions 里');
    assert(/class="wizard__dock"/.test(progress), '进度页必须有底部吸附区（外壳 + 滚动区 + 吸附区三层）');

    // ⑦ 操作条要拿到状态与退出码、三个事件都要接上 —— 少一个按钮就是「点了没反应」，
    //    而按钮存在与否由 status 决定，接不上时页面不会报任何错。
    const actionsTag = /<ProgressActions[\s\S]{0,500}?\/>/.exec(progress)?.[0] ?? '';
    assert(actionsTag !== '', '进度页必须渲染操作条');
    hasAll(actionsTag, [':status=', ':exit-code=', '@detach=', '@retry=', '@refresh='], '操作条的入参与事件');

    // ⑧ 新组件必须登记进删除白名单：漏了它，初始化之后这个文件会留在产物里。
    assert(
      WIZARD_FILES.includes('app/components/wizard/ProgressActions.vue'),
      '白名单要收录新组件，否则初始化后残留',
    );

    // ⑨ 令牌注入必须覆盖进度页。它是一整页，会被刷新、被收藏、在另一个标签页里打开，
    //    而令牌只随 HTML 下发 —— 不在白名单里，整页加载就只剩一串 403，
    //    「刷新也能看到进度」这条承诺当场失效。
    //    这个缺口「从选择页点过去」永远碰不到（客户端跳转时令牌已经在 window 上），
    //    是 CDP 那条「直接敲 URL」的用例抓出来的，必须钉住。
    const tokenPlugin = readFileSync(join(TEMPLATE_ROOT, 'server/plugins/wizard-token.ts'), 'utf8');
    const tokenPaths = /WIZARD_PATHS = new Set\(\[([^\]]*)\]\)/.exec(tokenPlugin)?.[1] ?? '';
    assert(tokenPaths !== '', '找不到令牌注入的路径白名单（变量被改名了？）');
    includes(tokenPaths, "'/setup/progress'", '令牌注入的路径白名单要含进度页');
  });
}

/* ================================================================== *
 * B 计划正确性
 * ================================================================== */

{
  const g = group('B', '计划正确性');

  g.check('B1 每个 UI 选项的依赖与模块与声明一致', async () => {
    for (const item of BY_KEY.get('ui').options) {
      // 实验性选项会被阻断规则拦住（`vuetify-experimental`），
      // 这里要验的是「声明与计划一致」，不是「能不能选」，所以显式放行。
      const ctx = ctxOf({ ui: item.value }, { forceExperimental: true });
      hasAll(ctx.plan.deps, item.deps ?? [], `ui=${item.value} 的 deps`);
      hasAll(ctx.plan.devDeps, (item.devDeps ?? []).filter((d) => !(item.deps ?? []).includes(d)), `ui=${item.value} 的 devDeps`);
      hasAll(ctx.plan.modules, item.modules ?? [], `ui=${item.value} 的 modules`);
    }
  });

  g.check('B2 每个预处理器的生成文件与样式入口', async () => {
    for (const item of BY_KEY.get('preprocessor').options) {
      const ctx = ctxOf({ preprocessor: item.value });
      hasAll(ctx.plan.generatedFiles, item.files ?? [], `preprocessor=${item.value} 的生成文件`);
      for (const entry of item.css ?? []) {
        assert(ctx.plan.cssEntries.includes(entry.path), `preprocessor=${item.value} 缺少样式入口 ${entry.path}`);
      }
    }
  });

  g.check('B3 原子化框架：UnoCSS 与 Tailwind 都进 CSS 首位', async () => {
    for (const value of ['unocss', 'tailwind']) {
      const ctx = ctxOf({ atomic: value });
      eq(ctx.plan.cssEntries[0], value === 'unocss' ? 'virtual:uno.css' : '~/assets/styles/tailwind.css', `${value} 的首位样式`);
    }
    // Tailwind 还要往 vite 区间注入插件 import
    const ctx = ctxOf({ atomic: 'tailwind' });
    includes(ctx.sections['nuxt.config.ts'].IMPORTS, "import tailwindcss from '@tailwindcss/vite'", 'Tailwind 的 vite import');
    includes(ctx.sections['nuxt.config.ts'].VITE, 'tailwindcss()', 'Tailwind 的 vite 插件');
  });

  g.check('B4 四种渲染模式各自产出可跑的配置', async () => {
    const expected = {
      ssr: 'ssr: true,',
      spa: 'ssr: false,',
      ssg: "nitro: { preset: 'static' }",
      hybrid: 'routeRules: {',
    };
    for (const [value, needle] of Object.entries(expected)) {
      const ctx = ctxOf({ render: value });
      includes(ctx.sections['nuxt.config.ts'].RENDER, needle, `render=${value} 的 RENDER 区间`);
    }
  });

  g.check('B5 样式入口顺序：原子化 base → tokens → base.css → UI', async () => {
    const ctx = ctxOf({ ui: 'element-plus', atomic: 'unocss', preprocessor: 'sass' });
    eq(ctx.plan.cssEntries, [
      'virtual:uno.css',
      '~/assets/styles/tokens.scss',
      '~/assets/styles/base.css',
      'element-plus/dist/index.css',
    ], '槽位顺序');
  });

  g.check('B6 多选组去重且按声明顺序稳定', async () => {
    const order = BY_KEY.get('modules').options.map((o) => o.value);
    const a = ctxOf({ modules: ['seo', 'pinia', 'icon'] });
    const b = ctxOf({ modules: ['icon', 'seo', 'pinia'] });
    eq(a.plan.modules, b.plan.modules, '输入顺序不同但模块数组相同');
    // 模块数组是**跨组合并**的：`modules` 组之外，engineering 组也会带模块
    // （默认开启的 eslint → @nuxt/eslint）。所以这里的期望值必须把两组都算进来。
    const fromEngineering = BY_KEY.get('engineering').options
      .filter((o) => (DEFAULTS.engineering ?? []).includes(o.value))
      .flatMap((o) => o.modules ?? []);
    eq(a.plan.modules, ['@pinia/nuxt', '@nuxt/icon', '@nuxtjs/seo', ...fromEngineering], '模块数组');
    // 依赖去重排序：pinia 与 @pinia/nuxt 都由 pinia 选项提供，不能重复
    eq(a.plan.deps.filter((d) => d === 'pinia').length, 1, 'pinia 只出现一次');
    assert(order.length === 6, 'modules 组应有 6 个候选');
  });

  g.check('B7 工程开关决定生成的脚本', async () => {
    const withAll = ctxOf({ engineering: ['eslint', 'test', 'ts-strict'], preprocessor: 'sass' });
    const scripts = withAll.sections['package.json'].SCRIPTS;
    for (const needle of ['"lint"', '"lint:fix"', '"lint:style"', '"test"', '"test:watch"', '"typecheck"']) {
      includes(scripts, needle, '工程开关全开的脚本');
    }
    const minimal = ctxOf({ engineering: [], preprocessor: 'stylus' });
    eq(minimal.sections['package.json'].SCRIPTS, '', '什么都不选时不该有脚本');
    // Stylus 故意不给 lint:style —— Stylelint 对它支持有限，生成了就是一堆误报
    includes(ctxOf({ engineering: [], preprocessor: 'stylus' }).sections['package.json'].SCRIPTS, '', 'Stylus 无样式检查');
  });

  g.check('B8 删除清单 = 引导器白名单 ∪ 过期生成文件，逐条枚举', async () => {
    const ctx = ctxOf({ ui: 'nuxt-ui', preprocessor: 'sass', atomic: 'tailwind' });
    hasAll(ctx.plan.deleteFiles, WIZARD_FILES, '删除清单应包含全部引导器文件');

    // 「过期生成文件」= 所有候选生成文件的并集 − 本次真正生成的。
    // 注意 stylelint.config.mjs 归 sass 与 less **共用**，
    // 所以选了 sass 时它应当被保留 —— 这类跨方案共用的文件最容易被写反。
    const allGenerated = new Set(
      OPTIONS.groups.flatMap((grp) => grp.options).flatMap((opt) => opt.files ?? []),
    );
    const shouldSurvive = new Set(ctx.plan.generatedFiles);
    const expectedStale = [...allGenerated].filter((rel) => !shouldSurvive.has(rel)).sort();
    eq(
      ctx.plan.deleteFiles.filter((rel) => allGenerated.has(rel)).sort(),
      expectedStale,
      '过期生成文件应恰好等于「所有候选生成文件 − 本次生成的」',
    );
    assert(ctx.plan.deleteFiles.includes('app/assets/styles/tokens.less'), 'less 的产物该被清掉');
    assert(ctx.plan.deleteFiles.includes('app/assets/styles/tokens.styl'), 'stylus 的产物该被清掉');
    assert(!ctx.plan.deleteFiles.includes('stylelint.config.mjs'), 'sass 与 less 共用 stylelint 配置，选了 sass 就该保留它');

    const wildcards = ctx.plan.deleteFiles.filter((rel) => /[*?]/.test(rel));
    eq(wildcards, [], '删除清单里不该有通配符');
    eq(ctx.plan.deleteFiles, [...new Set(ctx.plan.deleteFiles)].sort(), '删除清单应去重升序');
  });

  g.check('B9 allowBuilds：闭包里有安装脚本的包必须列全、取值明确', async () => {
    const plain = ctxOf({});
    const text = plain.sections['pnpm-workspace.yaml'].ALLOW_BUILDS;

    // 这三个是对一棵**装全 5224 个包**的树逐份读 package.json 扫出来的结果 ——
    // 整个闭包里带 preinstall/install/postinstall 的只有它们。少列任何一个，
    // pnpm 11（strictDepBuilds 默认真）都会以 ERR_PNPM_IGNORED_BUILDS 退出，
    // 整个安装走不到头，而那条错误原文完全不提「你该往哪写一行」。
    hasAll(text, [
      "'@parcel/watcher': false",
      'esbuild: false',
      'unrs-resolver: false',
    ], '恒定的允许清单');

    // 作用域包名以 @ 开头，YAML 里裸写会被解析器拒绝。判据锚在「行首缩进 + @ + 冒号」
    // 这个形态上 —— 不是随便找个 @ 子串（注释里就写着 @parcel/watcher）。
    eq(
      text.split('\n').filter((line) => /^\s+@[^\s:]+:/.test(line)),
      [],
      '作用域包名必须加引号（裸写会被 YAML 解析器拒绝）',
    );

    assert(!plain.plan.allowBuilds.includes('sharp'), '未选 image 时不该出现 sharp');
    const image = ctxOf({ modules: ['image'] });
    const imageText = image.sections['pnpm-workspace.yaml'].ALLOW_BUILDS;
    includes(imageText, 'sharp: true', '选了 image 应追加 sharp');

    // 两份来源（模板固定清单 + 选项追加）合并后必须去重升序 —— 顺序不稳，
    // 每次初始化的 diff 都在抖。判据用**带 sharp 的那份**：只查上面那份的话，
    // 固定清单本来就是有序的，把 sort() 删掉也照样绿（变异测试证实过）。
    const entries = imageText.split('\n').slice(1).map((line) => line.trim());
    eq(entries, [...new Set(entries)].sort(), 'allowBuilds 条目应去重升序');

    // 模板仓库自己的 pnpm-workspace.yaml 必须与这份基线**逐字**一致。
    // 不一致的两种典型后果：①「模板自己能装、初始化后装不上」；
    // ② 把 pnpm 在本仓库安装失败时自动追加的 `set this to true or false` 占位行提交上去 ——
    //    占位值不是布尔，下次安装照样报错，属于「提交了一个看起来像配置的报错」。
    eq(
      readSection(
        readFileSync(join(TEMPLATE_ROOT, 'pnpm-workspace.yaml'), 'utf8'),
        markerBegin('pnpm-workspace.yaml', 'ALLOW_BUILDS'),
        markerEnd('pnpm-workspace.yaml', 'ALLOW_BUILDS'),
      ),
      text,
      '模板自带的 allowBuilds 区间应与渲染基线逐字一致'
      + '（pnpm 在本仓库安装时若发现闭包里有没列出的包，会往这里追加 `set this to true or false` 占位行）',
    );
  });

  g.check('B10 安装命令：pnpm 用 add，npm 用 install --save，devDeps 分两次', async () => {
    const pnpm = installSteps({ lockfile: 'pnpm', deps: ['a'], devDeps: ['b'] });
    eq(pnpm.map((s) => s.args.join(' ')), ['add a', 'add -D b', 'install'], 'pnpm 命令');
    const npm = installSteps({ lockfile: 'npm', deps: ['a'], devDeps: ['b'] });
    eq(npm.map((s) => s.args.join(' ')), ['install --save a', 'install --save-dev b', 'install'], 'npm 命令');
    eq(installSteps({ lockfile: 'pnpm', deps: [], devDeps: [] }), [], '没有额外依赖时不该有命令');
    eq(installCommands({ lockfile: 'npm', deps: ['a'], devDeps: [] }), ['npm install --save a', 'npm install'], '可粘贴命令');
  });

  g.check('B11 校验顺序：先断言形状，再归一化，再跑规则', async () => {
    // 形状非法必须抛错，而不是被默认值「洗白」
    const bad = [
      { ui: 'not-exist' },
      { ui: ['element-plus'] },
      { modules: 'pinia' },
      { modules: [123] },
      { unknownGroup: 'x' },
      null,
    ];
    for (const raw of bad) {
      let threw = false;
      try {
        assertShape(OPTIONS, raw);
      } catch {
        threw = true;
      }
      assert(threw, `非法输入应当被拒绝：${JSON.stringify(raw)}`);
    }
    // 归一化只补默认值，不碰非法值
    eq(normalizeSelection(OPTIONS, {}), DEFAULTS, '默认选择');
  });

  g.check('B12 describeSelection 可读且覆盖所有分组', async () => {
    const text = describeSelection(OPTIONS, DEFAULTS);
    for (const key of BY_KEY.keys()) includes(text, `${key}=`, `签名里的 ${key}`);
  });
}

/* ================================================================== *
 * C 幂等
 * ================================================================== */

{
  const g = group('C', '幂等');

  g.check('C1 同一选择的两次 dry-run 输出逐字节相同', async () => {
    const a = ctxOf({ ui: 'element-plus', atomic: 'tailwind', preprocessor: 'sass' });
    const b = ctxOf({ ui: 'element-plus', atomic: 'tailwind', preprocessor: 'sass' });
    eq(JSON.stringify(a.sections), JSON.stringify(b.sections), '两次渲染的区间内容');
    eq(a.plan.deleteFiles, b.plan.deleteFiles, '两次算出的删除清单');
  });

  g.check('C2 真跑一次后 --check 返回 0', async () => {
    const dir = freshRepo('c2');
    const { code, out } = await initRepo(dir, { ui: 'element-plus', preprocessor: 'sass', atomic: 'unocss', render: 'hybrid' });
    eq(code, 0, `初始化退出码（${out.text('error')}）`);
    eq(await engineCli(['--root', dir, '--check'], { out: capturingEmitter() }), 0, '--check 退出码');
  });

  g.check('C3 连跑两次 --check 仍为 0（缩进累加类问题只有连跑才暴露）', async () => {
    const dir = freshRepo('c3');
    await initRepo(dir, { ui: 'nuxt-ui', atomic: 'tailwind', preprocessor: 'less' });
    for (const round of [1, 2, 3]) {
      const out = capturingEmitter();
      eq(await engineCli(['--root', dir, '--check'], { out }), 0, `第 ${round} 次 --check（${out.text('drift')}）`);
    }
  });

  g.check('C4 产物里的区间缩进与 marker 行对齐（package.json 是 4 格）', async () => {
    const dir = freshRepo('c4');
    await initRepo(dir, { engineering: ['eslint', 'test'] });
    const text = readText(dir, 'package.json');
    const b = markerBegin('package.json', 'SCRIPTS');
    const e = markerEnd('package.json', 'SCRIPTS');
    const body = readSection(text, b, e);
    assert(body !== null, 'SCRIPTS 区间读不出来');
    const lines = text.split('\n');
    const beginLine = lines.find((line) => line.includes(b));
    const bodyLine = lines.find((line) => line.includes('"lint"'));
    eq(/^\s*/.exec(bodyLine)[0], /^\s*/.exec(beginLine)[0], '正文与 marker 的缩进');
    eq(readSection(text, b, e), body, 'readSection 应幂等');
    // JSON 必须仍然合法（文本替换 JSON 的安全网）
    JSON.parse(text);
  });

  g.check('C5 从快照重放（--template-config）后仍然一致', async () => {
    const dir = freshRepo('c5');
    await initRepo(dir, { ui: 'element-plus', preprocessor: 'sass', atomic: 'none', render: 'spa' });
    // 快照在 .init-backup 里，取最近一份；重放不读 options.json，只依赖快照自足
    const code = await engineCli(['--root', dir, '--template-config', 'template.config.json', '--skip-install', '--fast'], {
      out: capturingEmitter(),
    });
    eq(code, 0, '重放退出码');
    eq(await engineCli(['--root', dir, '--check'], { out: capturingEmitter() }), 0, '重放后的 --check');
  });

  g.check('C6 回滚后仓库与初始化前逐字节相同', async () => {
    const dir = freshRepo('c6');
    const before = readText(dir, 'nuxt.config.ts');
    const beforePkg = readText(dir, 'package.json');
    await initRepo(dir, { ui: 'nuxt-ui', atomic: 'tailwind', preprocessor: 'sass', engineering: ['docker', 'test'] });
    eq(await engineCli(['--root', dir, '--rollback'], { out: capturingEmitter() }), 0, '回滚退出码');
    eq(readText(dir, 'nuxt.config.ts'), before, '回滚后的 nuxt.config.ts');
    eq(readText(dir, 'package.json'), beforePkg, '回滚后的 package.json');
    assert(!exists(dir, 'template.config.json'), '回滚应删掉小票');
    assert(!exists(dir, engineInternals.LOCK_FILE), '回滚应清掉锁');
    assert(exists(dir, WIZARD_FILES[0]), '回滚应恢复引导器文件');
    assert(!exists(dir, 'app/stores'), '回滚应清掉空目录 app/stores');
    assert(!exists(dir, 'deploy'), '回滚应清掉空目录 deploy');
  });
}

/* ================================================================== *
 * D 手写区保护
 * ================================================================== */

{
  const g = group('D', '手写区保护');

  const HANDWRITTEN_ANCHORS = ['defineNuxtConfig(', 'compatibilityDate', 'app: {', 'head: {'];

  g.check('D1 完整初始化后手写区锚点仍在', async () => {
    const dir = freshRepo('d1');
    await initRepo(dir, { ui: 'nuxt-ui', atomic: 'tailwind', preprocessor: 'sass', render: 'hybrid', modules: ['i18n', 'seo'] });
    const text = readText(dir, 'nuxt.config.ts');
    const blanked = blankSections(text, 'nuxt.config.ts');
    for (const anchor of HANDWRITTEN_ANCHORS) includes(blanked, anchor, '手写区锚点');
  });

  g.check('D2 手写区与初始化前逐字节相同', async () => {
    const dir = freshRepo('d2');
    const before = blankSections(readText(dir, 'nuxt.config.ts'), 'nuxt.config.ts');
    await initRepo(dir, { ui: 'vuetify', preprocessor: 'stylus', render: 'ssg', extra: true });
    const after = blankSections(readText(dir, 'nuxt.config.ts'), 'nuxt.config.ts');
    eq(after, before, '抹掉区间后的手写区');
  });

  g.check('D3 变异：往手写区插一行 → 第 9 项断言报红', async () => {
    const dir = freshRepo('d3');
    await initRepo(dir, { ui: 'none' });
    // 只改手写区（区间之外）。这是「真的动了手写区」，断言必须报出来 ——
    // 与它相对的另一面是 D5：改动落在 marker 区间里时，第 9 项**不该**被牵连
    const text = readText(dir, 'nuxt.config.ts');
    const patched = text.replace('  devtools: { enabled: true },', '  devtools: { enabled: true },\n  // 手工插入的一行');
    assert(patched !== text, '变异没生效（找不到插入点）');
    writeText(dir, 'nuxt.config.ts', patched);

    const { out, promise } = verifyRepo(dir);
    eq(await promise, 1, 'verify 退出码');
    includes(out.text(), 'FAIL  9', '第 9 项应报红');
  });

  g.check('D4 变异：手写区哈希与记录不一致 → 快照缺失时仍能报出来', async () => {
    const dir = freshRepo('d4');
    await initRepo(dir, { ui: 'none' });
    // 把快照里的 nuxt.config.ts 挪开，让第 9 项退回「哈希兜底」那条路径。
    // 这里只 unlink 单个文件 —— 受限环境下删目录会挂住，删文件是安全的
    for (const stamp of readdirSync(join(dir, engineInternals.BACKUP_DIR))) {
      const snapshotFile = join(dir, engineInternals.BACKUP_DIR, stamp, 'nuxt.config.ts');
      if (existsSync(snapshotFile)) unlinkSync(snapshotFile);
    }
    const text = readText(dir, 'nuxt.config.ts');
    writeText(dir, 'nuxt.config.ts', text.replace('devtools: { enabled: true }', 'devtools: { enabled: false }'));

    const { out, promise } = verifyRepo(dir);
    eq(await promise, 1, 'verify 退出码');
    includes(out.text(), 'FAIL  9', '第 9 项应报红');
    includes(out.text(), '哈希', '应走哈希兜底那条路径');
    // 失败项必须**只有**第 9 项：否则「退出码是 1」可能来自别处，
    // 第 9 项到底红没红就没被验到（这条断言原先就是这么蒙过去的）
    const failedIds = [...out.text().matchAll(/FAIL\s+(\d+)/g)].map((match) => match[1]);
    eq(failedIds, ['9'], '失败项应只有第 9 项');
  });

  g.check('D5 改 marker 区间内容不触发第 9 项，而触发第 6 项', async () => {
    const dir = freshRepo('d5');
    await initRepo(dir, { ui: 'none' });
    const text = readText(dir, 'nuxt.config.ts');
    const patched = text.replace('  ssr: true,', '  ssr: false,');
    assert(patched !== text, '变异没生效');
    writeText(dir, 'nuxt.config.ts', patched);

    const { out, promise } = verifyRepo(dir);
    eq(await promise, 1, 'verify 退出码');
    includes(out.text(), 'FAIL  6', '第 6 项应报红');
    includes(out.text(), 'PASS  9', '第 9 项不该被牵连（手写区确实没动）');
  });
}

/* ================================================================== *
 * E marker 与缩进
 * ================================================================== */

{
  const g = group('E', 'marker 与缩进');

  const SAMPLE = [
    'export default {',
    '  // >>> TEMPLATE:X',
    '  // <<< TEMPLATE:X',
    '  tail: true,',
    '}',
    '',
  ].join('\n');

  g.check('E1 缺 marker 报错且指出缺哪一个', async () => {
    for (const [text, expected] of [[SAMPLE.replace('// <<< TEMPLATE:X', ''), 'end=缺失'], [SAMPLE.replace('// >>> TEMPLATE:X', ''), 'begin=缺失']]) {
      let message = '';
      try {
        rewriteSection(text, '// >>> TEMPLATE:X', '// <<< TEMPLATE:X', 'body');
      } catch (err) {
        message = err.message;
      }
      includes(message, expected, '缺 marker 的报错');
    }
  });

  g.check('E2 同名 marker 出现两次 → 拒绝而不是猜', async () => {
    const text = SAMPLE.replace('  tail: true,', '  // >>> TEMPLATE:X');
    let message = '';
    try {
      rewriteSection(text, '// >>> TEMPLATE:X', '// <<< TEMPLATE:X', 'body');
    } catch (err) {
      message = err.message;
    }
    includes(message, '出现多次', '重复 marker 的报错');
  });

  g.check('E3 marker 顺序颠倒 → 拒绝', async () => {
    const text = ['// <<< TEMPLATE:X', '// >>> TEMPLATE:X', ''].join('\n');
    let message = '';
    try {
      rewriteSection(text, '// >>> TEMPLATE:X', '// <<< TEMPLATE:X', 'body');
    } catch (err) {
      message = err.message;
    }
    includes(message, '顺序颠倒', '顺序颠倒的报错');
  });

  g.check('E4 连续改写两次结果逐字节相同（幂等）', async () => {
    const once = rewriteSection(SAMPLE, '// >>> TEMPLATE:X', '// <<< TEMPLATE:X', 'a: 1,\nb: 2,');
    const twice = rewriteSection(once, '// >>> TEMPLATE:X', '// <<< TEMPLATE:X', 'a: 1,\nb: 2,');
    eq(twice, once, '第二次改写');
    eq(readSection(twice, '// >>> TEMPLATE:X', '// <<< TEMPLATE:X'), 'a: 1,\nb: 2,', '读回的正文');
  });

  g.check('E5 正文缩进取自 marker 行（三种文件各验一次）', async () => {
    const cases = [
      { file: 'nuxt.config.ts', sample: 'defineNuxtConfig({\n  // >>> TEMPLATE:X\n  // <<< TEMPLATE:X\n})\n', indent: '  ' },
      { file: 'package.json', sample: '{\n  "scripts": {\n    "// >>> TEMPLATE:X": "",\n    "// <<< TEMPLATE:X": ""\n  }\n}\n', indent: '    ' },
      { file: 'pnpm-workspace.yaml', sample: '# >>> TEMPLATE:X\n# <<< TEMPLATE:X\n', indent: '' },
    ];
    for (const { file, sample, indent } of cases) {
      const b = markerBegin(file, 'X');
      const e = markerEnd(file, 'X');
      const out = rewriteSection(sample, b, e, 'aaa\nbbb');
      includes(out, `${indent}aaa`, `${file} 的正文缩进`);
      eq(readSection(out, b, e), 'aaa\nbbb', `${file} 的读写互逆`);
    }
  });

  g.check('E6 变异：正文缩进写死成 2 格 → 读回的内容与写入的不一致', async () => {
    // 这是真实踩过的坑：package.json 的 marker 在 4 格处，正文却按 2 格写。
    // JSON 不在乎空白、构建照跑，只有逐字节比对能发现 —— 所以这条变异必须有红灯。
    const sample = '{\n  "scripts": {\n    "// >>> TEMPLATE:X": "",\n    "// <<< TEMPLATE:X": ""\n  }\n}\n';
    const b = markerBegin('package.json', 'X');
    const e = markerEnd('package.json', 'X');
    const good = rewriteSection(sample, b, e, '"lint": "eslint .",');
    eq(readSection(good, b, e), '"lint": "eslint .",', '正确实现的读写互逆');

    // 坏实现：缩进写死 2 格
    const bIndex = sample.indexOf(b);
    const eIndex = sample.indexOf(e);
    const broken = `${sample.slice(0, bIndex)}${b}\n  ${'"lint": "eslint .",'}\n${sample.slice(eIndex)}`;
    assert(
      readSection(broken, b, e) !== '"lint": "eslint .",',
      '缩进写死 2 格时读回的正文应当与写入的不一致（这条断言没红说明它拦不住回归）',
    );
  });

  g.check('E7 空正文 → marker 相邻，不留空行', async () => {
    const out = rewriteSection(SAMPLE, '// >>> TEMPLATE:X', '// <<< TEMPLATE:X', '');
    includes(out, '  // >>> TEMPLATE:X\n  // <<< TEMPLATE:X', '空区间的形态');
    eq(readSection(out, '// >>> TEMPLATE:X', '// <<< TEMPLATE:X'), '', '空区间的读回值');
  });

  g.check('E8 countMarker 与 blankSections', async () => {
    eq(countMarker(SAMPLE, '// >>> TEMPLATE:X'), 1, 'countMarker 计数');
    eq(countMarker(SAMPLE, '// >>> TEMPLATE:Y'), 0, '不存在的 marker');

    // blankSections 与上面几个函数的接口不同：它是按 FILE_SECTION_KEYS 枚举区间的，
    // **只认真实的区间键**。所以这里不能复用 SAMPLE 的假键 X ——
    // 那样写会得到「什么都没抹」的结果，而它与「抹对了」长得一样（区间本来就是空的），
    // 是一条假绿断言：原先它断言「marker 被抹掉」而失败，正好把这个缺陷盖住了。
    const begin = markerBegin('nuxt.config.ts', 'MODULES');
    const end = markerEnd('nuxt.config.ts', 'MODULES');
    const REAL = [
      'export default defineNuxtConfig({',
      `  ${begin}`,
      `  ${end}`,
      '  devtools: { enabled: true },',
      '})',
      '',
    ].join('\n');

    // 语义（见 sections.mjs 的注释）：抹掉区间占用的**整行，连 marker 一起删**。
    // 用途只有一个 —— 判断「手写区是否与初始化前一模一样」：
    // 两侧做同一套抹除后剩下的文本逐字节相同 ⟺ 区间之外没人动过。
    // 所以它**不能**保留 marker 行（marker 行属于「本来就该变」的部分）。
    const filled = rewriteSection(REAL, begin, end, "modules: ['@nuxt/icon'],");
    assert(filled.includes('@nuxt/icon'), '变异没生效：内容没写进区间');

    const blanked = blankSections(filled, 'nuxt.config.ts');
    eq(blanked, blankSections(REAL, 'nuxt.config.ts'), '两侧抹除后应逐字节相同（这正是第 9 项的判据）');
    assert(!blanked.includes('@nuxt/icon'), '区间内容应被抹掉');
    assert(!blanked.includes(begin) && !blanked.includes(end), 'marker 行随区间一起抹掉');
    includes(blanked, 'devtools: { enabled: true },', '区间之外的手写行不该被动');
    includes(blanked, 'export default defineNuxtConfig({', '文件首行不该被动');

    // 区间被手工删干净（两个 marker 都不在）时，抹除应当是恒等变换 ——
    // 否则「有人删了整个区间」会和「干净的仓库」看起来一样。
    eq(blankSections(blanked, 'nuxt.config.ts'), blanked, '已抹过的文本再抹一次应不变');
  });

  g.check('E9 占位符：未声明即报错，不静默留空', async () => {
    const { text, missing } = renderTemplate('a={{x}} b={{ y }} c={{z}}', { x: '1', y: '2' });
    eq(missing, ['z'], '未声明的占位符');
    includes(text, 'a=1', '已声明的占位符应被替换');
    includes(text, 'c={{z}}', '未声明的不该被替换成空串');
    eq(renderTemplate('plain', {}).missing, [], '没有占位符时不该报缺');
  });

  g.check('E10 生成区不允许 .vue（与 Vue 插值语法撞车）', async () => {
    let message = '';
    try {
      assertRenderableTemplate('app/components/Foo.vue');
    } catch (err) {
      message = err.message;
    }
    includes(message, '不允许使用 .vue', '拒绝 .vue 的报错');
    assertRenderableTemplate('app/stores/app.ts');
    // baseline 里的 .vue 走原样复制，不受这条限制
    assert(blankSections('', 'nuxt.config.ts') === '', 'blankSections 空文本');
  });

  g.check('E11 三个文件的区间键与 marker 语法一一对应', async () => {
    const files = Object.keys(FILE_SECTION_KEYS);
    eq(files.sort(), ['nuxt.config.ts', 'package.json', 'pnpm-workspace.yaml'], '被改写的文件清单');
    for (const file of files) {
      for (const key of FILE_SECTION_KEYS[file]) {
        const begin = markerBegin(file, key);
        const end = markerEnd(file, key);
        assert(begin !== end, `${file} ${key} 的首尾 marker 不该相同`);
        includes(end, key, `${file} ${key} 的结束 marker 应含键名`);
      }
    }
    eq(countMarker(markerBegin('package.json', 'X'), 'X'), 1, 'JSON marker 里的键名');
  });

  g.check('E12 行尾透明：CRLF 检出上不产生混合行尾，读回的正文与 LF 基线可比', async () => {
    // 这条是补一个真实故障：仓库在 Windows 上检出（`core.autocrlf=true`）时
    // pnpm-workspace.yaml 是 CRLF，而 B9 拿它与 LF 渲染基线逐字比 ——
    // 于是 B9 在任何 Windows 检出上都是红的，两边打印出来还一模一样，差别全在不可见的 \r。
    //
    // 所以样本两种行尾都**自己造**，不依赖本机是怎么检出的：一旦依赖工作区文件，
    // 这条门禁就会在 LF 机器上天然变绿，等于没测。
    const b = markerBegin('pnpm-workspace.yaml', 'ALLOW_BUILDS');
    const e = markerEnd('pnpm-workspace.yaml', 'ALLOW_BUILDS');
    const lines = ['# 说明', b, e, 'tail: true', ''];
    const lfSample = lines.join('\n');
    const crlfSample = lines.join('\r\n');
    const body = 'allowBuilds:\n  esbuild: false';

    eq(detectEol(lfSample), '\n', 'detectEol 认 LF');
    eq(detectEol(crlfSample), '\r\n', 'detectEol 认 CRLF');

    // ① CRLF 文件改写后必须整份仍是 CRLF。判据：`\r\n` 的个数 == `\n` 的个数
    //    （每个 `\n` 都紧跟在 `\r` 后面）。有孤立 LF 时后者会多出来。
    const outCrlf = rewriteSection(crlfSample, b, e, body);
    eq(outCrlf.split('\n').length - 1, outCrlf.split('\r\n').length - 1,
      'CRLF 输入改写后不应出现孤立 LF（混合行尾会让 git diff 显示整段被改过）');
    includes(outCrlf, `allowBuilds:\r\n  esbuild: false`, '区间正文按文件自身的行尾写出');

    // ② 反向：LF 文件不许被写成 CRLF
    const outLf = rewriteSection(lfSample, b, e, body);
    eq(outLf.includes('\r'), false, 'LF 输入不应被写成 CRLF');

    // ③ 两种行尾读回来都必须是 LF —— 调用方要拿它与 renderSections 的基线逐字比
    eq(readSection(outCrlf, b, e), body, 'CRLF 文件里读回的正文（应归一化成 LF）');
    eq(readSection(outLf, b, e), body, 'LF 文件里读回的正文');

    // ④ 幂等：CRLF 文件连改两次逐字节相同
    eq(rewriteSection(outCrlf, b, e, body), outCrlf, 'CRLF 上连改两次应逐字节相同');

    // ⑤ B9 报红的那条判据本身：模板仓库的文件不论以哪种行尾检出，读回都等于渲染基线
    const plain = ctxOf({});
    eq(
      readSection(readFileSync(join(TEMPLATE_ROOT, 'pnpm-workspace.yaml'), 'utf8'), b, e),
      plain.sections['pnpm-workspace.yaml'].ALLOW_BUILDS,
      '模板文件的区间读回来必须与渲染基线一致（与检出时的行尾无关）',
    );
  });
}

/* ================================================================== *
 * F 门禁行为
 * ================================================================== */

{
  const g = group('F', '门禁行为');

  g.check('F1 干净仓库 --check 返回 0', async () => {
    const dir = freshRepo('f1');
    await initRepo(dir, { ui: 'element-plus' });
    eq(await engineCli(['--root', dir, '--check'], { out: capturingEmitter() }), 0, '--check');
  });

  g.check('F2 已安装的仓库里删掉一个依赖 → --check 报红并点名', async () => {
    const dir = freshRepo('f2');
    await initRepo(dir, { ui: 'element-plus' });
    simulateInstalled(dir);
    // 先确认「模拟安装」这一步本身让 --check 通过，否则下面那条报红说明不了任何问题
    eq(await engineCli(['--root', dir, '--check'], { out: capturingEmitter() }), 0, '模拟安装后应是干净的');

    const pkg = JSON.parse(readText(dir, 'package.json'));
    delete pkg.dependencies['element-plus'];
    writeText(dir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`);

    const out = capturingEmitter();
    eq(await engineCli(['--root', dir, '--check'], { out }), 1, '--check 退出码');
    includes(out.text('drift'), 'element-plus', '漂移项应点名缺失的包');
  });

  g.check('F3 改一个 marker 区间 → --check 报红', async () => {
    const dir = freshRepo('f3');
    await initRepo(dir, { render: 'ssr' });
    writeText(dir, 'nuxt.config.ts', readText(dir, 'nuxt.config.ts').replace('  ssr: true,', '  ssr: false,'));
    const out = capturingEmitter();
    eq(await engineCli(['--root', dir, '--check'], { out }), 1, '--check 退出码');
    includes(out.text('drift'), 'TEMPLATE:RENDER', '漂移项应点名区间');
  });

  g.check('F4 已删除的文件又出现 → --check 报红', async () => {
    const dir = freshRepo('f4');
    await initRepo(dir, { ui: 'none' });
    writeText(dir, WIZARD_FILES[0], '<template><div /></template>\n');
    const out = capturingEmitter();
    eq(await engineCli(['--root', dir, '--check'], { out }), 1, '--check 退出码');
    const text = out.text('drift');
    assert(/引导器残留|又出现/.test(text), `漂移项应报出复活的文件：${text}`);
  });

  g.check('F5 锁文件存在 → --check 报红', async () => {
    const dir = freshRepo('f5');
    await initRepo(dir, { ui: 'none' });
    writeText(dir, engineInternals.LOCK_FILE, '{}\n');
    const out = capturingEmitter();
    eq(await engineCli(['--root', dir, '--check'], { out }), 1, '--check 退出码');
    includes(out.text('drift'), engineInternals.LOCK_FILE, '漂移项应点名锁文件');
  });

  g.check('F6 未初始化的仓库 --check 返回 1 且给出可行提示', async () => {
    const dir = freshRepo('f6');
    const out = capturingEmitter();
    eq(await engineCli(['--root', dir, '--check'], { out }), 1, '--check 退出码');
    includes(out.text(), '还没有初始化', '提示文案');
  });

  g.check('F7 verify：干净产物（跳过安装）→ 0 失败', async () => {
    const dir = freshRepo('f7');
    await initRepo(dir, { ui: 'element-plus', preprocessor: 'sass' });
    const { out, promise } = verifyRepo(dir, { skipInstall: true });
    eq(await promise, 0, `verify 退出码（${out.text('error')}）`);
    assert(!out.has('FAIL'), '不该有 FAIL');
    includes(out.text(), '引导器残留 0', '汇总行');
  });

  g.check('F8 verify：缺 template.config.json → 仅第 1 项失败，其余跳过', async () => {
    const dir = freshRepo('f8');
    const out = capturingEmitter();
    eq(await runVerify(dir, { fast: true, out }), 1, 'verify 退出码');
    includes(out.text(), 'FAIL  1', '第 1 项应报红');
    assert(!/FAIL\s+(?!1)\d/.test(out.text()), `其余项应当跳过而不是失败：${out.text()}`);
    includes(out.text(), '依赖第 1 项，已跳过', '跳过原因');
  });

  g.check('F9 verify：非法 JSON 的 template.config.json → 报红而不抛异常', async () => {
    const dir = freshRepo('f9');
    writeText(dir, engineInternals.CONFIG_FILE, '{ 这不是 JSON');
    const out = capturingEmitter();
    eq(await runVerify(dir, { fast: true, out }), 1, 'verify 退出码');
    includes(out.text(), 'JSON.parse 失败', '第 1 项的原因');
  });

  g.check('F10 校验器对残缺 config 不崩（缺 plan.picked）', async () => {
    const dir = freshRepo('f10');
    writeText(dir, engineInternals.CONFIG_FILE, `${JSON.stringify({
      schemaVersion: '1.0.0',
      selection: { ui: 'none' },
      plan: { deps: [], devDeps: [] },
    }, null, 2)}\n`);
    const out = capturingEmitter();
    eq(await runVerify(dir, { fast: true, out }), 1, 'verify 退出码');
    includes(out.text(), 'plan.picked 缺失', '第 2 项的原因');
    assert(!out.has('断言自身出错'), '不该有断言抛异常');
  });

  g.check('F11 门禁清单可读且七条齐全', async () => {
    const config = JSON.parse(readFileSync(join(TEMPLATE_ROOT, gatesInternals.GATES_FILE), 'utf8'));
    eq(config.gates.length, 7, '门禁条数');
    const ids = config.gates.map((gate) => gate.id);
    hasAll(ids, ['lint', 'typecheck', 'test', 'verify', 'drift', 'engine-selftest', 'matrix'], '门禁 id');
    // 每条门禁的字段都得齐 —— 缺 why 的话，后来的人只会看到一串命令
    const incomplete = config.gates.filter((gate) => !gate.cmd || !gate.why || !gate.owner || !gate.timeoutSec).map((gate) => gate.id);
    eq(incomplete, [], '字段不全的门禁');
    eq(new Set(ids).size, ids.length, '门禁 id 不该重复');
  });

  g.check('F12 前置条件判定：缺依赖记 BLOCKED 的依据', async () => {
    const dir = freshRepo('f12');
    includes(checkRequires(dir, ['node_modules']), '没装依赖', '缺 node_modules');
    includes(checkRequires(dir, ['template.config.json']), '还没初始化', '缺小票');
    includes(checkRequires(dir, ['script:lint']), '没有 lint 脚本', '模板仓库里没有 lint 脚本');
    eq(checkRequires(dir, []), null, '无前置条件应通过');
    includes(checkRequires(dir, ['莫名其妙']), '未知的前置条件', '未知条件要报出来而不是静默放过');
  });

  g.check('F13 命令解析拒绝 shell 元字符', async () => {
    eq(parseCommand('node scripts/verify.mjs'), ['node', 'scripts/verify.mjs'], '普通命令');
    for (const bad of ['pnpm lint && echo ok', 'pnpm test | tee log', 'echo $(whoami)', 'a; b']) {
      let threw = false;
      try {
        parseCommand(bad);
      } catch {
        threw = true;
      }
      assert(threw, `应当拒绝：${bad}`);
    }
  });

  g.check('F14 文档一致性判定：命中 PASS、缺失 FAIL、目录不存在 BLOCKED', async () => {
    // 三种判定都用沙箱里的样本验，不依赖外部仓库 —— F15 那条要读真实文档目录，
    // 换台机器就可能 BLOCKED，那时就没人替「命令改了文档没改」把关了。
    const dir = freshRepo('f14');
    const docs = join(dir, 'docs-samples');
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'a.md'), '# 样例\n\n跑 `node scripts/foo.mjs` 即可。\n', 'utf8');
    writeFileSync(join(docs, 'b.md'), '# 另一篇\n\n没有命令。\n', 'utf8');

    const results = gatesInternals.checkDocs(dir, {
      docsDir: 'docs-samples',
      gates: [
        { id: 'hit', cmd: 'node scripts/foo.mjs', doc: true },
        { id: 'miss', cmd: 'node scripts/nope.mjs', doc: true },
        { id: 'ignored', cmd: 'node scripts/foo.mjs', doc: false },
      ],
    });
    eq(results.length, 2, '只检查 doc 为真的门禁');
    const hit = results.find((result) => result.id === 'hit');
    eq(hit.state, 'PASS', '命中应 PASS');
    includes(hit.detail, 'a.md', '应指出命中的文件');
    eq(results.find((result) => result.id === 'miss').state, 'FAIL', '缺失应 FAIL');

    // 目录不存在 → BLOCKED，且说明要给出可操作的出口（只说「不行」等于没说）
    const blocked = gatesInternals.checkDocs(dir, { docsDir: 'no-such-dir', gates: [{ id: 'x', cmd: 'x', doc: true }] });
    eq(blocked.length, 1, '阻塞时只给一条结论');
    eq(blocked[0].state, 'BLOCKED', '状态');
    includes(blocked[0].detail, '文档目录不存在', '说明');
    includes(blocked[0].detail, 'NUXT_SHUTTLE_DOCS_DIR', '要给出环境变量出口');
  });

  g.check('F15 run-gates 文档一致性：七条命令都在文档里', async () => {
    const config = JSON.parse(readFileSync(join(TEMPLATE_ROOT, gatesInternals.GATES_FILE), 'utf8'));
    const results = gatesInternals.checkDocs(TEMPLATE_ROOT, config);
    // 文档目录不可达时必须**显式失败**，不能静默记 BLOCKED 就算过：
    // 这条断言的全部意义就是「真的跟文档对照过」，静默跳过会让人误以为检查过了。
    const blocked = results.find((result) => result.state === 'BLOCKED');
    if (blocked) {
      assert(false, `${blocked.detail}。设 NUXT_SHUTTLE_DOCS_DIR 指过去，或确认 docsDir 相对路径`);
    }
    const bad = results.filter((result) => result.state !== 'PASS').map((result) => `${result.id}: ${result.detail}`);
    eq(bad, [], '文档里找不到命令的门禁');
    assert(results.length >= 6, `带 doc 判据的门禁太少：${results.length}`);
  });

  g.check('F16 跳过安装的仓库：依赖未落盘只提示、不报漂移', async () => {
    const dir = freshRepo('f16');
    await initRepo(dir, { ui: 'element-plus' });
    // 前提：这条仓库确实是「跳过安装」跑出来的，否则测的就不是这个场景
    eq(JSON.parse(readText(dir, 'template.config.json')).installed, false, '快照应记录 installed=false');

    const out = capturingEmitter();
    eq(await engineCli(['--root', dir, '--check'], { out }), 0, '--check 退出码应为 0');
    eq(out.text('drift'), '', '不该有任何漂移项');
    includes(out.text('note'), '尚未落盘', '应以提示说明依赖没装');
    includes(out.text('note'), 'pnpm add', '提示里要给出可粘贴的补跑命令');
  });
}

/* ================================================================== *
 * R 冲突规则命中（`--rules`）
 * ================================================================== */

{
  const g = group('R', '冲突规则命中');

  /** 为一条规则构造「必然命中」的选择：把 when 里的条件逐条满足 */
  function sampleFor(rule) {
    const raw = {};
    for (const [key, expect] of Object.entries(rule.when)) {
      raw[key] = Array.isArray(expect) ? [expect[0]] : expect;
    }
    return raw;
  }

  g.check('R1 12 条规则全部可被构造出来，且 level 与声明一致', async () => {
    eq(OPTIONS.rules.length, 12, '规则总数');
    const missed = [];
    for (const rule of OPTIONS.rules) {
      const selection = normalizeSelection(OPTIONS, sampleFor(rule));
      // 实验性规则默认是关闭的，所以验它时必须让开关保持关闭
      const hits = validateSelection(OPTIONS, selection, { allowExperimental: false });
      const hit = hits.find((item) => item.rule === rule.id);
      if (!hit) missed.push(rule.id);
      else if (hit.level !== rule.level) missed.push(`${rule.id}（期望 ${rule.level}，实际 ${hit.level}）`);
    }
    eq(missed, [], '没被命中或 level 不符的规则');
  });

  g.check('R2 阻断级规则 2 条，其中实验性 1 条', async () => {
    const blocks = OPTIONS.rules.filter((rule) => rule.level === 'block');
    eq(blocks.length, 2, '阻断级规则数');
    eq(blocks.filter((rule) => rule.experimental).length, 1, '其中实验性的条数');
    // 实验性规则在开关打开后必须失效
    const vuetify = blocks.find((rule) => rule.experimental);
    const selection = normalizeSelection(OPTIONS, sampleFor(vuetify));
    eq(validateSelection(OPTIONS, selection, { allowExperimental: true }).filter((h) => h.rule === vuetify.id), [], '开关打开后仍命中');
  });

  g.check('R3 warn / block 的文案必须给「出路」', async () => {
    const bad = OPTIONS.rules
      .filter((rule) => rule.level === 'warn' || rule.level === 'block')
      .filter((rule) => !rule.message.includes('出路：'))
      .map((rule) => rule.id);
    eq(bad, [], '缺「出路」的规则');
  });

  g.check('R4 实验性选项必须写明理由', async () => {
    const bad = OPTIONS.rules
      .filter((rule) => rule.experimental)
      .filter((rule) => !rule.experimentalReason && !rule.message)
      .map((rule) => rule.id);
    eq(bad, [], '实验性规则缺理由');
  });

  g.check('R5 阻断的判定顺序：先形状、再规则，非法值不落到规则里', async () => {
    let message = '';
    try {
      buildPlan(OPTIONS, { selection: normalizeSelection(OPTIONS, { ui: 'not-exist' }) });
    } catch (err) {
      message = err.message;
    }
    // buildPlan 本身不校验形状，所以这里不该抛；顺序断言在 assertShape 与 preparePlan
    let threw = false;
    try {
      assertShape(OPTIONS, { ui: 'not-exist' });
    } catch {
      threw = true;
    }
    assert(threw, '非法枚举值必须在形状断言这一层被拒');
    eq(message, '', 'buildPlan 不该替调用方做形状校验');
  });
}

/* ================================================================== *
 * G 全矩阵
 * ================================================================== */

{
  const g = group('G', '全矩阵');

  g.check('G1 enumerate 展开的组合数 = 各单选项组取值数之积', async () => {
    const combos = enumerate(OPTIONS.groups);
    const expected = ['ui', 'preprocessor', 'atomic', 'render']
      .map((key) => BY_KEY.get(key).options.length)
      .reduce((a, b) => a * b, 1);
    eq(combos.length, expected, '组合数');
    eq(combos.length, 240, '名义组合数（与文档一致）');
    eq(new Set(combos.map((c) => describeSelection(OPTIONS, normalizeSelection(OPTIONS, c)))).size, 240, '组合应当互不相同');
  });

  g.check('G2 全矩阵扫描：176 有效 / 64 阻断 / 0 失败', async () => {
    const result = scanMatrix(SHARED_REPO, {});
    eq(result.nominal, 240, '名义组合数');
    eq(result.valid, 176, '有效组合数');
    eq(result.blocked, 64, '阻断组合数');
    eq(result.experimental, 48, '其中实验性阻断数');
    eq(result.failures.length, 0, `失败组合：${JSON.stringify(result.failures.slice(0, 3))}`);
    eq(result.passed, result.valid, '通过数应等于有效数');
  });

  g.check('G3 解除实验性后有效集扩大（Vuetify 48 种回到可选）', async () => {
    const result = scanMatrix(SHARED_REPO, { allowExperimental: true });
    eq(result.valid, 224, '允许实验性时的有效组合数');
    eq(result.blocked, 16, '允许实验性时的阻断组合数');
    eq(result.failures.length, 0, '失败组合');
  });

  g.check('G4 每个有效组合的样式入口都含固定基线 base.css', async () => {
    const bad = [];
    for (const combo of enumerate(OPTIONS.groups)) {
      let ctx;
      try {
        ctx = engineInternals.planFromRaw(SHARED_REPO, combo, {});
      } catch {
        continue;
      }
      if (!ctx.plan.cssEntries.includes('~/assets/styles/base.css')) bad.push(describeSelection(OPTIONS, combo));
    }
    eq(bad, [], '缺少 base.css 的组合');
  });
}

/* ================================================================== *
 * H 变异性（变异实验）
 *
 * 每条都做同一件事：把被测对象**故意改坏一格**，断言必须变红。
 * 只写「改坏了会报红」的注释不算，这里真的跑一遍。
 * ================================================================== */

{
  const g = group('H', '变异性');

  g.check('H1 从删除清单里去掉一项 → 第 3 项断言报红', async () => {
    const dir = freshRepo('h1');
    await initRepo(dir, { ui: 'none' });
    // 变异：把第 3 项本来要抓的东西「恢复」出来（模拟引擎漏删）
    const target = join(dir, WIZARD_FILES[WIZARD_FILES.length - 1]);
    writeText(dir, WIZARD_FILES[WIZARD_FILES.length - 1], '// 本应被删除的引导器文件\n');
    assert(existsSync(target), '变异没生效：文件没写进去');

    const { out, promise } = verifyRepo(dir);
    eq(await promise, 1, 'verify 退出码');
    includes(out.text(), 'FAIL  3', '第 3 项应报红');
    assert(!out.has('PASS  3'), '第 3 项不该同时是 PASS');
  });

  g.check('H2 清空一个引导器目录失败 → 第 4 项断言报红', async () => {
    const dir = freshRepo('h2');
    await initRepo(dir, { ui: 'none' });
    writeText(dir, 'app/components/wizard/Leftover.vue', '<template><div /></template>\n');

    const { out, promise } = verifyRepo(dir);
    eq(await promise, 1, 'verify 退出码');
    includes(out.text(), 'FAIL  4', '第 4 项应报红');
    includes(out.text(), 'Leftover.vue', '应列出残留文件');
  });

  g.check('H3 样式入口被手工加一项 → 第 7 项断言报红', async () => {
    const dir = freshRepo('h3');
    await initRepo(dir, { ui: 'none', preprocessor: 'none' });
    const path = join(dir, 'nuxt.config.ts');
    const patched = readFileSync(path, 'utf8')
      .replace("~/assets/styles/base.css']", "~/assets/styles/base.css', '~/assets/styles/extra.css']");
    assert(patched.includes('extra.css'), '变异没生效：样式入口没被改到');
    writeFileSync(path, patched, 'utf8');

    const { out, promise } = verifyRepo(dir);
    eq(await promise, 1, 'verify 退出码');
    includes(out.text(), 'FAIL  7', '第 7 项应报红');
    includes(out.text(), 'extra.css', '应点名多出来的入口');
  });

  g.check('H4 首页没换掉 → 第 8 项断言报红', async () => {
    const dir = freshRepo('h4');
    await initRepo(dir, { ui: 'none' });
    writeText(
      dir,
      'app/pages/index.vue',
      "<script setup>\nawait navigateTo('/setup', { redirectCode: 302 })\n</script>\n<template><div /></template>\n",
    );

    const { out, promise } = verifyRepo(dir);
    eq(await promise, 1, 'verify 退出码');
    includes(out.text(), 'FAIL  8', '第 8 项应报红');
  });

  g.check('H5 锁文件残留 → 第 10 项断言报红', async () => {
    const dir = freshRepo('h5');
    await initRepo(dir, { ui: 'none' });
    writeText(dir, engineInternals.LOCK_FILE, '{}');

    const { out, promise } = verifyRepo(dir);
    eq(await promise, 1, 'verify 退出码');
    includes(out.text(), 'FAIL 10', '第 10 项应报红');
  });

  g.check('H6 期望值改错 → 断言必须变红（证明断言真的在比）', async () => {
    // 取一条真实断言，把期望值改掉，验证它确实会失败。
    // 如果改错了期望值还是绿的，说明那条断言根本没在比 —— 这就是「装饰性门禁」。
    const ctx = ctxOf({ render: 'ssr' });
    const expected = 'ssr: true,';
    includes(ctx.sections['nuxt.config.ts'].RENDER, expected, '真实期望');
    let red = false;
    try {
      includes(ctx.sections['nuxt.config.ts'].RENDER, 'nitro: { preset: \'static\' }', '故意改错的期望');
    } catch {
      red = true;
    }
    assert(red, '把期望值改错后断言必须报红');
  });

  g.check('H7 门禁的四个状态互不混淆：BLOCKED 不能算 PASS', async () => {
    // 「四态」是运行器的判定语义（run-gates.mjs 的 exitCodeFor），不是本文件另写一份。
    // 关键点：只有 PASS 是 0；BLOCKED（没跑成）与 FAIL（跑错了）都要让 CI 变红，
    // 否则「环境没准备好」会被静默当成「检查通过」。
    const states = ['PASS', 'FAIL', 'BLOCKED', 'TIMEOUT'];
    eq(states.map((state) => exitCodeFor(state)), [0, 1, 1, 1], '退出码映射');
    assert(exitCodeFor('BLOCKED') !== exitCodeFor('PASS'), 'BLOCKED 不能与 PASS 同码');
    assert(exitCodeFor('BLOCKED') === exitCodeFor('FAIL'), 'BLOCKED 与 FAIL 同为红，但语义不同（下面验文案）');

    // 语义差别体现在文案上：四个状态各自可辨，且不会互相冒充
    const labels = states.map((state) => formatState(state));
    eq(labels, ['PASS', 'FAIL', 'BLOCKED', 'TIMEOUT'], '状态文案');
    eq(new Set(labels).size, 4, '四个文案互不相同');

    // 变异：把 BLOCKED 当成 0 —— 这正是「装饰性门禁」的典型写法，必须被这条断言拦住
    const wrong = (state) => (state === 'PASS' || state === 'BLOCKED' ? 0 : 1);
    assert(wrong('BLOCKED') !== exitCodeFor('BLOCKED'), '若两者相同，本条断言就拦不住「跳过当通过」');
  });
}

/* ------------------------------------------------------------------ *
 * 运行器
 * ------------------------------------------------------------------ */

function printHelp() {
  process.stdout.write(`${[
    'Nuxt Shuttle 引擎自测',
    '',
    '用法：node scripts/selftest.mjs [选项]',
    '',
    '  --group <KEY>   只跑某一组（可重复，如 --group A --group H）',
    '  --only <ID>     只跑编号匹配的断言（可重复；精确到编号，如 --only F2 不会命中 F16）',
    '  --rules         只跑冲突规则组（等价于 --group R）',
    '  --list          列出分组与断言名，不执行',
    '  -h, --help      显示本帮助',
    '',
    `沙箱目录：${RUN_DIR}`,
    '退出码：0 全绿 / 1 有失败 / 2 参数错误',
  ].join('\n')}\n`);
}

export function parseArgs(argv) {
  const out = { groups: [], only: [], list: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') out.help = true;
    else if (token === '--list') out.list = true;
    else if (token === '--rules') out.groups.push('R');
    else if (token === '--only') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--only 需要一个断言编号');
      out.only.push(value);
      index += 1;
    } else if (token === '--group') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--group 需要一个组名');
      out.groups.push(value.toUpperCase());
      index += 1;
    } else throw new Error(`未知参数：${token}`);
  }
  return out;
}

export async function runSelftest(argv) {
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
  const selected = CASES.filter((item) => {
    if (args.groups.length && !args.groups.includes(item.group)) return false;
    // 编号用词边界锚定：`--only F1` 不该把 F10~F16 一并捞进来
    if (args.only.length && !args.only.some((id) => new RegExp(`^${id}\\b`).test(item.name))) return false;
    return true;
  });
  if (!selected.length) {
    process.stderr.write(`没有匹配的断言：${[...args.groups, ...args.only].join(', ')}\n`);
    return 2;
  }

  if (args.list) {
    let current = null;
    for (const item of selected) {
      if (item.group !== current) {
        current = item.group;
        process.stdout.write(`\n[${item.group}] ${item.title}\n`);
      }
      process.stdout.write(`  ${item.name}\n`);
    }
    const scope = args.groups.length || args.only.length ? '（已筛选）' : '';
    process.stdout.write(`\n共 ${selected.length} 条断言${scope}\n`);
    return 0;
  }

  process.stdout.write(`沙箱：${RUN_DIR}\n`);
  const failures = [];
  let passed = 0;
  let current = null;

  for (const item of selected) {
    if (item.group !== current) {
      current = item.group;
      process.stdout.write(`\n[${item.group}] ${item.title}\n`);
    }
    try {
      // 每条断言独立 try：一条失败不能吞掉后面的（同 verify 的纪律）
      // eslint-disable-next-line no-await-in-loop
      await item.fn();
      passed += 1;
      process.stdout.write(`  PASS  ${item.name}\n`);
    } catch (err) {
      failures.push({ name: item.name, group: item.group, message: err.message });
      process.stdout.write(`  FAIL  ${item.name}\n        ${err.message}\n`);
    }
  }

  process.stdout.write(`\n自测：${passed}/${selected.length} 通过`);
  if (failures.length) process.stdout.write(`，失败 ${failures.length} 项`);
  process.stdout.write('\n');

  for (const failure of failures) {
    process.stdout.write(`  ✗ [${failure.group}] ${failure.name}：${failure.message}\n`);
  }

  if (failures.length) {
    process.stdout.write(`\n沙箱保留在 ${RUN_DIR}，可以进去看被改坏的那几个仓库。\n`);
    return 1;
  }
  return 0;
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  runSelftest(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`自测崩溃：${err.stack ?? err.message}\n`);
      process.exitCode = 1;
    });
}

export const internals = { CASES, TEMPLATE_ROOT, RUN_DIR, freshRepo, initRepo };
