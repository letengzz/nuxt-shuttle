/**
 * 引导器文件白名单 —— 初始化引擎与服务端**共用同一份**。
 *
 * 为什么不各写一份：
 * 服务端的 `--plan` 预览要告诉用户「将删除哪些文件」，引擎要真的删。两处各写一份
 * 清单，第一周没问题，第三周就会漂移成「预览说删 7 个、实际删 9 个」——
 * 而这恰好是本方案最需要透明的地方。
 *
 * 三条硬纪律：
 *   ① 每一项都是一个**具体相对路径**，绝不出现 `**` / `*` 这类模式匹配。
 *      模式匹配在有人往目录里放过一个文件时就会误伤。
 *   ② 删除前必须做「仓库内前缀校验 + 白名单全等校验」，两条缺一不可。
 *   ③ `.gitkeep` 这类占位文件不属于引导器，不要写进来。
 */

/** 引导期存在、初始化时必须删掉的文件（前端引导区 + 服务端引导区）。 */
export const WIZARD_FILES = [
  // 前端引导区
  'app/pages/setup/index.vue',
  'app/pages/setup/progress.vue',
  'app/components/wizard/OptionGroup.vue',
  'app/components/wizard/NuxtConfigPanel.vue',
  'app/components/wizard/ConflictHint.vue',
  'app/components/wizard/DependencyPreview.vue',
  'app/components/wizard/ProgressStream.vue',
  'app/components/wizard/ProgressActions.vue',
  'app/utils/wizard/option-model.ts',
  'app/utils/wizard/useWizard.ts',
  'app/assets/styles/wizard.css',
  // 服务端引导区
  'server/api/wizard/schema.get.ts',
  'server/api/wizard/plan.post.ts',
  'server/api/wizard/init.post.ts',
  'server/api/wizard/status.get.ts',
  'server/utils/wizard/options.json',
  'server/utils/wizard/validate.ts',
  'server/utils/wizard/guard.ts',
  'server/utils/wizard/stream.ts',
  // dev-only 的令牌注入插件：它的唯一作用是给选择页发令牌，页面没了它就没有意义
  'server/plugins/wizard-token.ts',
];

/**
 * 明确保留的引导期文件：初始化后必须还在（引擎与基线）。
 * verify.mjs 的第 3 项断言拿它做对照。
 */
export const KEEP_FILES = [
  // 引擎自身
  'scripts/init.mjs',
  'scripts/verify.mjs',
  'scripts/selftest.mjs',
  'scripts/matrix.mjs',
  'scripts/run-gates.mjs',
  'scripts/gates.json',
  // 引擎与校验器共用的子进程封装：删了它，`pnpm verify` 与 install 阶段都会立刻失败
  'scripts/lib/proc.mjs',
  // 共享层：引擎与服务端读同一份算法与白名单。删了它们，引擎就成了孤本，
  // 而「预览与执行一致」这条性质正是靠共用代码保证的。
  'shared/wizard/plan.mjs',
  'shared/wizard/sections.mjs',
  'shared/wizard/baseline.mjs',
  'shared/wizard/whitelist.mjs',
  'shared/wizard/types.ts',
  // 样式基线（初始化后仍然是产物的一部分）
  'app/assets/styles/tokens.css',
  'app/assets/styles/base.css',
  // 配置文件
  'nuxt.config.ts',
  'package.json',
  'pnpm-workspace.yaml',
  // 「覆盖区」的模板本体：留着才能重放与审计，也才说得清首页是从哪来的
  'scripts/templates/baseline/app/pages/index.vue',
  'scripts/templates/baseline/server/api/health.get.ts',
];

/**
 * 明确保留的**目录**（整棵子树都不属于引导器）。
 *
 * KEEP_FILES 是逐文件枚举，但模板目录是会长大的（加一个选项就要加一个模板），
 * 逐条往清单里补既容易漏、也没有意义 —— 这里给出一棵整树，
 * 引擎在任何删除动作前都会先检查「待删路径不在保留目录内」。
 */
export const KEEP_DIRS = [
  'scripts/templates',
];

/**
 * 删除后需要顺带清理的目录。
 *
 * 注意：清理逻辑**只能删「读起来是空的」目录** —— 用户完全可能往
 * `app/pages/setup/` 里临时放过一个草稿文件，递归删除会一起带走。
 * 这里列出候选，实际是否删除由 `readdirSync(dir).length === 0` 决定。
 */
export const PRUNE_DIRS = [
  'app/pages/setup',
  'app/components/wizard',
  'app/utils/wizard',
  'server/api/wizard',
  'server/utils/wizard',
  'server/plugins',
];

/** 白名单查表，供引擎与校验器共用。 */
export const WIZARD_FILE_SET = new Set(WIZARD_FILES);

/** 判断某个相对路径是否属于引导器（删除候选）。 */
export function isWizardFile(rel) {
  return WIZARD_FILE_SET.has(rel);
}

/**
 * 判断某个相对路径是否属于「保留区」。
 * 引擎在删除前会先问一次这个 —— 保留判定必须比删除判定更早生效，
 * 否则将来某次误把引擎自身写进删除清单，后果是不可逆的。
 */
export function isKeptPath(rel) {
  const normalized = rel.replaceAll('\\', '/');
  if (KEEP_FILES.includes(normalized)) return true;
  return KEEP_DIRS.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`));
}
