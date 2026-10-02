/**
 * 前后端共享的**类型**（编译期擦除，无运行时逻辑）。
 *
 * 为什么放在 shared/ 而不是 app/utils/wizard/：
 * `app/utils/wizard/` 整个目录会随引导器一起删除。共享的**类型**放那里没问题
 * （类型在编译后不存在），但只要有实际逻辑，删除后就会留下断掉的 import。
 * 需要客户端与服务端都能用的运行时逻辑，一律放 `shared/`。
 */

export type Column = 'left' | 'right';
export type RuleLevel = 'block' | 'warn' | 'info';
/**
 * 分组的呈现形态。引擎不解释它的样式，只保证取值合法 —— 具体长什么样由前端决定。
 *
 * `radios`：横向单选按钮组（左右两栏的单选组都用它，候选左右相邻、差别一眼可比）
 * `checks`：复选行（模块、工程开关；多选，每项带一行说明，保持纵向）
 *
 * 只保留这两种是有意的：早先还有 `cards`（带标题与说明的纵向卡片）与 `select`（下拉），
 * 前者在横向排布下与 `radios` 重复，后者只有两个取值、不如直接摊开成单选按钮。
 * 留着没人使用的形态会让「实现」与「声明」对不上 —— selftest 的 A10 正是卡这条。
 */
export type RenderAs = 'radios' | 'checks';
/** 样式入口的槽位：决定它在 `css` 数组里的位置（顺序是唯一的硬约束）。 */
export type CssSlot = 'base' | 'tokens' | 'base-css' | 'ui';

export interface CssContribution {
  path: string;
  slot: CssSlot;
}

export interface OptionItem {
  value: string;
  label: string;
  desc: string;
  /** 卡片底部那一行小字：告诉用户「选了会装什么」 */
  note?: string;
  deps?: string[];
  devDeps?: string[];
  /** 需要写进 TEMPLATE:MODULES 区间的模块名 */
  modules?: string[];
  /**
   * 需要写进 TEMPLATE:MODULE_OPTIONS 区间的配置段原文（TS 片段，含尾逗号）。
   * 做成数据而不是引擎里的 switch：加一个带配置的模块只需要改 options.json。
   */
  config?: string;
  /** 需要引擎生成的文件（相对路径，常量） */
  files?: string[];
  /** 本选项贡献的样式入口 */
  css?: CssContribution[];
  /** 会阻止 npm 安装脚本执行的包，需要写进 pnpm-workspace.yaml 的 allowBuilds */
  allowBuilds?: string[];
  /** 需要注入 nuxt.config.ts 的 Vite 插件（import 行 + 使用表达式） */
  vitePlugin?: {
    import: string;
    use: string;
  };
  /** 标记为实验性：引导页禁用，只有 CLI 的 --force-experimental 能选它 */
  experimental?: boolean;
  /** 该选项对应的额外说明（实验性原因等） */
  experimentalReason?: string;
}

export interface OptionGroup {
  key: string;
  label: string;
  column: Column;
  multiple: boolean;
  renderAs: RenderAs;
  default: string | string[];
  desc?: string;
  options: OptionItem[];
}

export interface Rule {
  id: string;
  level: RuleLevel;
  /** 全部条件命中才算命中该规则；值是数组时表示「其中之一」 */
  when: Record<string, string | string[]>;
  message: string;
  /** 为真时，`--force-experimental` 可以让它失效 */
  experimental?: boolean;
}

export interface WizardSchema {
  version: string;
  groups: OptionGroup[];
  rules: Rule[];
}

/** 选择结果：单选组是字符串，多选组是字符串数组。 */
export type Selection = Record<string, string | string[]>;

export interface Conflict {
  level: RuleLevel;
  message: string;
  rule?: string | null;
}

/** 变更计划：字段少但每个都有用途（服务端预览与引擎执行共用同一份）。 */
export interface InitPlan {
  /** 归一化后的选择（已补默认值、已排序、已去重） */
  selection: Selection;
  lockfile: 'pnpm' | 'npm';
  deps: string[];
  devDeps: string[];
  modules: string[];
  cssEntries: string[];
  /** 需要写进 marker 区间的键名（供预览展示） */
  sections: string[];
  /** 白名单删除清单（引导器 + 不再需要的生成文件） */
  deleteFiles: string[];
  /** 引擎将生成的文件 */
  generatedFiles: string[];
  /** 明确保留的引导期文件 */
  keepFiles: string[];
  /** 需要允许执行安装脚本的包 */
  allowBuilds: string[];
  /** 需要从 package.json 移除的引导期依赖（当前为空集） */
  removeDeps: string[];
  conflicts: Conflict[];
}

/** 写入 template.config.json 的快照形状（「小票」，初始化后永久保留）。 */
export interface TemplateConfig {
  schemaVersion: string;
  templateVersion: string;
  initializedAt: string;
  selection: Selection;
  plan: {
    lockfile: 'pnpm' | 'npm';
    deps: string[];
    devDeps: string[];
    modules: string[];
    cssEntries: string[];
    allowBuilds: string[];
    /**
     * 下面四项是文档里那份最小形状的**超集**，用途是让快照自足：
     * 初始化之后 `server/utils/wizard/options.json` 已经被删掉，
     * `--check`、`--template-config` 与 verify.mjs 都必须能只靠这份「小票」工作。
     */
    /** 各 marker 区间的最终原文：--check 逐字节比对、--template-config 重放都靠它 */
    sections?: Record<string, string>;
    /** 本次实际删除的文件（含不再需要的过期生成文件） */
    deleteFiles?: string[];
    /** 本次实际生成的文件 */
    generatedFiles?: string[];
    /** **所有**选项可能生成的文件并集 —— 重放时的删除白名单，不依赖已删除的 options.json */
    generatedFilesAll?: string[];
  };
  removed: string[];
  kept: string[];
}
