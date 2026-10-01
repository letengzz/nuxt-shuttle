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

/** 引擎的五阶段，顺序即执行顺序。与 scripts/init.mjs 的阶段名一一对应。 */
export const STAGES = [
  { key: 'plan', label: '计算计划' },
  { key: 'snapshot', label: '备份快照' },
  { key: 'apply', label: '改写与自举' },
  { key: 'install', label: '安装依赖' },
  { key: 'verify', label: '校验产物' },
] as const;
