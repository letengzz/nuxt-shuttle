/**
 * POST /api/wizard/init —— 调度初始化引擎，以 SSE 推进度。
 *
 * 职责边界（本项目最需要注意的一个文件）：
 *   它**只做调度**。不删文件、不写配置、不拼路径、不拉 shell。
 *   所有副作用都在 scripts/init.mjs 里 —— 界面上能做的事，命令行必须能做，
 *   而且必须是同一条代码路径，否则「界面初始化」与「CLI 初始化」会慢慢分叉。
 */
import type { Selection } from '#shared/wizard/types';
import { assertWizardAllowed } from '../../utils/wizard/guard';
import { streamInit } from '../../utils/wizard/stream';
import { planSelection } from '../../utils/wizard/validate';

export default defineEventHandler(async (event) => {
  // 五道闸：dev → 本机 → 令牌 → 锁（缺一不可，顺序不能换）
  assertWizardAllowed(event);

  const body = await readBody<{ selection?: Selection }>(event);
  if (!body || body.selection === undefined) {
    throw createError({ statusCode: 400, statusMessage: '缺少 selection' });
  }

  // 与 /plan 用同一个函数校验：接口不再自己判断一次「能不能这么做」。
  // 这里传下去的是**归一化后**的选择，引擎即便不重复归一化也得到同一份输入。
  const { plan } = planSelection(body.selection);

  await streamInit(event, { selection: plan.selection });
});
