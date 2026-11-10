/**
 * POST /api/wizard/plan —— 校验选择 + 计算变更计划。
 *
 * 这个接口存在的唯一理由：**让用户在点下按钮之前知道会发生什么**
 * （要删 7 个文件、要装 12 个依赖、要改 7 个配置区间）。
 *
 * 它不落盘、不改任何文件，因此没有锁的门槛 —— 初始化进行中依然可以调用，
 * 进度页要靠它来对比「引擎实际算出的计划」与「之前预览的计划」是否一致。
 */
import { assertWizardReadable } from '../../utils/wizard/guard';
// 读 body 与限体积是两条接口共用的，写在 body.ts 里，避免只有一条被补上上限。
import { readSelectionBody } from '../../utils/wizard/body';
import { planSelection } from '../../utils/wizard/validate';

export default defineEventHandler(async (event) => {
  assertWizardReadable(event);

  // selection 为 {} 是合法的：全部取默认值。缺字段与传空对象是两回事。
  const selection = await readSelectionBody(event);
  const { plan, conflicts } = planSelection(selection);
  return { plan, conflicts };
});
