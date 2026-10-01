/**
 * 选择校验 —— 服务端唯一入口。
 *
 * 这个文件**不重新实现**校验算法，而是把 `shared/wizard/plan.mjs` 包一层：
 * 预览（本文件）与执行（`scripts/init.mjs`）必须读同一份算法，否则
 * 「预览说删 7 个、实际删 9 个」这类漂移迟早出现 —— 而且它极难被发现，
 * 因为两边都「跑通了」。
 *
 * 本文件只加三件事：
 *   ① 读 options.json（纯函数不碰文件系统，数据由调用方传进去）；
 *   ② 把纯函数抛出的裸 Error 翻译成带位置信息的 HTTP 状态码；
 *   ③ 补上删除白名单与保留清单。
 */
import optionsJson from './options.json';
import { KEEP_FILES, WIZARD_FILES } from '#shared/wizard/whitelist.mjs';
import {
  assertShape,
  buildPlan,
  describeSelection,
  normalizeSelection,
  validateSelection,
} from '#shared/wizard/plan.mjs';
import type { Conflict, InitPlan, Selection, WizardSchema } from '#shared/wizard/types';

/** options.json 是唯一事实来源：前端选项、服务端校验、引擎执行都指向它。 */
export const wizardOptions = optionsJson as unknown as WizardSchema;

/** 回传前端所需的字段。不回传任何文件系统信息（绝对路径、磁盘状态都不需要）。 */
export function readSchema(): WizardSchema {
  return {
    version: wizardOptions.version,
    groups: wizardOptions.groups,
    rules: wizardOptions.rules,
  };
}

/** 补默认值 → 排序 → 去重。归一化必须在服务端做，否则产物的确定性就押在浏览器上了。 */
export function normalizeSelectionFor(raw: Selection): Selection {
  return normalizeSelection(wizardOptions, raw);
}

export interface PreparedPlan {
  plan: InitPlan;
  conflicts: Conflict[];
}

/**
 * 一条龙：断言形状 → 归一化 → 跑规则 → 出计划。
 *
 * 顺序是硬的。先归一化再断言，非法输入会被默认值「洗白」成合法组合，
 * 于是校验永远通过 —— 而这种 bug 的现场是「接口返回 200，产物却不对」。
 *
 * @param raw                来自请求体的原始选择（未经验证）
 * @param allowExperimental  只有 CLI 的 --force-experimental 会传 true；HTTP 接口永远传 false
 */
export function planSelection(raw: unknown, { allowExperimental = false } = {}): PreparedPlan {
  try {
    assertShape(wizardOptions, raw);
  } catch (err) {
    throw createError({
      statusCode: 400,
      statusMessage: '选择不合法',
      data: { reason: (err as Error).message },
    });
  }

  const selection = normalizeSelection(wizardOptions, raw);
  const conflicts = validateSelection(wizardOptions, selection, { allowExperimental }) as Conflict[];

  if (conflicts.some((c) => c.level === 'block')) {
    throw createError({
      statusCode: 422,
      statusMessage: '选择存在阻断级冲突',
      data: { conflicts },
    });
  }

  const plan = buildPlan(wizardOptions, {
    selection,
    wizardFiles: WIZARD_FILES,
    keepFiles: KEEP_FILES,
    lockfile: selection.manager as string,
    conflicts,
  }) as unknown as InitPlan;

  return { plan, conflicts };
}

/** 把选择拍平成一行可读签名，用于日志与 --check 的输出。 */
export function describe(selection: Selection): string {
  return describeSelection(wizardOptions, selection);
}
