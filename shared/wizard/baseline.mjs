/**
 * 「覆盖区」清单 —— 初始化时需要被引擎**覆写**的文件（不是删除，也不是按选项生成）。
 *
 * 为什么需要这一区：
 * 引导期的 `app/pages/index.vue` 是一个「把人送到 /setup」的重定向页，
 * 初始化后 `/setup` 已经不存在，这个文件必须换成真正的首页。
 * 它既不属于「引导器白名单」（删掉它就没有首页了），也不属于「按选项生成」
 * （不管选了什么都要换），所以单独归一类。
 *
 * 对应地，README 里把文件分成四个区：
 *   删除区（WIZARD_FILES） / 生成区（options.json 的 files） / 覆盖区（本文件） / 保留区（KEEP_FILES）
 *
 * 覆盖是**幂等**的：模板内容固定，覆盖两次的结果逐字节相同。
 */

/** 模板目录：`scripts/templates/baseline/<相对路径>` → `<相对路径>` */
export const BASELINE_ROOT = 'scripts/templates/baseline';

/** 选项生成文件的模板目录：`scripts/templates/generated/<相对路径>` → `<相对路径>` */
export const GENERATED_ROOT = 'scripts/templates/generated';

/**
 * 需要被基线覆盖的相对路径。每一项都必须在 `BASELINE_ROOT` 下有同名模板。
 *
 * 只列两个文件，各有明确理由：
 *   · `app/pages/index.vue` —— 引导期它是「把人送到 /setup」的重定向页，必须换成真正的首页；
 *   · `server/api/health.get.ts` —— Dockerfile 的 HEALTHCHECK 要靠它，而引导期不需要它。
 *
 * 「能不覆盖就不覆盖」是这一区的纪律：每多列一个文件，就多一次覆盖用户改动的风险。
 * 引导期的 `app/app.vue`（`NuxtRouteAnnouncer` + `NuxtPage`）本身就已是产物的最终形态，
 * 所以不列 —— 它没有可覆盖的内容。
 */
export const BASELINE_TARGETS = [
  'app/pages/index.vue',
  'server/api/health.get.ts',
];

/** 模板文件的仓库内相对路径 */
export function baselineTemplatePath(rel) {
  return `${BASELINE_ROOT}/${rel}`;
}

/** 选项生成文件的模板路径 */
export function generatedTemplatePath(rel) {
  return `${GENERATED_ROOT}/${rel}`;
}
