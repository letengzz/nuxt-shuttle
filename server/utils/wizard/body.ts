/**
 * 两个 POST 接口（/plan、/init）共用的请求体读取。
 *
 * 此前两处各写一份「body 里有没有 selection」的判断，而**体积上限**一处也没有：
 * `readBody` 会把请求体整个读进内存，本机任何进程（或一个手滑留下来的脚本）
 * 都能用一个大 body 把 dev 服务顶住。导出的 selection.json 最多几十 KB，
 * 一个正常选择序列化后不过一两百字节 —— 64 KB 的上限足够宽松，也足够拦下误用。
 *
 * 只做三件事，且都在落盘之前：
 *   ① content-length 超限直接 413，不读 body；
 *   ② 分块传输没有 content-length，解析后按序列化长度再兜一次；
 *   ③ 缺 selection 字段给 400（`{}` 合法 —— 全部取默认值，与缺字段是两回事）。
 *
 * 校验「选得对不对」不在这里：那是 shared/wizard/plan.mjs 的事，两个接口都调它。
 */
import type { H3Event } from 'h3';
import type { Selection } from '#shared/wizard/types';

/** 与选择页「导入选择文件」的 64 KB 上限对齐：同一个文件从哪条路进都该是同一个尺寸。 */
export const MAX_SELECTION_BODY_BYTES = 64 * 1024;

export async function readSelectionBody(event: H3Event): Promise<Selection> {
  const declared = Number(getHeader(event, 'content-length') ?? '');
  if (Number.isFinite(declared) && declared > MAX_SELECTION_BODY_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: 'Payload Too Large',
      message: `请求体 ${declared} 字节，超过 ${MAX_SELECTION_BODY_BYTES} 字节上限`,
    });
  }

  const body = await readBody<{ selection?: Selection } | null>(event);
  if (!body || body.selection === undefined) {
    throw createError({ statusCode: 400, statusMessage: '缺少 selection' });
  }

  // 分块传输（无 content-length）走这条兜底。序列化一次的成本远小于「放任大对象通过」。
  if (JSON.stringify(body.selection).length > MAX_SELECTION_BODY_BYTES) {
    throw createError({
      statusCode: 413,
      statusMessage: 'Payload Too Large',
      message: `selection 序列化后超过 ${MAX_SELECTION_BODY_BYTES} 字节上限`,
    });
  }

  return body.selection;
}
