# nuxt-shuttle

自举式 Nuxt 4 通用模板：**默认零依赖、纯 CSS 起步**，首次 `pnpm dev` 打开一个类似
Spring Initializr 的选择页，选完技术栈点「初始化项目」，模板会**删掉选择页的前后端、
改写配置、按选择装依赖**，交给你一份干净的普通 Nuxt 工程。

```
克隆 → pnpm install → pnpm dev → 网页上点选 → 初始化项目 → 得到自己的工程
```

## 为什么是「自举」而不是「生成器」

| | 外部 CLI 生成器 | 云端脚手架站 | 本模板（模板内自举） |
| --- | --- | --- | --- |
| 需要额外安装 | 是 | 否 | 否 |
| 选择界面 | 命令行问答 | 浏览器 | 浏览器（模板自带） |
| 产物里有生成器痕迹 | 无 | 无 | 无（引导器已自删） |
| 可离线 | 是 | 否 | 是 |
| 复杂度在哪 | 生成器 | 站点 | **一次性的、可预演可回滚的初始化过程** |

核心取舍：**把复杂度从「产物」挪到「初始化过程」**。产物回到一个任何人都能接手的
普通 Nuxt 工程，而复杂性集中在一次性的引擎里。

## 快速开始

```shell
# ① 装依赖（引导期只需要 nuxt）
pnpm install

# ② 起开发服务
pnpm dev
#    打开 http://localhost:3000 → 自动跳转到 /setup 选择页

# ③ 在页面上选技术栈 → 点「初始化项目」
#    跑完后按页面提示：pnpm dev 重启即可
```

只想看看会发生什么、不真的动文件：

```shell
node scripts/init.mjs --selection ./my-selection.json --dry-run
```

## 引导期目录

```text
nuxt-shuttle/
├─ app/
│  ├─ app.vue                        # 应用根（只有 NuxtLayout / NuxtPage）
│  ├─ pages/
│  │  ├─ index.vue                   # 引导期：重定向到 /setup
│  │  └─ setup/
│  │     ├─ index.vue                # 选择页（只负责「选」）
│  │     └─ progress.vue             # 初始化进度：独立整页（SSE / 轮询锁文件）
│  ├─ components/wizard/             # 引导期专用控件（初始化时整体删除）
│  ├─ assets/styles/
│  │  ├─ tokens.css                  # 令牌层（保留）
│  │  ├─ base.css                    # 基础层（保留）
│  │  └─ wizard.css                  # 选择页布局（初始化时删除）
│  └─ utils/wizard/                  # 类型与状态机（初始化时删除）
├─ server/
│  ├─ api/wizard/                    # schema / plan / init / status（初始化时删除）
│  ├─ utils/wizard/                  # options.json + 校验 + 安全闸（初始化时删除）
│  └─ plugins/                       # dev-only 令牌注入
├─ shared/                           # 前后端共享（保留）
├─ scripts/                          # 引擎（保留，可重跑可审计）
│  ├─ init.mjs                       # 初始化引擎（五阶段）
│  ├─ verify.mjs                     # 初始化后 12 项断言
│  ├─ selftest.mjs                   # 引擎自测（含变异测试）
│  ├─ matrix.mjs                     # 全矩阵 dry-run
│  ├─ gates.json / run-gates.mjs     # 门禁清单与运行器
│  └─ templates/                     # 初始化后要落盘的基线文件模板
├─ nuxt.config.ts                    # 含 4 个 marker 区间
└─ package.json                      # 含 1 个 marker 区间（scripts）
```

四个「区」决定引擎的删除边界：

| 区 | 路径 | 初始化后 |
| --- | --- | --- |
| 前端引导区 | `app/pages/setup/`、`app/components/wizard/`、`app/utils/wizard/` | 整个删除 |
| 服务端引导区 | `server/api/wizard/`、`server/utils/wizard/` | 整个删除 |
| 样式基线 | `tokens.css`、`base.css` | 保留 |
| 引擎区 | `scripts/` | 保留（可重跑、可审计） |

## 初始化做了什么（五阶段）

| 阶段 | 名称 | 输出 | 失败是否可继续 |
| --- | --- | --- | --- |
| 1 | `plan` | 变更计划（内存对象，不落盘） | ❌ 校验失败即退出，**不写任何文件** |
| 2 | `snapshot` | `.init-backup/<timestamp>/` 完整副本 + `manifest.json` | ❌ 快照不完整即退出 |
| 3 | `apply` | 引导器已删除、配置 marker 已改写、`template.config.json` + 锁文件已写 | ⚠️ 累积失败，最后统一报告 |
| 4 | `install` | `package.json` 依赖已更新、`node_modules` 已装、lockfile 已收敛 | ⚠️ 失败保留锁与快照 |
| 5 | `verify` | 12 项断言结果 + 人类可读报告 | ⚠️ 不自动回滚，由你决定 |

### marker 区间

配置文件从一开始就带 marker，让引擎知道「哪里可以写」：

| 文件 | 区间键 | 内容 |
| --- | --- | --- |
| `nuxt.config.ts` | `TEMPLATE:MODULES` | `modules: [...]` |
| `nuxt.config.ts` | `TEMPLATE:CSS` | `css: [...]` |
| `nuxt.config.ts` | `TEMPLATE:RUNTIME` | `runtimeConfig: {...}` |
| `nuxt.config.ts` | `TEMPLATE:TYPESCRIPT` | `typescript: {...}` |
| `package.json` | `TEMPLATE:SCRIPTS` | 生成的 npm scripts |

规则：marker 必须成对出现（缺一个引擎直接报错退出）；引擎**只替换两个 marker 之间的
全部内容**；区间之外的「手写区」逐字节不动。

## 样式入口顺序（唯一的硬约束）

```
① 原子化引擎的 base  ② tokens  ③ base  ④ UI 组件库样式  ⑤ 业务入口 main.css
```

CSS 的层叠只看加载顺序与选择器权重：原子化框架的 reset 必须在你的样式**之前**，
UI 组件库的样式必须在你的业务样式**之前**。这个顺序在所有主流组合里都成立，所以写死。

三条纯 CSS 纪律：不用 `!important`（唯一例外写在 `base.css` 的 reduced-motion 块里）、
不在组件里写行内 `style` 表达布局、`wizard.css` **不进**全局 `css` 数组。

## 安全：引导器是「能删文件能装依赖」的本地服务

五道闸依次收紧，缺任何一条，一个本地 HTTP 接口就是提权入口：

| # | 闸门 | 判据 |
| --- | --- | --- |
| 1 | 仅开发模式 | `import.meta.dev` 为真，生产构建里这些接口被 tree-shake |
| 2 | 仅本机访问 | 请求来源为 `127.0.0.1` / `::1` |
| 3 | 一次性令牌 | 页面加载时服务端生成并注入 HTML，请求需带同名 header |
| 4 | 单次初始化锁 | 存在 `template.init.lock` 时拒绝再次执行 |
| 5 | 无任意路径 | 所有路径来自 `options.json` 常量 + 引擎内置白名单 |

不要用「判断 referer」代替令牌 —— referer 可伪造，且在 `Referrer-Policy: no-referrer`
下为空。真正的判据是**服务端生成的、只出现在渲染结果里的一次性随机值**。

## 常用命令

```shell
pnpm dev                       # 开发（引导期访问 / 会跳到 /setup）
pnpm build                     # 生产构建
pnpm generate                  # 静态生成（SSG）

node scripts/init.mjs --selection ./sel.json --dry-run   # 预演，不写任何文件
node scripts/init.mjs --selection ./sel.json             # 真正执行
node scripts/init.mjs --check                            # 漂移检测（可挂 CI）
node scripts/init.mjs --rollback                         # 回到最近一次快照
node scripts/verify.mjs                                  # 12 项产物复核
node scripts/selftest.mjs                                # 引擎自测（含变异测试）
node scripts/matrix.mjs --dry-run-all                    # 176 种有效组合全矩阵（名义 240，阻断 64）
node scripts/run-gates.mjs --list                        # 打印门禁清单
```

七条门禁分两类，**跑法不同**：

| 门禁 | 前提 | 在哪跑 |
| --- | --- | --- |
| `matrix` / `engine-selftest` | 无 | 模板本体就能跑 |
| `verify` / `drift` | 有 `template.config.json` | 初始化后的产物仓库 |
| `lint` / `test` / `typecheck` | 初始化时选了对应工程开关 | 初始化后的产物仓库 |

在**模板本体**上直接跑会得到 5 条 `BLOCKED` —— 那是「没跑成」，不是「跑错了」：
本仓库没初始化过，自然没有快照，也没有那三个 npm 脚本。所以：

```shell
# 模板本体自检（只跑不依赖产物的两条）
node scripts/run-gates.mjs --skip verify,drift,lint,test,typecheck

# 产物仓库全量门禁
node scripts/run-gates.mjs
```

`--check` 是这套模板真正的长期价值：模板的价值不在初始化那一刻，而在**半年后**。
把它挂进 CI，任何对生成区的悄悄修改都会被拦住。

```yaml
# CI 里加一条（完整流水线见 docs 的「部署与上线」）
- run: node scripts/init.mjs --check
- run: node scripts/verify.mjs --fast
```

## 组合数与规则

三维（UI 5 × 预处理器 4 × 原子化 3）+ 渲染模式 4，名义 240 种；剔除被 `block` 规则
禁掉的 64 种（Nuxt UI + UnoCSS 16 种、Vuetify 实验性 48 种），**有效组合 176 种**，
由 `scripts/matrix.mjs` 全矩阵扫描（数字由脚本实时统计，不写死）。

规则分三层，**只有 `block` 会禁用提交**：`block` 会导致构建失败或运行冲突，
`warn` 能跑但有冗余或体积代价，`info` 是纯知识性说明。每条规则的文案都写清
「为什么冲突」与「怎么改」——只写「不能同时选」等于让用户猜。

## 环境要求

- Node.js **>= 22.12**（Nuxt 4.5 要求）
- pnpm **11.x**（或 npm；包管理器是选择项之一）

> pnpm 11 起不再读取 `package.json` 的 `pnpm` 字段，`allowBuilds` 等配置写在
> `pnpm-workspace.yaml`；`strictDepBuilds` 默认为真，需要跑安装脚本的包要显式允许。

## 已知边界

- **依赖安装是唯一无法逐字节复现的一步**：`pnpm add` 会写入当时的最新补丁版本。
  「同选择 + 同模板版本」在不同时间跑会有不同 lockfile。需要跨时间复现时，
  用 `--template-config` + 仓库里的 lockfile 一起重放。
- **回滚只回到最近一次快照**，且不卸载依赖（引擎会打印需要手动 `pnpm remove` 的命令）。
- 渲染模式（SSR/SPA/SSG/混合）在代码上只差一个开关，初始化后想改**不需要重跑引擎**，
  直接改 `nuxt.config.ts` 的手写区即可。

## License

MIT
