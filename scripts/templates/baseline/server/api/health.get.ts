/**
 * 健康检查接口。
 *
 * 存在的理由很具体：**Dockerfile 的 HEALTHCHECK 需要一个可访问的端点**。
 * 用首页代替它是不行的 —— 首页会渲染整棵组件树、可能查数据库，
 * 健康检查要回答的是「进程还活着吗」，不是「业务正常吗」。
 *
 * 保持零依赖：不查数据库、不读文件、不 await 任何东西。
 * 健康检查自己变成慢请求的源头，是最讽刺的一类故障。
 */
export default defineEventHandler(() => ({
  status: 'ok',
  uptime: Math.round(process.uptime()),
  // 只回一个短哈希而不是完整版本号：健康检查不应该成为信息泄露面
  build: (process.env.NUXT_BUILD_ID || 'dev').slice(0, 12),
}));
