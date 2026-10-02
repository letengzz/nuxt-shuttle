/**
 * dev-only：生成进程级令牌，并把它注入到引导页的 HTML 里。
 *
 * 为什么走 HTML 注入而不是「前端先请求一个 /token 接口」：
 * 令牌的价值是「跨站页面拿不到」。请求接口的方式要靠 CORS 不返回响应头来挡，
 * 挡得住 `fetch`，却挡不住「同源内被注入的恶意 script」。
 * 而注入到渲染结果里，读得到它的只有真正渲染了这个页面的人 —— 攻击者读不到我们的响应体。
 *
 * 钩子选 `render:html` 而不是 Nitropack 文档里的 `render:response`：
 * 后者在 Nuxt 的渲染路径上**不会触发**（Nuxt 用自己的 renderer，
 * 见 @nuxt/nitro-server/dist/runtime/handlers/renderer.mjs 里的 `render:html` 调用）。
 * 写错钩子的表现是「不报错、也没有令牌」，是最难查的一类问题。
 */
import { issueWizardToken } from '../utils/wizard/guard';

/**
 * 需要注入令牌的路径：引导页本身、进度页，以及会把它重定向过来的首页。
 *
 * 进度页必须在列 —— 它是一整页，可以被**刷新、收藏、在另一个标签页里打开**，
 * 而令牌只随 HTML 下发：整页加载拿不到它，那一页就只剩一串 403，
 * 「刷新也能看到进度」这条承诺当场失效。
 *
 * 为什么以前没暴露：从 /setup 点过去是**客户端跳转**，令牌已经在 window 上了，
 * 于是只测「点按钮那条路」永远碰不到这个缺口。是 CDP 那条「直接敲 URL」的用例抓出来的。
 */
const WIZARD_PATHS = new Set(['/', '/setup', '/setup/', '/setup/progress', '/setup/progress/']);

export default defineNitroPlugin((nitroApp) => {
  // 生产构建里这一行会被静态求值为 false，整个插件被压缩掉
  if (!import.meta.dev) return;

  const token = issueWizardToken();

  nitroApp.hooks.hook('render:html', (html, { event }) => {
    const path = (event.path || '/').split('?')[0];
    if (!WIZARD_PATHS.has(path)) return;

    // 必须是字面 JSON（`{"wizardToken":"..."}`）而不是 payload 里的展开值：
    // 验收脚本用 `grep -o 'wizardToken":"[^"]*'` 从 HTML 里取它，
    // 走 devalue 序列化的 __NUXT_DATA__ 是数组形式，抓不到。
    const config = JSON.stringify({
      wizardToken: token,
      apiBase: '/api/wizard',
      dev: true,
    });

    html.head.push(`<script>window.__WIZARD__=${config}</script>`);
  });
});
