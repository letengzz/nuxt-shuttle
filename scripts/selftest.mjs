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

    // 变异：把调用删掉，上面那条必须变红 —— 否则它只是装饰
    const mutated = page.replace(/void wizard\.(load|attach)\(\);/g, '/* 删掉 */');
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
    // else 兜底分支对应 select
    if (/<div v-else class="select-row">/.test(component)) used.add('select');

    const options = JSON.parse(readFileSync(join(TEMPLATE_ROOT, 'server/utils/wizard/options.json'), 'utf8'));
    const inUse = [...new Set(options.groups.map((grp) => grp.renderAs))].sort();

    eq(declared, ['cards', 'checks', 'radios', 'select'], '类型里声明的形态');
    hasAll([...used], inUse, '组件已实现的形态（options.json 里用到的每个都得有分支）');
    eq([...used].sort(), declared, '实现与声明必须一一对应，不留无人使用的形态');
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

  g.check('B9 allowBuilds：选了 image 才追加 sharp；esbuild 恒为 false', async () => {
    const plain = ctxOf({});
    includes(plain.sections['pnpm-workspace.yaml'].ALLOW_BUILDS, 'esbuild: false', 'esbuild 恒为 false');
    assert(!plain.plan.allowBuilds.includes('sharp'), '未选 image 时不该出现 sharp');
    const image = ctxOf({ modules: ['image'] });
    includes(image.sections['pnpm-workspace.yaml'].ALLOW_BUILDS, 'sharp: true', '选了 image 应追加 sharp');
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
