/**
 * /api/wizard/init 的调度器 —— 只做两件事：把选择交给引擎、把引擎的输出转给浏览器。
 *
 * 这个文件里**不允许出现任何文件系统改动**：删除、生成、改写全部由 `scripts/init.mjs` 完成。
 * 理由是「可复现 + 可审计」—— 界面上能做的事，命令行必须能做，而且必须是同一条代码路径。
 * 一旦接口自己动文件，就出现了第二条路径，从此「界面初始化」与「CLI 初始化」会慢慢分叉。
 *
 * 另一条纪律：**客户端断开不杀引擎。** 初始化在删除阶段被打断会留下半删状态，
 * 比「用户看不到进度」严重得多。断开后引擎继续跑，进度由锁文件承载，
 * 重新打开页面用 /api/wizard/status 就能看到它卡在哪一步。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { H3Event } from 'h3';
import type { Selection } from '#shared/wizard/types';

const ENGINE_RELATIVE = ['scripts', 'init.mjs'];

/** 兜底上限：安装阶段卡住时不能让连接与引擎一起悬着。 */
const MAX_RUNTIME_MS = 30 * 60 * 1000;

/** 心跳间隔。某些反向代理/IDE 端口转发在 30 秒静默后掐断连接，注释帧的成本可以忽略。 */
const HEARTBEAT_MS = 15_000;

/**
 * 把字节流切成行。
 *
 * 为什么不能直接 `chunk.split('\n')`：一个 JSON 行完全可能被 TCP 分片切成两半，
 * 那样会解析出两个残缺对象，前端拿到的是「日志乱码」而不是报错 —— 极难定位。
 */
function lineReader(onLine: (line: string) => void): (chunk: unknown) => void {
  let buffer = '';
  return (chunk: unknown) => {
    buffer += String(chunk);
    for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
      onLine(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
    }
  };
}

export async function streamInit(event: H3Event, { selection }: { selection: Selection }): Promise<void> {
  const root = process.cwd();
  const enginePath = join(root, ...ENGINE_RELATIVE);

  if (!existsSync(enginePath)) {
    throw createError({
      statusCode: 500,
      statusMessage: `找不到初始化引擎 ${ENGINE_RELATIVE.join('/')}，仓库可能已经被初始化过`,
    });
  }

  // 选择写进系统临时目录：仓库此刻正在被改写，不适合再往里放中间文件。
  const dir = await mkdtemp(join(tmpdir(), 'nuxt-shuttle-init-'));
  const selectionFile = join(dir, 'selection.json');
  await writeFile(selectionFile, JSON.stringify(selection, null, 2), 'utf8');

  const res = event.node.res;

  setResponseHeaders(event, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'connection': 'keep-alive',
    // 反向代理默认会缓冲响应体。缓冲会把「实时进度」变成「结束后一次性出现」，
    // 而那正好毁掉进度面板的全部意义。
    'x-accel-buffering': 'no',
  });
  // flushHeaders 之后 res.headersSent 为真，h3 便不会再尝试写第二个响应体。
  res.flushHeaders?.();

  const send = (payload: unknown): void => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch {
      // 客户端已断开。吞掉写入错误，**不**因此终止引擎。
    }
  };

  /** 引擎按 --json-lines 输出；非 JSON 行（引擎的兜底 console 输出）降级成 log 事件，不能让前端解析炸掉。 */
  const sendLine = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      send(JSON.parse(trimmed));
    } catch {
      send({ type: 'log', level: 'info', line: trimmed });
    }
  };

  // shell 为 false、参数走数组：deps 已在服务端过白名单，但任何用户可控值都不该经过 shell 解析。
  const child = spawn(process.execPath, [enginePath, '--selection', selectionFile, '--json-lines'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const stdoutReader = lineReader(sendLine);
  const stderrReader = lineReader((line) => {
    const trimmed = line.trim();
    if (trimmed) send({ type: 'log', level: 'error', line: trimmed });
  });

  child.stdout?.on('data', stdoutReader);
  child.stderr?.on('data', stderrReader);

  child.on('error', (err) => {
    send({ type: 'error', stage: 'spawn', message: `无法启动初始化引擎：${err.message}` });
  });

  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(': ping\n\n');
    } catch {
      // 断开即忽略
    }
  }, HEARTBEAT_MS);

  const timeout = setTimeout(() => {
    send({
      type: 'error',
      stage: 'timeout',
      message: `初始化超过 ${Math.round(MAX_RUNTIME_MS / 60_000)} 分钟仍未结束，已向引擎发送终止信号；请查看模板根目录的锁文件了解卡在哪一步`,
    });
    child.kill();
  }, MAX_RUNTIME_MS);

  await new Promise<void>((resolveStream) => {
    child.on('close', (code, signal) => {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      // 引擎可能在最后一行没有换行符，收尾时必须补一次
      stdoutReader('\n');
      send({ type: 'exit', code: code ?? -1, signal: signal ?? null });
      if (!res.writableEnded) res.end();
      resolveStream();
    });
  });
}
