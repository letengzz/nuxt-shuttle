#!/usr/bin/env node
/**
 * 门禁运行器 —— 读 `gates.json`（唯一来源），跑，然后把结局分成**四种状态**。
 *
 * 为什么必须区分四种而不是两种：
 *   PASS     跑完且符合期望
 *   FAIL     跑完但不符合期望      → 去改代码
 *   BLOCKED  **没跑成**（缺前置条件）→ 去装依赖 / 先初始化
 *   TIMEOUT  超时                  → 去查性能或死锁
 * 把 BLOCKED 混进 FAIL，会让「依赖没装」看起来像「代码写错了」；
 * 混进 PASS，则是给门禁开后门。这两种误判都会让人花时间在错误的地方。
 *
 * 与 CI 的关系：CI 里把这几条命令抄进各自的 job，但命令本身必须来自这里 ——
 * 用 `--check` 反查文档，确保「文档里写的」与「实际跑的是」同一条。
 *
 * CLI：
 *   node scripts/run-gates.mjs                 跑全部门禁
 *   node scripts/run-gates.mjs --list          打印清单（判据 / 责任人 / 权重 / 前置条件）
 *   node scripts/run-gates.mjs --check         只做文档一致性检查（不跑门禁）
 *   node scripts/run-gates.mjs --only lint     只跑指定的几条（逗号分隔）
 *   node scripts/run-gates.mjs --skip engine-selftest
 *   node scripts/run-gates.mjs --json          机器可读输出
 *
 * 退出码：0 全部 PASS / 1 存在非 PASS（含 BLOCKED、TIMEOUT）/ 2 参数错误
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommand } from './lib/proc.mjs';

const TEMPLATE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATES_FILE = 'scripts/gates.json';

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */

/** 四种状态与退出码的映射 —— 自测会直接断言这个函数（改了它就必须改自测） */
export function exitCodeFor(state) {
  return state === 'PASS' ? 0 : 1;
}

/** 把「状态 + 说明」合成一行，供人工与 CI 日志复用 */
export function formatState(state, detail) {
  const tag = { PASS: 'PASS', FAIL: 'FAIL', BLOCKED: 'BLOCKED', TIMEOUT: 'TIMEOUT' }[state] ?? 'FAIL';
  return `${tag.padEnd(7)} ${detail ?? ''}`.trimEnd();
}

/* ------------------------------------------------------------------ *
 * 前置条件
 * ------------------------------------------------------------------ */

/**
 * 检查一条门禁的前置条件。
 *
 * @returns {string|null} 不满足时返回人话原因，满足返回 null
 */
export function checkRequires(root, requires = []) {
  for (const item of requires) {
    if (item === 'node_modules') {
      if (!existsSync(join(root, 'node_modules'))) return '没装依赖（node_modules 不存在）';
      continue;
    }
    if (item === 'template.config.json') {
      if (!existsSync(join(root, 'template.config.json'))) return '这个仓库还没初始化过（没有 template.config.json）';
      continue;
    }
    if (item.startsWith('script:')) {
      const name = item.slice('script:'.length);
      const pkgPath = join(root, 'package.json');
      if (!existsSync(pkgPath)) return '没有 package.json';
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      } catch (err) {
        return `package.json 不是合法 JSON：${err.message}`;
      }
      if (typeof pkg.scripts?.[name] !== 'string') return `package.json 里没有 ${name} 脚本（取决于初始化时的选择）`;
      continue;
    }
    return `未知的前置条件：${item}`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 命令解析
 * ------------------------------------------------------------------ */

/**
 * 把 `cmd` 拆成 argv。
 *
 * 刻意**不做 shell 解析**：命令来自本仓库的 gates.json，是常量；
 * 交给 shell 反而多一层注入面，且 Windows 上的引号规则与 POSIX 不同。
 * 代价是不能写管道与 `&&` —— 需要组合逻辑就拆成两条门禁，那本来也更清楚。
 */
export function parseCommand(cmd) {
  const parts = String(cmd).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) throw new Error('空命令');
  if (/[|&;<>()$`]/.test(cmd)) {
    throw new Error(`门禁命令不允许 shell 元字符：${cmd}（需要组合逻辑请拆成两条门禁）`);
  }
  return parts;
}

/* ------------------------------------------------------------------ *
 * 文档一致性
 * ------------------------------------------------------------------ */

/** 递归收集 .md 文件 —— 只读，且只在本仓库之外的文档目录里读 */
function collectMarkdown(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) collectMarkdown(abs, out);
    else if (entry.endsWith('.md')) out.push(abs);
  }
  return out;
}

/**
 * 反查文档：`doc: true` 找 cmd 原文，`doc: "<片段>"` 找该片段。
 *
 * @returns {object[]} 每条的结论
 */
export function checkDocs(root, config) {
  // 设计文档可能不在本仓库里（本模板的文档就放在隔壁的 docs-website 仓库），
  // 所以留一个环境变量出口：换机器、CI 或克隆到别处时，用它指过去。
  // 绝对路径直接生效（resolve 对绝对路径会忽略 root）。
  const configured = process.env.NUXT_SHUTTLE_DOCS_DIR ?? config.docsDir;
  const docsPath = configured ? resolve(root, configured) : null;
  const results = [];

  if (!docsPath || !existsSync(docsPath)) {
    return [{
      id: '(文档)',
      state: 'BLOCKED',
      detail:
        `文档目录不存在：${configured ?? '（未配置 docsDir）'}` +
        `（解析为 ${docsPath ?? '—'}；可用环境变量 NUXT_SHUTTLE_DOCS_DIR 指定绝对路径）` +
        '。--check 需要它才能反查「文档里真的有这条命令」',
    }];
  }

  const files = collectMarkdown(docsPath).map((file) => ({ file, text: readFileSync(file, 'utf8') }));

  for (const gate of config.gates) {
    if (!gate.doc) continue;
    const needle = gate.doc === true ? gate.cmd : String(gate.doc);
    const hit = files.find((item) => item.text.includes(needle));
    results.push({
      id: gate.id,
      state: hit ? 'PASS' : 'FAIL',
      detail: hit
        ? `文档里找到「${needle}」（${hit.file.slice(docsPath.length + 1)}）`
        : `文档里找不到「${needle}」—— 命令改了而文档没改，或文档改了而清单没改`,
    });
  }
  return results;
}

/* ------------------------------------------------------------------ *
 * 运行
 * ------------------------------------------------------------------ */

export async function runGates(root, options = {}) {
  const { only = null, skip = new Set(), json = false } = options;
  const config = JSON.parse(readFileSync(join(root, GATES_FILE), 'utf8'));
  const gates = config.gates
    .filter((gate) => (only ? only.includes(gate.id) : true))
    .filter((gate) => !skip.has(gate.id))
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

  const results = [];
  for (const gate of gates) {
    const blocked = checkRequires(root, gate.requires ?? []);
    if (blocked) {
      results.push({ id: gate.id, state: 'BLOCKED', detail: blocked, weight: gate.weight });
      if (!json) process.stdout.write(`${formatState('BLOCKED', `${gate.id.padEnd(16)} ${blocked}`)}\n`);
      continue;
    }

    let argv;
    try {
      argv = parseCommand(gate.cmd);
    } catch (err) {
      results.push({ id: gate.id, state: 'FAIL', detail: err.message, weight: gate.weight });
      if (!json) process.stdout.write(`${formatState('FAIL', `${gate.id.padEnd(16)} ${err.message}`)}\n`);
      continue;
    }

    if (!json) process.stdout.write(`\n▌ ${gate.id}  ${gate.cmd}\n  · ${gate.why}\n`);
    const out = json
      ? null
      : { emit: (event) => { if (event.type === 'log') process.stdout.write(`  ${event.line}\n`); } };

    // eslint-disable-next-line no-await-in-loop
    const result = await runCommand(argv[0], argv.slice(1), {
      cwd: root,
      out,
      timeoutMs: (gate.timeoutSec ?? 120) * 1000,
      label: gate.cmd,
    });

    const state = result.timedOut ? 'TIMEOUT' : result.code === 0 ? 'PASS' : 'FAIL';
    const detail = result.timedOut
      ? `超过 ${gate.timeoutSec}s`
      : result.code === 0
        ? '退出码 0'
        : `退出码 ${result.code}${result.tail.length ? `；末尾输出：${result.tail.slice(-3).join(' | ')}` : ''}`;
    results.push({ id: gate.id, state, detail, weight: gate.weight, code: result.code });

    if (json) continue;
    if (state !== 'PASS') process.stdout.write(`  ${formatState(state, detail)}\n`);
    else process.stdout.write(`  ${formatState('PASS', detail)}\n`);
  }

  return results;
}

/* ------------------------------------------------------------------ *
 * 展示
 * ------------------------------------------------------------------ */

function printList(config) {
  const lines = ['', '门禁清单（来源：scripts/gates.json）', ''];
  lines.push(`${'id'.padEnd(16)}${'权重'.padEnd(6)}${'责任人'.padEnd(10)}${'前置条件'.padEnd(28)}命令`);
  lines.push('-'.repeat(100));
  for (const gate of [...config.gates].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))) {
    const requires = (gate.requires ?? []).join(',') || '—';
    lines.push(`${gate.id.padEnd(16)}${String(gate.weight ?? 0).padEnd(6)}${(gate.owner ?? '—').padEnd(10)}${requires.padEnd(28)}${gate.cmd}`);
  }
  lines.push('');
  lines.push('判据（为什么这条门禁存在）：');
  for (const gate of config.gates) lines.push(`  ${gate.id.padEnd(16)}${gate.why ?? ''}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

function printSummary(results) {
  const byState = { PASS: 0, FAIL: 0, BLOCKED: 0, TIMEOUT: 0 };
  for (const result of results) byState[result.state] = (byState[result.state] ?? 0) + 1;
  const parts = Object.entries(byState).filter(([, n]) => n > 0).map(([state, n]) => `${state} ${n}`);
  process.stdout.write(`\n门禁：${parts.join(' / ')}\n`);

  const bad = results.filter((result) => result.state !== 'PASS');
  if (bad.length) {
    process.stdout.write('\n未通过：\n');
    for (const result of bad) process.stdout.write(`  ${formatState(result.state, `${result.id}：${result.detail}`)}\n`);
    const blocked = bad.filter((result) => result.state === 'BLOCKED');
    if (blocked.length) {
      process.stdout.write('\nBLOCKED 是「没跑成」，不是「跑错了」：把上面缺的前置条件补上再跑一次。\n');
    }
  }
}

function printHelp() {
  process.stdout.write(`${[
    'Nuxt Shuttle 门禁运行器',
    '',
    '用法：node scripts/run-gates.mjs [选项]',
    '',
    '  --list              打印清单（判据 / 责任人 / 权重 / 前置条件）',
    '  --check             只做文档一致性检查（文档里是否真的有这些命令）',
    '  --only a,b          只跑指定门禁',
    '  --skip a,b          跳过指定门禁',
    '  --json              机器可读输出',
    '  --root <dir>        指定仓库根目录（缺省为当前工作目录）',
    '  -h, --help          显示本帮助',
    '',
    '状态：PASS / FAIL（跑错了）/ BLOCKED（没跑成）/ TIMEOUT',
    '退出码：0 全部 PASS / 1 存在非 PASS / 2 参数错误',
  ].join('\n')}\n`);
}

export function parseArgs(argv) {
  const out = { list: false, check: false, only: null, skip: new Set(), json: false, root: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') out.help = true;
    else if (token === '--list') out.list = true;
    else if (token === '--check') out.check = true;
    else if (token === '--json') out.json = true;
    else if (token === '--only' || token === '--skip') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${token} 需要一个逗号分隔的 id 列表`);
      const ids = value.split(',').map((id) => id.trim()).filter(Boolean);
      if (token === '--only') out.only = ids;
      else ids.forEach((id) => out.skip.add(id));
      index += 1;
    } else if (token === '--root') {
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

  const root = resolve(args.root ?? process.cwd());
  const config = JSON.parse(readFileSync(join(root, GATES_FILE), 'utf8'));

  if (args.list) {
    printList(config);
    return 0;
  }

  if (args.check) {
    const results = checkDocs(root, config);
    if (args.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    else {
      for (const result of results) {
        process.stdout.write(`${formatState(result.state, `${result.id.padEnd(16)} ${result.detail}`)}\n`);
      }
    }
    return results.some((result) => result.state !== 'PASS') ? 1 : 0;
  }

  const results = await runGates(root, { only: args.only, skip: args.skip, json: args.json });
  if (args.json) process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
  else printSummary(results);

  return results.some((result) => result.state !== 'PASS') ? 1 : 0;
}

const isDirectRun = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  runCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err) => {
      process.stderr.write(`门禁运行器崩溃：${err.stack ?? err.message}\n`);
      process.exitCode = 1;
    });
}

export const internals = { TEMPLATE_ROOT, GATES_FILE, printList, checkDocs };
