/**
 * 计划算法 —— 纯函数、**零 import**，由服务端（Nitro）与初始化引擎共用同一份。
 *
 * 为什么必须共用：
 * 「预览变更」与「执行初始化」如果各算一次，迟早会出现「说删 7 个文件、实际删了 9 个」。
 * 把计划抽成纯函数（输入选择 → 输出计划，无副作用），两边读同一份代码，
 * 从根上杜绝这类不一致。
 *
 * 为什么**不允许 import 任何东西**：
 * ① 引擎要在「还没装依赖」的仓库里跑，引第三方包会形成鸡生蛋问题；
 * ② 服务端会把它打进 bundle，保持纯粹才能两边无副作用地复用。
 * 因此选项数据由调用方读好后传进来（服务端用 import JSON，引擎用 node:fs）。
 *
 * 校验顺序永远是：**先断言输入形状合法 → 再归一化 → 再跑规则**。
 * 反过来（先补默认值再校验）会让一个非法输入被默认值「洗白」成合法组合，
 * 让人误以为校验通过了。
 */

/** nuxt.config.ts 里需要引擎改写的 marker 区间键（顺序即文件中的出现顺序） */
export const SECTION_KEYS = [
  'IMPORTS',
  'MODULES',
  'MODULE_OPTIONS',
  'VITE',
  'CSS',
  'RUNTIME',
  'RENDER',
  'TYPESCRIPT',
];

/** package.json 里需要引擎改写的 marker 区间键 */
export const PACKAGE_SECTIONS = ['SCRIPTS'];

/**
 * pnpm-workspace.yaml 里需要引擎改写的 marker 区间键。
 *
 * 为什么连它也归引擎管：选了 @nuxt/image 会在 pnpm 11 下带出 sharp 的安装脚本，
 * 而 pnpm 11 的 strictDepBuilds 默认拒绝执行安装脚本 —— 不把 allowBuilds 写进去，
 * 产物在装依赖那一步就断了，而且报错信息完全不会提到「你少了一行 allowBuilds」。
 */
export const WORKSPACE_SECTIONS = ['ALLOW_BUILDS'];

/** 样式入口槽位顺序：① 原子化 base → ② tokens → ③ base → ④ UI 组件库 */
const SLOT_ORDER = { base: 0, tokens: 1, 'base-css': 2, ui: 3 };

/** 允许的包管理器（选项的价值来自「有人真的会用」，不做四套 install 分支） */
export const LOCKFILES = ['pnpm', 'npm'];

function slotRank(slot) {
  return Object.prototype.hasOwnProperty.call(SLOT_ORDER, slot) ? SLOT_ORDER[slot] : 99;
}

/** 去重，保留首次出现的顺序 */
function unique(list) {
  return [...new Set(list)];
}

/** 去重并排序：用于依赖清单，保证同选择产出逐字节相同 */
function uniqueSorted(list) {
  return [...new Set(list)].sort();
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** 每个选项声明的文件并集 —— 用于算「上一次跑留下、这一次不再需要的生成文件」 */
export function allGeneratedFiles(options) {
  const out = [];
  for (const group of options.groups) {
    for (const item of group.options) {
      for (const f of item.files ?? []) out.push(f);
    }
  }
  return uniqueSorted(out);
}

/** 分组查表：{ key -> group }，并附带 value -> item 的二级索引 */
export function buildGroupIndex(options) {
  const byKey = new Map();
  for (const group of options.groups) {
    byKey.set(group.key, {
      group,
      values: new Map(group.options.map((o) => [o.value, o])),
    });
  }
  return byKey;
}

/**
 * L1 + L2：结构白名单。任何不在候选集里的值一律拒绝，不做「猜测用户意图」。
 * 抛出的错误信息必须带**位置**（哪个键、什么值），否则用户拿着 FAIL 只能来问你。
 */
export function assertShape(options, raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('selection 必须是一个对象');
  }

  const index = buildGroupIndex(options);

  for (const [key, value] of Object.entries(raw)) {
    const entry = index.get(key);
    if (!entry) throw new Error(`未知分组：${key}`);
    const { group, values: allowed } = entry;

    if (group.multiple) {
      if (!Array.isArray(value)) {
        throw new Error(`${key} 是多选组，必须是字符串数组，收到 ${typeof value}`);
      }
      if (value.length > group.options.length) {
        throw new Error(`${key} 的成员数超过候选数：${value.length} > ${group.options.length}`);
      }
      for (const v of value) {
        if (typeof v !== 'string') {
          throw new Error(`${key} 的成员必须是字符串，收到 ${typeof v}`);
        }
        if (!allowed.has(v)) throw new Error(`${key} 的值非法：${v}`);
      }
      continue;
    }

    if (Array.isArray(value)) {
      throw new Error(`${key} 是单选组，不接受数组（收到 ${value.length} 项）`);
    }
    if (typeof value !== 'string') {
      throw new Error(`${key} 必须是字符串，收到 ${typeof value}`);
    }
    if (!allowed.has(value)) throw new Error(`${key} 的值非法：${value}`);
  }
}

/**
 * 补默认值 → 排序 → 去重。
 *
 * 排序与去重是为了「可复现」：多选组按 options.json 的声明顺序排列，
 * 依赖用集合语义去重，于是「同样的集合、不同的输入顺序」产出逐字节相同的计划。
 */
export function normalizeSelection(options, raw) {
  const out = {};
  for (const group of options.groups) {
    const provided = raw?.[group.key];
    const value = provided === undefined || provided === null ? group.default : provided;

    if (group.multiple) {
      const order = group.options.map((o) => o.value);
      out[group.key] = unique(asArray(value))
        .filter((v) => typeof v === 'string')
        .sort((a, b) => order.indexOf(a) - order.indexOf(b));
      continue;
    }

    out[group.key] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

/** 单条规则是否命中：`when` 里的每个条件都必须满足 */
export function matchRule(rule, selection) {
  return Object.entries(rule.when).every(([key, expect]) => {
    const actual = selection[key];
    if (Array.isArray(expect)) {
      return Array.isArray(actual)
        ? actual.some((v) => expect.includes(v))
        : expect.includes(actual);
    }
    return actual === expect;
  });
}

/**
 * L3：规则匹配。命中即收集，由调用方按 level 决定拒绝（block）还是提示。
 * `allowExperimental` 为真时，标记为 experimental 的规则失效（CLI 的 --force-experimental）。
 */
export function validateSelection(options, selection, { allowExperimental = false } = {}) {
  const hits = [];
  for (const rule of options.rules) {
    if (rule.experimental && allowExperimental) continue;
    if (matchRule(rule, selection)) {
      hits.push({ level: rule.level, message: rule.message, rule: rule.id ?? null });
    }
  }
  return hits;
}

/** 把「选择」拍平成一个可读签名，用于 --check 的输出与日志 */
export function describeSelection(options, selection) {
  const parts = [];
  for (const group of options.groups) {
    const v = selection[group.key];
    const text = Array.isArray(v) ? (v.length ? v.join('+') : '无') : String(v);
    parts.push(`${group.key}=${text}`);
  }
  return parts.join(', ');
}

/**
 * 计算变更计划。无副作用、不碰文件系统。
 *
 * @param {object} options        options.json 的内容
 * @param {object} input
 * @param {object} input.selection  已归一化的选择
 * @param {string[]} input.wizardFiles 引擎内置白名单（来自 shared/wizard/whitelist.mjs）
 * @param {string[]} input.keepFiles   明确保留的清单
 * @param {string} input.lockfile      'pnpm' | 'npm'
 * @param {object[]} input.conflicts   规则命中结果（由调用方传入，便于预览与执行共用）
 */
export function buildPlan(options, input) {
  const { selection, wizardFiles = [], keepFiles = [], lockfile = 'pnpm', conflicts = [] } = input ?? {};

  // 把选择还原成「被选中的选项条目」
  const picked = [];
  for (const group of options.groups) {
    for (const value of asArray(selection[group.key])) {
      const item = group.options.find((o) => o.value === value);
      if (item) picked.push({ group: group.key, value, item });
    }
  }

  return {
    selection,
    ...buildPlanFromPicked(picked, {
      wizardFiles,
      keepFiles,
      lockfile,
      conflicts,
      generatedFilesAll: allGeneratedFiles(options),
    }),
  };
}

/**
 * 从「被选中的选项条目」聚合出计划 —— 纯聚合，不碰 options.json。
 *
 * 为什么单独一个导出：初始化之后 `options.json` 已经被删掉，而校验阶段
 * （第 2 项断言）仍然要回答「这份计划真的等于各选项声明之和吗」。
 * 只要 apply 阶段把 `picked` 原样记进 `template.config.json`，这里就能重算一遍做比对。
 * 如果把这套聚合逻辑在校验器里抄一份，两份迟早对不上 —— 那时红灯指向的是校验器，
 * 而人只会去改正确的产物。
 *
 * @param {{group: string, value: string, item: object}[]} picked
 * @param {object} input
 * @param {string[]} input.wizardFiles        引导器白名单（用于算删除清单）
 * @param {string[]} input.generatedFilesAll  所有选项可能生成的文件的并集（用于算「过期生成文件」）
 */
export function buildPlanFromPicked(picked, input = {}) {
  const {
    wizardFiles = [],
    keepFiles = [],
    lockfile = 'pnpm',
    conflicts = [],
    generatedFilesAll = [],
  } = input;

  if (!LOCKFILES.includes(lockfile)) {
    throw new Error(`不支持的包管理器：${lockfile}（只支持 ${LOCKFILES.join(' / ')}）`);
  }

  // 1) 依赖：去重排序；同时出现在 prod 与 dev 的包只按 prod 装一次
  const deps = uniqueSorted(picked.flatMap((p) => p.item.deps ?? []));
  const devDeps = uniqueSorted(picked.flatMap((p) => p.item.devDeps ?? [])).filter(
    (d) => !deps.includes(d),
  );

  // 2) 模块：按声明顺序保留（写进 nuxt.config.ts 的数组，顺序稳定即可）
  const modules = unique(picked.flatMap((p) => p.item.modules ?? []));

  // 3) 样式入口：先按槽位排序，同槽位保持声明顺序；base.css 永远在 base-css 槽
  const cssRaw = picked.flatMap((p) =>
    (p.item.css ?? []).map((c) => ({ path: c.path, slot: c.slot })),
  );
  cssRaw.push({ path: '~/assets/styles/base.css', slot: 'base-css' });
  const cssEntries = unique(
    cssRaw.sort((a, b) => slotRank(a.slot) - slotRank(b.slot)).map((c) => c.path),
  );

  // 4) 生成文件与「过期的生成文件」
  //    上一次可能选了别的方案，留下了这次不需要的生成文件；它们是常量路径，
  //    在白名单内的，可以安全删掉 —— 这是「可重复初始化」的前提。
  const generatedFiles = uniqueSorted(picked.flatMap((p) => p.item.files ?? []));
  const staleGenerated = generatedFilesAll.filter((f) => !generatedFiles.includes(f));

  // 5) 删除清单 = 引导器白名单 ∪ 过期的生成文件（**逐条枚举，无模式匹配**）
  const deleteFiles = uniqueSorted([...wizardFiles, ...staleGenerated]);

  // 6) 需要允许执行安装脚本的包
  const allowBuilds = uniqueSorted(picked.flatMap((p) => p.item.allowBuilds ?? []));

  return {
    lockfile,
    deps,
    devDeps,
    modules,
    cssEntries,
    sections: [...SECTION_KEYS, ...PACKAGE_SECTIONS, ...WORKSPACE_SECTIONS],
    deleteFiles,
    generatedFiles,
    generatedFilesAll: [...generatedFilesAll].sort(),
    keepFiles: [...keepFiles].sort(),
    allowBuilds,
    removeDeps: [],
    conflicts,
  };
}

/**
 * 一条龙：断言 → 归一化 → 规则 → 计划。
 * 服务端与引擎都走这个入口，保证两边行为完全一致。
 * 形状非法时抛错（调用方转 400），存在 block 冲突时也抛错并带上 conflicts（调用方转 422）。
 */
export function preparePlan(options, raw, input = {}) {
  assertShape(options, raw);
  const selection = normalizeSelection(options, raw);
  const conflicts = validateSelection(options, selection, {
    allowExperimental: Boolean(input.allowExperimental),
  });

  if (conflicts.some((c) => c.level === 'block')) {
    const err = new Error('选择存在阻断级冲突');
    err.code = 'BLOCKED';
    err.conflicts = conflicts;
    throw err;
  }

  return buildPlan(options, { ...input, selection, conflicts });
}

/* ------------------------------------------------------------------ *
 * 安装命令
 *
 * 为什么命令清单也要放在这个共享文件里，而不是各自拼字符串：
 * 同一份清单有三个消费者 ——
 *   ① 引导页的「依赖预览」要把它显示给用户（选之前就知道会跑什么命令）；
 *   ② 引擎的 install 阶段照它执行；
 *   ③ 校验（第 11 项）与 `--skip-install` 的提示要把它原样打出来给用户补跑。
 * 三处各拼一份的话，迟早出现「界面说 `pnpm add`、实际跑的是 `npm install --save`」。
 * ------------------------------------------------------------------ */

/** 包管理器可执行文件名 */
export function managerBin(plan) {
  return plan.lockfile === 'npm' ? 'npm' : 'pnpm';
}

/**
 * 安装阶段的步骤清单 —— 纯函数。
 *
 * 三条判据都在这里，且都与网络无关，因此可以被自测直接断言：
 *   · pnpm 用 `add` / npm 用 `install --save`；
 *   · devDeps 必须**分第二次**装（一次装完无法区分依赖类型，会全进 dependencies）；
 *   · 最后补一次裸 install，收敛 lockfile 与 hoisting，避免「本地能跑、CI 装出来不一样」。
 *
 * 空清单返回空数组：一个什么额外依赖都没选的方案，不该跑任何安装命令。
 */
export function installSteps(plan) {
  const bin = managerBin(plan);
  const isNpm = plan.lockfile === 'npm';
  const steps = [];

  if (plan.deps.length) {
    steps.push({
      kind: 'deps',
      label: `安装运行时依赖（${plan.deps.length} 个）`,
      args: isNpm ? ['install', '--save', ...plan.deps] : ['add', ...plan.deps],
    });
  }
  if (plan.devDeps.length) {
    steps.push({
      kind: 'devDeps',
      label: `安装开发依赖（${plan.devDeps.length} 个）`,
      args: isNpm ? ['install', '--save-dev', ...plan.devDeps] : ['add', '-D', ...plan.devDeps],
    });
  }
  if (!steps.length) return steps;

  steps.push({ kind: 'settle', label: '收敛 lockfile', args: ['install'] });
  return steps.map((step) => ({ ...step, bin, command: `${bin} ${step.args.join(' ')}` }));
}

/**
 * 可直接粘贴执行的多行命令 —— 给用户看的那一份。
 *
 * 存在意义：依赖的版本号由包管理器向 registry 解析后才写进 `package.json`，
 * 引擎自己不写版本。所以 `--skip-install` 之后 package.json 里**还没有**这批依赖，
 * 单纯跑一次 `pnpm install` 只会装 nuxt。必须把 `add` 那几条一并给出，
 * 否则用户会照着一句「自己装一下」白跑一趟。
 */
export function installCommands(plan) {
  const steps = installSteps(plan);
  if (!steps.length) return [];
  return steps.map((step) => step.command);
}
