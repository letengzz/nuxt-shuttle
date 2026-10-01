/**
 * 子进程封装 —— 初始化引擎（阶段 4 install）与校验脚本（第 12 项断言）共用。
 *
 * 为什么单独一个文件：
 * 两处都要「跑一条命令 → 把输出逐行转成事件 → 拿退出码 + 出错时看最后几行」。
 * 各写一份的话，Windows 的 `.cmd` 处理、超时、尾部输出采集迟早分叉，
 * 而分叉的症状是「install 阶段能跑、verify 说命令不存在」这种极难归因的问题。
 *
 * Windows 上 `pnpm` / `npm` 是 `.cmd` 脚本，而 `shell: false` 的 spawn 走 CreateProcess，
 * 不会自动补扩展名 —— 直接 `spawn('pnpm')` 会以 ENOENT 失败。官方推荐的绕法是经 cmd.exe 调用。
 *
 * 这不违反「参数数组、不经 shell 解析」那条纪律：命令名与参数都是常量，
 * 或来自已经在 plan.mjs 里过过白名单的值，并且是**逐项作为 argv** 传进 cmd.exe 的，
 * 全程没有任何字符串拼接，因此没有一个参数能被解释成第二条命令。
 */
import { spawn } from 'node:child_process';

/** 出错时保留的尾部输出行数：够看清原因，又不会把日志刷爆 */
export const TAIL_LINES = 20;

/** 把命令映射成「可执行的 argv」。Windows 上包一层 cmd.exe，其余平台原样返回。 */
export function spawnSpec(bin, args) {
  if (process.platform === 'win32') {
    return [process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', bin, ...args]];
  }
  return [bin, args];
}

/** 按 `\n` 切分流数据。最后一段没有换行的残余留在缓冲里，等下一次或收尾时再处理。 */
export function lineReader(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += String(chunk);
      for (let index = buffer.indexOf('\n'); index !== -1; index = buffer.indexOf('\n')) {
        onLine(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
      }
    },
    flush() {
      if (!buffer) return;
      onLine(buffer.replace(/\r$/, ''));
      buffer = '';
    },
  };
}

/**
 * 跑一条命令，等它结束。
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {object} [options]
 * @param {string} [options.cwd]        工作目录
 * @param {object} [options.out]        事件出口（`{emit}`），给了就逐行转发
 * @param {number} [options.timeoutMs]  超时上限；0 表示不限。超时会 kill 子进程
 * @param {string} [options.label]      事件里显示的命令行（默认按 bin + args 拼）
 * @returns {Promise<{code: number, spawnError?: string, timedOut?: boolean, tail: string[]}>}
 *
 * 注意：这里**不抛异常**。调用方要的是「退出码 + 尾部输出」这类可判定的结果，
 * 抛异常会逼着每一处都写 try/catch，最后总有一处忘了。
 */
export function runCommand(bin, args, options = {}) {
  const { cwd = process.cwd(), out = null, timeoutMs = 0, label = null } = options;

  return new Promise((resolvePromise) => {
    const [command, commandArgs] = spawnSpec(bin, args);
    const display = label ?? `${bin} ${args.join(' ')}`;
    const tail = [];

    if (out) out.emit({ type: 'log', level: 'info', line: `$ ${display}` });

    let child;
    try {
      child = spawn(command, commandArgs, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
    } catch (err) {
      if (out) out.emit({ type: 'log', level: 'error', line: `无法启动 ${display}：${err.message}` });
      resolvePromise({ code: -1, spawnError: err.message, tail });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(result);
    };

    const collect = (line) => {
      const trimmed = line.replace(/\s+$/, '');
      if (!trimmed) return;
      tail.push(trimmed);
      if (tail.length > TAIL_LINES) tail.shift();
      if (out) out.emit({ type: 'log', level: 'info', line: `  ${trimmed}` });
    };

    const stdout = lineReader(collect);
    const stderr = lineReader(collect);
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));

    child.on('error', (err) => {
      if (out) out.emit({ type: 'log', level: 'error', line: `无法启动 ${display}：${err.message}` });
      finish({ code: -1, spawnError: err.message, tail });
    });

    child.on('close', (code) => {
      stdout.flush();
      stderr.flush();
      finish({ code: code ?? -1, tail });
    });

    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        // 只 kill 直接子进程。Windows 上 cmd.exe 的后代可能残留 ——
        // 这是已知代价：与其为了回收干净而引入 taskkill 这类外部依赖，
        // 不如把超时设得足够宽松（默认 0 = 不限），让它几乎不会被触发。
        try {
          child.kill();
        } catch {
          /* 已经退出了 */
        }
        if (out) out.emit({ type: 'log', level: 'error', line: `${display} 超时（${Math.round(timeoutMs / 1000)} 秒），已终止` });
        finish({ code: -1, timedOut: true, tail });
      }, timeoutMs);
      // 计时器不该拖住进程退出
      if (typeof timer.unref === 'function') timer.unref();
    }
  });
}
