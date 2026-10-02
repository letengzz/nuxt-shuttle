/**
 * marker 区间的**内容渲染** —— 引擎与服务端共用的纯数据/纯函数模块。
 *
 * 为什么不把这套映射塞进 options.json：
 * 区间内容最终是 **TypeScript 源码**（`ssr: true,`、`modules: [...]`）。把代码写成
 * JSON 字符串，既没有语法高亮也没有类型检查，改错一个引号要等构建才发现。
 * 放在 .mjs 里可以；放在 JSON 里则是在给未来的自己挖坑。
 *
 * 为什么单独成文件而不是写在 init.mjs 里：
 * init.mjs 的职责是「五阶段流水线」，区间渲染是纯函数。
 * 分开之后区间渲染可以被自测直接 import 调用，不需要真的去动文件系统。
 *
 * 与 `plan.mjs` 一样：无副作用、不引第三方包（可以 import 同目录的 sibling）。
 */
import { PACKAGE_SECTIONS, SECTION_KEYS, WORKSPACE_SECTIONS } from './plan.mjs';

/**
 * 哪些区间的内容需要缩进。
 *
 * 这个常量**不参与**改写：正文缩进一律取 marker 所在行的缩进（见 `rewriteSection`）。
 * 保留它只是因为 `renderNuxtSections` 的调用方偶尔想知道「这个区间的正文是顶格的吗」，
 * 而答案就是 IMPORTS（顶层 import 语句不能缩进）。
 */
export const TOP_LEVEL_SECTIONS = ['IMPORTS'];

export function isTopLevelSection(key) {
  return TOP_LEVEL_SECTIONS.includes(key);
}

/** 把选择还原成「被选中的选项条目」。与 plan.mjs 的 buildPlan 第 1 步同构。 */
export function pickedItems(options, selection) {
  const picked = [];
  for (const group of options.groups) {
    const raw = selection[group.key];
    const values = Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      const item = group.options.find((o) => o.value === value);
      if (item) picked.push({ group: group.key, value, item });
    }
  }
  return picked;
}

const q = (s) => `'${s}'`;

/**
 * 渲染模式 → TEMPLATE:RENDER 区间的原文。
 *
 * 每种模式产出的都是**能直接跑**的配置，不是占位符：SSG 给出 preset，
 * 混合给出两条最典型的 routeRules（首页预渲染 + 后台 SPA）。用户拿到手就能改。
 */
const RENDER_SECTIONS = {
  ssr: 'ssr: true,',
  spa: 'ssr: false,',
  ssg: ["ssr: true,", 'nitro: { preset: \'static\' },'].join('\n'),
  hybrid: [
    'ssr: true,',
    'routeRules: {',
    '  // 混合渲染：公开页面预渲染成静态，后台走 SPA。按你的实际路由调整。',
    "  '/': { prerender: true },",
    "  '/admin/**': { ssr: false },",
    '},',
  ].join('\n'),
};

const TYPESCRIPT_STRICT = [
  'typescript: {',
  '  strict: true,',
  '  tsConfig: {',
  '    compilerOptions: {',
  '      noUncheckedIndexedAccess: true,',
  '      noImplicitOverride: true,',
  '    },',
  '  },',
  '},',
].join('\n');

const TYPESCRIPT_DEFAULT = 'typescript: {},';

/**
 * runtimeConfig 是「稳定器」区间：它的内容不随选择变化，但引擎仍然重写它。
 * 目的是——如果有人在手写区之外把它删了，再跑一次引擎就能恢复，
 * 而 `--check` 也能立刻发现「这个区间的内容与快照不一致」。
 */
const RUNTIME_SECTION = [
  'runtimeConfig: {',
  '  public: {',
  "    appName: 'Nuxt Shuttle',",
  '  },',
  '},',
].join('\n');

/** 由选项声明推导的区间：样式入口顺序是唯一硬约束，这里不重排，直接用 plan 排好的结果。 */
function derivedSections(picked, plan) {
  const imports = picked.map((p) => p.item.vitePlugin?.import).filter(Boolean);
  const pluginUses = picked.map((p) => p.item.vitePlugin?.use).filter(Boolean);
  // 模块自己的配置段：按选项在 options.json 里的声明顺序拼接，空的行直接丢掉
  const configBlocks = picked
    .map((p) => p.item.config)
    .filter(Boolean);

  return {
    IMPORTS: imports.join('\n'),
    MODULES: `modules: [${plan.modules.map(q).join(', ')}],`,
    MODULE_OPTIONS: configBlocks.join('\n\n'),
    VITE: pluginUses.length
      ? ['vite: {', `  plugins: [${pluginUses.join(', ')}],`, '},'].join('\n')
      : 'vite: {},',
    CSS: `css: [${plan.cssEntries.map(q).join(', ')}],`,
    RUNTIME: RUNTIME_SECTION,
  };
}

/**
 * 渲染 nuxt.config.ts 的七个 marker 区间。
 *
 * @returns {{ [key: string]: string }} key 与 plan.mjs 的 SECTION_KEYS 一一对应
 */
export function renderNuxtSections(options, selection, plan) {
  const picked = pickedItems(options, selection);
  const derived = derivedSections(picked, plan);
  const values = new Set(picked.map((p) => p.value));

  return {
    ...derived,
    RENDER: RENDER_SECTIONS[selection.render] ?? RENDER_SECTIONS.ssr,
    TYPESCRIPT: values.has('ts-strict') ? TYPESCRIPT_STRICT : TYPESCRIPT_DEFAULT,
  };
}

/**
 * package.json 的 TEMPLATE:SCRIPTS 区间内容。
 *
 * 返回的是「带尾逗号的 JSON 行」而不是一个对象：这段文本要被**文本替换**进
 * package.json 的 marker 之间，替换完再整份 JSON.parse 复核 —— 见 init.mjs 的 applySection。
 */
export function renderPackageScripts(selection) {
  const values = new Set(Array.isArray(selection.engineering) ? selection.engineering : []);
  const lines = [];

  if (values.has('eslint')) {
    lines.push('"lint": "eslint .",');
    lines.push('"lint:fix": "eslint . --fix",');
  }
  // Stylelint 只对 Sass / Less 生效：它对 Stylus 的支持有限，选了也不给脚本，
  // 免得生成一个「跑起来一堆误报」的命令。
  if (selection.preprocessor === 'sass' || selection.preprocessor === 'less') {
    lines.push(`"lint:style": "stylelint \\"**/*.{css,${selection.preprocessor}}\\"",`);
  }
  if (values.has('test')) {
    lines.push('"test": "vitest run",');
    lines.push('"test:watch": "vitest",');
  }
  if (values.has('ts-strict')) {
    lines.push('"typecheck": "nuxt typecheck",');
  }
  return lines.join('\n');
}

/* ------------------------------------------------------------------------- *
 * 三份被改写的配置文件与它们的 marker 语法
 *
 * 三种文件的 marker 长得不一样，而这不是可以「统一一下」的地方：
 *   nuxt.config.ts     // >>> TEMPLATE:X            TS 行注释
 *   package.json       "// >>> TEMPLATE:X": "",     JSON 里必须是一个合法的字符串键
 *   pnpm-workspace.yaml # >>> TEMPLATE:X            YAML 行注释
 * 强求统一就得到处转义。这里把差异收在一张表里，改写逻辑只需要一份。
 * ------------------------------------------------------------------------- */

export const MARKER_FILES = ['nuxt.config.ts', 'package.json', 'pnpm-workspace.yaml'];

export const FILE_SECTION_KEYS = {
  'nuxt.config.ts': SECTION_KEYS,
  'package.json': PACKAGE_SECTIONS,
  'pnpm-workspace.yaml': WORKSPACE_SECTIONS,
};

export function markerBegin(file, key) {
  if (file === 'package.json') return `"// >>> TEMPLATE:${key}": "",`;
  if (file === 'pnpm-workspace.yaml') return `# >>> TEMPLATE:${key}`;
  return `// >>> TEMPLATE:${key}`;
}

export function markerEnd(file, key) {
  if (file === 'package.json') return `"// <<< TEMPLATE:${key}": ""`;
  if (file === 'pnpm-workspace.yaml') return `# <<< TEMPLATE:${key}`;
  return `// <<< TEMPLATE:${key}`;
}

/**
 * 区间正文每行的缩进由 `rewriteSection` 从 marker 所在行推导，这里不再有独立的取值函数。
 *
 * 这里踩过一次真实的坑：原先给 `package.json` 返回 `'  '`，但它的 marker 缩进是 4 格
 * （在 `"scripts": { }` 里面），于是写进去的正文比 marker 浅两格。JSON 不在乎空白，
 * `JSON.parse` 复核过得去，构建也照跑 —— 只有逐字节比对会发现「区间内容与快照不一致」，
 * 而那时人会先怀疑自己手工改过文件。
 *
 * 「缩进由 marker 行推导」之后，三种文件一套规则，没有第二处可以写错。
 */

/* ------------------------------------------------------------------------- *
 * marker 区间的文本手术
 *
 * 为什么这些函数不在 init.mjs 里：
 * 引擎要**改写**区间，校验器要**读回**区间、还要**抹掉**区间来比对「手写区有没有被动过」。
 * 两边共用同一套「区间边界算到哪一行」的规则，才不会出现「引擎写对了、校验器说不对」——
 * 那种红灯比没有校验更糟，因为它会让人去改本来正确的文件。
 * ------------------------------------------------------------------------- */

/** 某个 marker 在文本里出现的次数（成对性判据用） */
export function countMarker(text, marker) {
  let count = 0;
  for (let index = text.indexOf(marker); index !== -1; index = text.indexOf(marker, index + marker.length)) {
    count += 1;
  }
  return count;
}

/**
 * 这份文本用的是哪种行尾。
 *
 * 为什么必须显式问一次：`git` 在 Windows 上默认 `core.autocrlf=true`，检出时会把仓库里
 * 的 LF 全部换成 CRLF。若改写只用 `\n` 拼接，就会往一份 CRLF 文件里塞进一段 LF 行尾的
 * 区间 —— 文件变成**混合行尾**：编辑器看着正常、pnpm 也照读，但 `git diff` 会显示整段
 * 被改过，而且换台机器（autocrlf=false）就完全复现不出来。
 *
 * 本仓库真的踩过这条：门禁 B9 拿工作区里的 `pnpm-workspace.yaml` 与 LF 渲染基线逐字比，
 * 于是在任何 Windows 检出上都是红的，而两边打印出来一模一样 —— 差别全在不可见的 `\r`。
 *
 * 判据取「**出现过 `\r\n` 就整份按 CRLF 处理**」：宁可把区间统一成 CRLF，也不要混合。
 * 混合行尾是最糟的一种，因为它同时骗过编辑器和肉眼。
 */
export function detectEol(text) {
  return String(text ?? '').includes('\r\n') ? '\r\n' : '\n';
}

/**
 * 从**含缩进的行首**替换区间正文。
 *
 * 这是全项目最容易写错的一处，两层都要对：
 *
 * ① **接回点取行首**。如果从 marker 关键字的位置拼接，marker 之前的缩进会被保留一次、
 *    新正文又自带一层缩进，于是「跑一次正常、跑两次报错」—— 症状极具迷惑性：
 *    单次执行全绿，连跑两次 --check 立刻报红，CI 上表现为「第一次构建就失败」。
 *    所以这里显式取 `lastIndexOf('\n', begin) + 1` 作为接回点，并在 end 行之后原样接回尾部。
 *
 * ② **正文缩进 = marker 所在行的缩进**（`markerIndent`），不是另一个参数。
 *    早先的版本把缩进作为第四个参数传进来，结果 `package.json` 传了 2 格而 marker 在 4 格处，
 *    写出的正文与 marker 错位。JSON 不在乎空白所以一切照跑，只有逐字节比对会报
 *    「区间内容与快照不一致」。既然 marker 行上就写着正确答案，就不要给它第二个来源。
 */
export function rewriteSection(text, begin, end, body) {
  const b = text.indexOf(begin);
  const e = text.indexOf(end);
  if (b === -1 || e === -1) {
    throw new Error(`缺少 marker 区间（begin=${b === -1 ? '缺失' : '有'} end=${e === -1 ? '缺失' : '有'}）`);
  }
  if (text.indexOf(begin, b + begin.length) !== -1) {
    throw new Error('同名 marker 出现多次，无法确定替换范围');
  }
  if (e < b) throw new Error('marker 顺序颠倒：结束标记出现在开始标记之前');

  const lineStart = text.lastIndexOf('\n', b) + 1;
  const markerIndent = text.slice(lineStart, b);
  const endLineEnd = text.indexOf('\n', e + end.length);
  const head = text.slice(0, lineStart);
  const tail = endLineEnd === -1 ? '' : text.slice(endLineEnd + 1);
  // 区间的行尾跟随文件本身。head / tail 是原样切片、自带行尾，这里若写死 `\n`，
  // 整份文件就成「外面 CRLF、区间里 LF」的混合体 —— 见 `detectEol` 的注释。
  const eol = detectEol(text);

  const indented = body
    ? body.split('\n').map((line) => (line ? markerIndent + line : line)).join(eol)
    : '';
  const block = body
    ? `${markerIndent}${begin}${eol}${indented}${eol}${markerIndent}${end}`
    : `${markerIndent}${begin}${eol}${markerIndent}${end}`;

  return `${head}${block}${eol}${tail}`;
}

/**
 * 读出区间正文，去掉统一缩进 —— 供 `--check` 与 `verify` 比对。
 *
 * **行尾一律归一成 LF** 再返回：调用方拿到它就要与 `renderSections` 生成的基线
 * （永远是 LF）逐字比，而磁盘上的文件可能是 CRLF（Windows 检出、或用户编辑器
 * 统一过行尾）。不归一的话，比对结果就取决于「这台机器是怎么检出的」——
 * 同一份内容在 LF 机器上绿、在 CRLF 机器上红，而且两边打印出来一模一样。
 */
export function readSection(text, begin, end) {
  const b = text.indexOf(begin);
  const e = text.indexOf(end);
  if (b === -1 || e === -1 || e < b) return null;

  const bodyStart = text.indexOf('\n', b);
  if (bodyStart === -1) return null;
  const bodyEnd = text.lastIndexOf('\n', e);
  if (bodyEnd <= bodyStart) return '';

  const indent = text.slice(text.lastIndexOf('\n', b) + 1, b);
  const lines = text
    .slice(bodyStart + 1, bodyEnd)
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (!indent) return lines.join('\n');
  return lines
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line))
    .join('\n');
}

/**
 * 抹掉区间占用的**整行**（连 marker 行一起删）。
 *
 * 只有一个用途：判断「手写区是否与初始化前一模一样」。
 * 两侧做同一套抹除后，剩下的文本逐字节相同 ⟺ 区间之外没人动过 ——
 * 这是第 9 项断言唯一能绕开「marker 内容本来就该变」这个干扰的判据。
 *
 * 只对 `nuxt.config.ts` 使用：`package.json` 的 marker 行自带逗号，
 * 抹掉后剩下的 JSON 不再合法 —— 文本比对仍然有效，但别在结果上调用 JSON.parse。
 */
export function blankSections(text, file) {
  const keys = FILE_SECTION_KEYS[file] ?? [];
  let out = text;
  for (const key of keys) {
    const begin = markerBegin(file, key);
    const end = markerEnd(file, key);
    const b = out.indexOf(begin);
    if (b === -1) continue;
    const e = out.indexOf(end, b);
    if (e === -1) continue;
    const from = out.lastIndexOf('\n', b) + 1;
    const endLine = out.indexOf('\n', e + end.length);
    const to = endLine === -1 ? out.length : endLine + 1;
    out = out.slice(0, from) + out.slice(to);
  }
  return out;
}

/**
 * 模板级决策：依赖闭包里**带安装脚本**的包，逐条给出「跑不跑脚本」。
 *
 * 为什么这是必需项而不是优化项：pnpm 11 的 `strictDepBuilds` 默认为真 ——
 * 没在 `allowBuilds` 里出现过的包一律算「未经审查」，`pnpm install` 直接以
 * `ERR_PNPM_IGNORED_BUILDS` 退出。少列一个，整个安装就走不到头，而那条错误
 * 原文只报包名，不会提「你该往哪写一行」。
 *
 * 三条都取 false，理由相同：它们的安装脚本只做一件事 —— 校验并落位已经由
 * `optionalDependencies` 装好的平台二进制（`@parcel/watcher-win32-x64`、
 * `@esbuild/win32-x64`、`@unrs/resolver-binding-*`）。再跑一遍没有收益，
 * 在离线或受限网络下反而会失败。
 *
 * 这份清单是对一棵**装全 5224 个包**的树逐份读 `package.json` 扫出来的，不是猜的：
 * 整个闭包里只有这三个带 `preinstall` / `install` / `postinstall`。
 * 复核方式：`pnpm ignored-builds`（pnpm 11.20+），或在安装失败时读错误里那句
 * `Ignored build scripts:`。
 *
 * 另：`allowBuilds` 的键是包名，**作用域包名以 `@` 开头在 YAML 里必须加引号**，
 * 裸写会被解析器拒绝。字符串里带引号是为了让拼出来的 YAML 合法，别照抄进 JS。
 */
const REVIEWED_ALLOW_BUILDS = [
  "'@parcel/watcher': false",
  'esbuild: false',
  'unrs-resolver: false',
];

/** 三个文件里所有需要改写的区间内容。返回形状：{ [文件]: { [键]: 内容 } }。 */
export function renderSections(options, selection, plan) {
  // 排序只为「同样的选择渲染出同样的文件」—— 顺序稳定，diff 才读得懂。
  const allowBuilds = [
    ...REVIEWED_ALLOW_BUILDS,
    ...plan.allowBuilds.map((name) => `${name}: true`),
  ].sort();

  return {
    'nuxt.config.ts': renderNuxtSections(options, selection, plan),
    'package.json': { SCRIPTS: renderPackageScripts(selection) },
    'pnpm-workspace.yaml': {
      ALLOW_BUILDS: ['allowBuilds:', ...allowBuilds.map((line) => `  ${line}`)].join('\n'),
    },
  };
}

/* ------------------------------------------------------------------------- *
 * 模板文件的占位符替换
 *
 * 模板（`scripts/templates/**`）里可以写 `{{var}}`。这是能力是必要的：
 * 同一个 `stylelint.config.mjs` 要被 Sass 与 Less 两个选项共用，而两者的
 * `extends` 不同；`Dockerfile` 要知道 Node 大版本与包管理器。
 * 没有这一层，就只能为「Sass 版 stylelint 配置」和「Less 版 stylelint 配置」
 * 各写一个几乎相同的文件 —— 那才是真正的重复。
 *
 * 两条纪律：
 *   ① 替换后若还有 `{{...}}` 残留，**必须报错**，不能静默产出带占位符的文件。
 *      静默的表现是「构建成功、产物里躺着一行 {{stylelintExtends}}」。
 *   ② 未声明的占位符不会被替换成空串 —— 空的 `extends: []` 是合法 JSON 但语义错误。
 *
 * 另有第三条，关于语法撞车：
 *   `{{ }}` 同时也是 **Vue 的插值语法**。模板文件里写 `<h1>{{ appName }}</h1>`
 *   意指运行时插值，而 `renderTemplate` 会把它当成占位符去替换。
 *   所以：**生成区（`generated/`）里不允许出现 .vue 文件** ——
 *   .vue 一律走覆盖区（baseline，原样复制、不做替换）。
 *   见 `assertRenderableTemplate`。
 * ------------------------------------------------------------------------- */

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

/**
 * 拒绝把「含 Vue 插值的文件」交给占位符替换。
 *
 * 不用「替换时跳过看起来像插值的写法」这种聪明办法：`{{ appName }}` 与
 * `{{appName}}` 在正则眼里毫无区别，跳过规则一旦写错就会**静默**留下原样的
 * `{{...}}`，而构建照样成功。直接禁止这一类文件进入生成区，问题就不存在了。
 */
export function assertRenderableTemplate(rel) {
  if (rel.toLowerCase().endsWith('.vue')) {
    throw new Error(
      `生成区不允许使用 .vue 模板：${rel}。`
      + '{{ }} 同时是 Vue 的插值语法，会被占位符替换误伤；'
      + '需要按选项生成 .vue 时，请把它放进 scripts/templates/baseline/ 走覆盖区（原样复制）。',
    );
  }
}

/**
 * @returns {{ text: string, missing: string[] }} missing 非空时调用方必须失败
 */
export function renderTemplate(text, vars) {
  const missing = new Set();
  const out = text.replace(PLACEHOLDER, (raw, key) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) {
      missing.add(key);
      return raw;
    }
    return String(vars[key]);
  });
  return { text: out, missing: [...missing] };
}

/** 模板里可用的变量。都是「方案本身决定的事实」，不含时间戳（否则产物不可复现）。 */
export function buildTemplateVars(selection, plan) {
  const preprocessor = selection.preprocessor;
  const stylelintExtends = preprocessor === 'sass'
    ? 'stylelint-config-standard-scss'
    : preprocessor === 'less'
      ? 'stylelint-config-standard-less'
      : null;
  const isNpm = plan.lockfile === 'npm';

  return {
    manager: plan.lockfile,
    nodeMajor: String(process.versions.node.split('.')[0]),
    preprocessor: String(preprocessor),
    /** 预处理器对应的样式语言：供 lint 配置等使用 */
    styleLang: preprocessor === 'none' ? 'css' : String(preprocessor),
    /** 逗号分隔时带引号的形态，可直接插进 JS 数组字面量；未选预处理器时为空 */
    stylelintExtends: stylelintExtends ? `'${stylelintExtends}',` : '',
    /** Dockerfile 用：要一起拷进镜像的锁定文件 */
    copyLockfile: isNpm ? 'package-lock.json' : 'pnpm-lock.yaml',
    /** Dockerfile 用：要一起拷进镜像的配置文件（顺序无关） */
    copyConfigFiles: 'pnpm-workspace.yaml .npmrc',
    /**
     * Dockerfile 用的完整安装命令（含 corepack）。
     * 做成一个变量而不是在模板里写 if：模板语言一旦支持条件，就会长出分支逻辑，
     * 而那些分支无法被模板级校验覆盖。把差异收敛到变量里，模板永远只有一种形状。
     */
    installCmd: isNpm ? 'npm ci' : 'corepack enable && pnpm install --frozen-lockfile',
    /** 运行脚本的前缀：pnpm build / npm run build */
    runCmd: isNpm ? 'npm run' : 'pnpm',
  };
}
