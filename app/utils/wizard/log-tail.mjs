/**
 * 轮询日志尾部的增量合并 —— 纯函数、零 import、无副作用。
 *
 * 为什么需要它：进度页在「刷新重进」的场景下靠每 2 秒查一次 /status 拿日志尾部。
 * 引擎的日志文件只追加，尾部窗口只会「往后滑」，但此前的实现是**整段重建**：
 * 每轮给全部行重新分配 id，于是 400～800 个 <p> 的 key 全部换新，Vue 只能整段丢弃重建。
 * 初始化动辄十几分钟、安装阶段每秒都在吐字 —— 那种开销与「只多了一行」完全不成比例。
 *
 * 这里只回答一个问题：**这一轮的尾部里，前多少行是上一轮已经见过的？**
 * 调用方拿 reuse 决定「复用已有节点、只给新增行发号」，或者（断点、日志文件被替换时）
 * 老实整段重建。判定只依赖「日志只追加」这一条性质，不猜内容语义 ——
 * 所以哪怕上一轮与这一轮毫无关系，结果也只是退回重建，不会张冠李戴。
 *
 * 为什么要做成独立模块而不是塞在 useWizard.ts 里：自测可以直接 import 它、
 * 用真实样本跑（见 selftest A20），而不必为了可测性把逻辑复制一份到测试里 ——
 * 复制出来的那份再绿，也证明不了页面上跑的那份是对的。
 */

/**
 * @param {string[]} prev 上一轮 /status 返回的日志尾部（原始 JSON 事件行）
 * @param {string[]} next 这一轮返回的日志尾部
 * @returns {{ reuse: number, added: string[] }} reuse = next 开头已被 prev 覆盖的行数；
 *   added = 需要新追加的行。reuse === next.length 表示尾部没有任何变化。
 */
export function mergeLogTail(prev, next) {
  const incoming = Array.isArray(next) ? next : [];
  const existing = Array.isArray(prev) ? prev : [];
  if (!incoming.length) return { reuse: 0, added: [] };
  if (!existing.length) return { reuse: 0, added: incoming.slice() };

  // next 的首行必然出现在 prev 里（日志只追加）——除非日志文件被替换过。
  // 取最后一次出现：窗口滑动时，越靠后的位置越可能是真正的接缝。
  const start = existing.lastIndexOf(incoming[0]);
  if (start === -1) return { reuse: 0, added: incoming.slice() };

  // 光看首行不够：完全可能出现「首行撞上了、后面接的根本不是同一段」。
  // 逐行核对到较短的一侧为止；有一行对不上就整段重建，绝不带病复用。
  const overlap = Math.min(existing.length - start, incoming.length);
  for (let i = 0; i < overlap; i++) {
    if (existing[start + i] !== incoming[i]) return { reuse: 0, added: incoming.slice() };
  }
  return { reuse: overlap, added: incoming.slice(overlap) };
}
