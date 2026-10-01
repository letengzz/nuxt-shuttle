/**
 * 自测沙箱 —— 固定沙箱根 + 每个用例一个子目录 + **全程不删目录**。
 *
 * 这三条是实测得出的，不是洁癖：
 *
 * ① **固定根目录**（`%TEMP%/nuxt-init-selftest`）而不是每次 `mkdtemp`。
 *    用例有几十个，固定根让「上一次跑剩下了什么」可见；mkdtemp 之后一旦清理失败，
 *    那些目录就再也找不回来。
 *
 * ② **每用例一个子目录 + 每次运行一个 run 目录**，于是永远不需要「删掉再重建」。
 *    部分受限环境下 `rmSync(dir, { recursive: true })` 与 `rmdirSync()` 会**挂住不返回**
 *    （进程不退出，既没有报错也没有结果），而 `unlinkSync` 删单个文件是正常的。
 *    这个脚本在交付时就要能在那种环境里跑，所以「删除」这条路径整条避开。
 *    代价是沙箱会累积 —— 它在系统临时目录里，由系统或用户清理，自测脚本不碰。
 *
 * ③ **进程内驱动引擎，不拉起子进程**。同类环境下 `spawnSync` / `execFileSync`
 *    会一律返回 `EBUSY`。引擎因此写成 `runCli(argv)` 返回退出码 + `isDirectRun` 守卫，
 *    这里 `import` 之后直接调用即可 —— 这也是那套可测性设计的唯一用途验证。
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/** 复制仓库时要跳过的目录/文件：它们要么很大，要么是上一轮的产物 */
const SKIP_NAMES = new Set(['node_modules', '.git', '.nuxt', '.output', '.init-backup', '.data', '.nitro', '.cache', 'dist']);

/** 固定沙箱根。测试与人工排查都从这里找产物。 */
export function sandboxRoot() {
  const base = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';
  return join(base, 'nuxt-init-selftest');
}

/** 本次运行独占的目录：同一秒内重复运行会拿到同一个名字，于是复用（不删，覆盖写） */
export function runDir(stamp = new Date().toISOString().replace(/[:.]/g, '-')) {
  return join(sandboxRoot(), `run-${stamp}`);
}

/**
 * 把模板仓库复制成一个干净的「未初始化」工程。
 *
 * 复制而不是「在真仓库里跑」：自测会故意把文件改坏（变异组），
 * 而没有人希望一次自测失败之后，模板仓库里躺着被改坏的文件。
 */
export function makeRepo(target, source) {
  mkdirSync(target, { recursive: true });
  cpSync(source, target, {
    recursive: true,
    filter: (src) => {
      const name = src.split(/[\\/]/).pop();
      return !SKIP_NAMES.has(name) && !name.endsWith('.log');
    },
  });
  return target;
}

/** 把用例目录准备好：已存在就直接用（覆盖写），绝不删除 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJson(dir, rel, data) {
  const abs = join(dir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return abs;
}

export function readText(dir, rel) {
  return readFileSync(join(dir, rel), 'utf8');
}

export function exists(dir, rel) {
  return existsSync(join(dir, rel));
}

/** 收集事件而不打印 —— 用于断言引擎自己说了什么 */
export function capturingEmitter() {
  const events = [];
  return {
    events,
    emit(event) {
      events.push(event);
    },
    /**
     * `process.stdout` 的最小子集。
     * 引擎里有些输出是直写 stdout 的（如 printHelp），传这个 emitter 进去也能被捕获 ——
     * 否则自测只能断言退出码，看不了它「说了什么」。
     */
    write(chunk) {
      for (const line of String(chunk).split('\n')) {
        if (line) events.push({ type: 'note', line });
      }
    },
    /** 把某类事件拼成一段文本，方便断言文案 */
    text(type) {
      return events
        .filter((event) => !type || event.type === type)
        .map((event) => event.line ?? event.message ?? '')
        .join('\n');
    },
    has(pattern) {
      return new RegExp(pattern).test(events.map((e) => `${e.line ?? ''}${e.message ?? ''}`).join('\n'));
    },
  };
}

/**
 * 目录摘要：`相对路径 → 文件内容`。两个摘要相等即「逐字节相同」。
 *
 * 幂等（C 组）与手写区保护（D 组）都靠它：比起自己写一套比较逻辑，
 * 不如把两侧都拍平成同一张表再比 —— 键集不同就说明多了或少了文件，一眼看得出来。
 */
export function treeDigest(dir, ignore = []) {
  const out = new Map();
  const skip = new Set([...SKIP_NAMES, ...ignore]);
  const walk = (rel) => {
    const abs = rel ? join(dir, rel) : dir;
    for (const entry of readdirSync(abs)) {
      if (skip.has(entry)) continue;
      const childRel = rel ? `${rel}/${entry}` : entry;
      if (statSync(join(dir, childRel)).isDirectory()) walk(childRel);
      else out.set(childRel, readFileSync(join(dir, childRel), 'utf8'));
    }
  };
  walk('');
  return out;
}

/** 两个摘要的差异，返回可读行；空数组表示完全一致 */
export function diffDigest(a, b) {
  const problems = [];
  for (const [key, value] of a) {
    if (!b.has(key)) problems.push(`少了 ${key}`);
    else if (b.get(key) !== value) problems.push(`${key} 内容不同`);
  }
  for (const key of b.keys()) {
    if (!a.has(key)) problems.push(`多了 ${key}`);
  }
  return problems;
}

/** 安全地取相对路径（沙箱内的路径拼接，避免手写 join 时漏掉一层） */
export function inRepo(dir, ...parts) {
  const abs = resolve(dir, ...parts);
  if (abs !== dir && !abs.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`)) {
    throw new Error(`路径越出沙箱：${parts.join('/')}`);
  }
  return abs;
}
