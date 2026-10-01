#!/usr/bin/env node
/**
 * 全矩阵扫描 —— 把「240 个组合」从一句口号变成一份证据。
 *
 * 为什么值得单独一个脚本：
 * 选项是**组合**爆炸的。5 个 UI × 4 个预处理器 × 3 个原子化 × 4 种渲染 = 240 套方案，
 * 每一套都会走到不同的模板文件、不同的依赖清单、不同的样式入口顺序。
 * 只测「默认那套」等于没测：漏掉的往往是某个冷门选项缺一个模板文件，
 * 而发现它的时机是用户点了那个选项之后。
 *
 * 扫描的空间与「为什么是 240」：
 *   只枚举**四个单选项组**（UI / 预处理器 / 原子化 / 渲染），多选组（模块、工程开关）
 *   与包管理器取 `options.json` 里的默认值。
 *   理由：阻断级冲突全部由这四个组决定（Nuxt UI × UnoCSS、Vuetify 实验性），
 *   而多选组的每一组取值彼此正交 —— 把它们一起展开是 24 万种，
 *   换来的是运行时间，不是覆盖率。多选组的正确性由 `selftest.mjs` 的规则组
 *   按「每条规则构造命中样本」来覆盖，那比对空间做笛卡尔积精确得多。
 *
 * 每个有效组合验三件事（都不写文件，所以能一次全跑完）：
 *   ① 计划非空且形状正确；
 *   ② 覆盖区与生成区的模板齐全，且占位符全部有声明；
 *   ③ 区间渲染不抛异常（缺 marker 会抛）。
 *
 * CLI：
 *   node scripts/matrix.mjs --dry-run-all          扫 240 个组合（默认）
 *   node scripts/matrix.mjs --force-experimental   把实验性阻断也计入有效集
 *   node scripts/matrix.mjs --json                 输出 JSON
 *   node scripts/matrix.mjs --filter ui=nuxt-ui    只看某个取值命中的组合
 *
 * 退出码：0 全部符合预期 / 1 有组合失败 / 2 参数错误
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { internals as engineInternals, planFromRaw } from './init.mjs';

const { OPTIONS_FILE, preflightTemplates } = engineInternals;

/** 参与笛卡尔积的组：顺序即输出顺序 */
const MATRIX_GROUPS = ['ui', 'preprocessor', 'atomic', 'render'];

/* ------------------------------------------------------------------ *
 * 枚举
 * ------------------------------------------------------------------ */

/** 把「组的取值列表」展开成所有组合 —— 纯函数，便于自测直接断言条数 */
export function enumerate(groups, keys = MATRIX_GROUPS) {
  const picked = keys.map((key) => ({ key, group: groups.find((g) => g.key === key) }));
  const missing = picked.filter((p) => !p.group).map((p) => p.key);
  if (missing.length) throw new Error(`options.json 里缺少分组：${missing.join(', ')}`);

  let combos = [{}];
  for (const { key, group } of picked) {
    const next = [];
    for (const combo of combos) {
      for (const option of group.options) next.push({ ...combo, [key]: option.value });
    }
    combos = next;
  }
  return combos;
}

/** 把组合拼成一个可读签名，如 `ui=nuxt-ui,preprocessor=sass,atomic=tailwind,render=ssr` */
export function signature(combo) {
  return Object.entries(combo).map(([key, value]) => `${key}=${value}`).join(',');
}

/* ------------------------------------------------------------------ *
 * 扫描
 * ------------------------------------------------------------------ */

function formatCombo(combo) {
  return MATRIX_GROUPS.map((key) => combo[key]).join(' / ');
}

/**
 * 扫一遍。
 *
 * @returns {{
 *   nominal: number, valid: number, blocked: number, experimental: number,
 *   passed: number, failures: object[]
 * }}
 */
export function scan(root, options = {}) {
  const { allowExperimental = false, filter = null } = options;
  const optionsPath = resolve(root, OPTIONS_FILE);
  const data = JSON.parse(readFileSync(optionsPath, 'utf8'));
  const combos = enumerate(data.groups);

  // 哪些规则是「实验性」的 —— 从数据里读，不在代码里写死规则 id。
  // 阻断级错误信息里带着命中的规则 id（`- [ruleId] 文案`），据此判断这一条阻断
  // 到底属于「真冲突」还是「默认关掉、可用开关打开」—— 两者混在一起会让人
  // 以为有 64 种组合不能选，而其中 48 种只是挪到了开关后面。
  const experimentalIds = new Set(data.rules.filter((rule) => rule.experimental).map((rule) => rule.id));

  const result = {
    nominal: combos.length,
    valid: 0,
    blocked: 0,
    experimental: 0,
    passed: 0,
    failures: [],
    blockedSamples: [],
  };

  for (const combo of combos) {
    if (filter && !matchesFilter(combo, filter)) continue;

    let ctx;
    try {
      ctx = planFromRaw(root, combo, { forceExperimental: allowExperimental });
    } catch (err) {
      const blockedByRule = /阻断级冲突/.test(err.message);
      if (blockedByRule) {
        result.blocked += 1;
        const hitIds = [...err.message.matchAll(/- \[([^\]]+)\]/g)].map((match) => match[1]);
        if (hitIds.length && hitIds.every((id) => experimentalIds.has(id))) result.experimental += 1;
        if (result.blockedSamples.length < 3) {
          result.blockedSamples.push({ combo: signature(combo), message: err.message });
        }
        continue;
      }
      // 不是「被规则拦下」而是「崩了」—— 这是要修的 bug，不是预期的阻断
      result.failures.push({ combo: signature(combo), stage: 'plan', message: err.message });
      continue;
    }

    result.valid += 1;

    const problems = preflightTemplates(root, ctx);
    if (problems.length) {
      result.failures.push({ combo: signature(combo), stage: 'preflight', message: problems.join('；') });
      continue;
    }

    // 计划非空：一个「选了什么都不产生」的组合等于引导器骗了用户
    const empty = ['deps', 'devDeps', 'modules', 'cssEntries', 'deleteFiles', 'sections'].filter(
      (key) => (ctx.plan[key] ?? []).length === 0,
    );
    if (empty.length) {
      result.failures.push({ combo: signature(combo), stage: 'plan-shape', message: `这些字段为空：${empty.join(', ')}` });
      continue;
    }

    result.passed += 1;
  }

  return result;
}

/** 该组合是否命中 `--filter`（值一律按字符串比较，避免 3 与 '3' 的意外不等） */
function matchesFilter(combo, filter) {
  return Object.entries(filter).every(([key, value]) => {
    if (combo[key] === undefined) return false;
    return String(combo[key]) === String(value);
  });
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function printHelp() {
  process.stdout.write(`${[
    'Nuxt Shuttle 全矩阵扫描',
    '',
    '用法：node scripts/matrix.mjs [选项]',
    '',
    '  --dry-run-all          扫描四个单选项组的全部组合（默认行为）',
    '  --force-experimental   解除实验性阻断，把那些组合也计入有效集',
    '  --filter key=value     只看命中的组合，可重复（如 --filter ui=nuxt-ui）',
    '  --json                 以 JSON 输出结果',
    '  --root <dir>           指定模板仓库根目录（缺省为当前工作目录）',
    '  -h, --help             显示本帮助',
    '',
    '退出码：0 全部符合预期 / 1 有组合失败 / 2 参数错误',
  ].join('\n')}\n`);
}

export function parseArgs(argv) {
  const out = { dryRunAll: false, forceExperimental: false, json: false, root: null, filter: {}, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') out.help = true;
    else if (token === '--dry-run-all') out.dryRunAll = true;
    else if (token === '--force-experimental') out.forceExperimental = true;
    else if (token === '--json') out.json = true;
    else if (token === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('--root 需要一个路径参数');
      out.root = value;
      index += 1;
    } else if (token === '--filter') {
      const value = argv[index + 1];
      if (!value || !value.includes('=')) throw new Error('--filter 需要 key=value 形式');
      const [key, ...rest] = value.split('=');
      out.filter[key] = rest.join('=');
      index += 1;
    } else throw new Error(`未知参数：${token}`);
  }
  return out;
}

export function runCli(argv) {
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

  const root = resolve(args.root ?? process.cwd());
  const result = scan(root, { allowExperimental: args.forceExperimental, filter: args.filter });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${[
      '',
      `矩阵：名义 ${result.nominal} / 有效 ${result.valid} / 阻断 ${result.blocked}（其中实验性 ${result.experimental}）`,
      `扫描：通过 ${result.passed} / 失败 ${result.failures.length}`,
    ].join('\n')}\n`);

    for (const failure of result.failures.slice(0, 10)) {
      process.stdout.write(`  FAIL  ${failure.combo}  [${failure.stage}] ${failure.message}\n`);
    }
    if (result.failures.length > 10) {
      process.stdout.write(`  …还有 ${result.failures.length - 10} 条失败\n`);
    }
    if (result.blockedSamples.length) {
      process.stdout.write('  阻断样例：\n');
      for (const sample of result.blockedSamples) {
        process.stdout.write(`    ${sample.combo} → ${sample.message.split('\n')[0]}\n`);
      }
    }
  }

  return result.failures.length ? 1 : 0;
}

/** 直接运行才执行；被 selftest import 时只提供函数 */
const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`矩阵扫描崩溃：${err.stack ?? err.message}\n`);
    process.exitCode = 1;
  }
}

export const internals = { MATRIX_GROUPS, formatCombo };
