/**
 * GET /api/wizard/schema —— 只读候选清单。
 *
 * 回传整份规则，前端才能做即时提示（选了 Nuxt UI + UnoCSS 立刻标红）。
 * 但前端**不承担校验责任**：它只是提前告诉用户，最终判据永远在服务端。
 *
 * 不回传任何文件系统信息：引导页不需要知道仓库绝对路径与磁盘状态，回传只会扩大攻击面。
 */
import { assertWizardReadable } from '../../utils/wizard/guard';
import { readSchema } from '../../utils/wizard/validate';

export default defineEventHandler((event) => {
  assertWizardReadable(event);
  // 清单内容跟随 options.json 变化（引导期改配置是常态），不缓存。
  setResponseHeader(event, 'cache-control', 'no-store');
  return readSchema();
});
