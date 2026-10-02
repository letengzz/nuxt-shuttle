/**
 * 引导页的类型入口。
 *
 * 这里只放**类型与常量**，不放运行时逻辑 —— 整个 `app/utils/wizard/` 目录
 * 会在初始化时随引导器一起删除。类型在编译后被擦除，常量只被同样会被删除的
 * 组件引用，所以都安全；但一旦这里出现「被存活文件引用的函数」，
 * 删除后就会留下断掉的 import（这类错误要等下一次构建才暴露）。
 *
 * 真正的定义在 `shared/wizard/types.ts`：那是客户端与服务端共用的唯一来源，
 * 在这里重写一份定义，等于给自己埋一个「两边字段名悄悄不一致」的坑。
 */
export type {
  Column,
  Conflict,
  CssContribution,
  CssSlot,
  InitPlan,
  OptionGroup,
  OptionItem,
  RenderAs,
  Rule,
  RuleLevel,
  Selection,
  TemplateConfig,
  WizardSchema,
} from '#shared/wizard/types';

/**
 * 引擎的五阶段，顺序即执行顺序。与 scripts/init.mjs 的阶段名一一对应。
 *
 * **「安装依赖」在「改写与自举」之前**：改写那一步才把选中的模块写进 nuxt.config.ts，
 * 而页面本身就跑在 nuxt dev 里 —— 配置一变 dev 服务就重启去加载模块，那时它们必须已经装好。
 * 反过来会报 NUXT_B8017（模块加载不到）；且安装失败时「还没动过仓库」，
 * 用户可以直接重试，不必先回滚。
 */
export const STAGES = [
  { key: 'plan', label: '计算计划' },
  { key: 'snapshot', label: '备份快照' },
  { key: 'install', label: '安装依赖' },
  { key: 'apply', label: '改写与自举' },
  { key: 'verify', label: '校验产物' },
] as const;
