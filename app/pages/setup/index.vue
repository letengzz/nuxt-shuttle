<script setup lang="ts">
/**
 * 选择页：两栏 + 底部吸附区（左技术栈 / 右 Nuxt 配置 / 底「冲突提示 + 操作条」）。
 *
 * 六条刻意的设计：
 * ① 首次绘制一定是**骨架态**。令牌要从 window.__WIZARD__ 读、选择要从 localStorage 与
 *    URL 读，这些只有浏览器里才有。与其在服务端渲染一份「猜的」默认值再水合时改掉
 *    （那会带来水合不一致），不如先显示骨架，挂载后再拉数据。
 * ② 「初始化项目」是**两步确认**：第一次点击只算计划并弹出预览，第二次才真的开始。
 *    从点下按钮到结束，中间会删文件、装依赖 —— 值得多一次点击。
 * ③ 预览是**弹窗**而不是常驻面板：它是一次性核对，不是要一直盯着的配置；
 *    常驻会把右栏那些真正要反复调的控件挤下去。
 * ④ 页面上只留页首这一句说明。六个分组各自的说明（group.desc）不再渲染 ——
 *    它们与卡片标题讲的是同一件事，撤掉之后两栏才分得出「栏目 → 卡片」两层。
 *    分组说明本身没丢：悬停候选项、打开「新增」弹窗都还能看到。
 * ⑤ 底部吸附区（冲突提示 + 操作条）**不随上方内容滚动**。用的不是 position:fixed ——
 *    那样得给页面预留一段只能靠估算的空白（操作条的文字一换行对不上，就会盖住卡片）；
 *    而是「外壳固定一屏高 + 内容层自己滚」，吸附区有多高都不影响它是否真的贴底。
 * ⑥ **进度不在这里渲染**。这一页只负责「选」，跑起来之后整页交给 /setup/progress；
 *    两页共用 useWizard 的同一份模块级状态，所以判断「谁该出场」不看本地 status，
 *    而看磁盘上的锁文件（见 shouldShowProgress）—— 否则两页会互相弹。
 */
import type { Selection } from '~/utils/wizard/option-model';
import { useWizard } from '~/utils/wizard/useWizard';
import ConflictHint from '~/components/wizard/ConflictHint.vue';
import DependencyPreview from '~/components/wizard/DependencyPreview.vue';
import NuxtConfigPanel from '~/components/wizard/NuxtConfigPanel.vue';
import OptionGroup from '~/components/wizard/OptionGroup.vue';
// 引导期样式随页面一起删除：在页面里 import，删页面时引用一起消失，不用去改 nuxt.config.ts
import '~/assets/styles/wizard.css';

const wizard = useWizard();
const { state, blockedFor, blockConflicts, warnConflicts, infoConflicts, canStart, canPreview } = wizard;

/**
 * 「该去进度页了」—— 判据取 /api/wizard/status 的原样结果，不取本地 status。
 *
 * 为什么不用 `state.status`：候选清单读取失败时它也会变成 'failed'（见 useWizard.load），
 * 拿它当判据会把一个「连清单都没读到的选择页」送去进度页；而进度页看同一份理由，
 * 又会判成「没有初始化在跑」把用户弹回来 —— 两页来回弹，谁也到不了终端态。
 *
 * 为什么是 `locked && processAlive` 而不是只看 `locked`：**残锁**（进程已退出、锁没清）
 * 意味着上一次初始化没跑完。那个状态该留在进度页看失败原因，而不是每次打开选择页都被
 * 甩过去 —— 否则进度页那个「返回并重试」会变成跳过去又被弹回来。两条判据的不对称是
 * 刻意的：这里会送过去的情形，进度页一定接得住。
 */
const shouldShowProgress = computed(() =>
  Boolean(state.remote?.locked && state.remote?.processAlive) || state.remote?.initialized === true);

/**
 * 挂载后再拉数据：令牌来自 window.__WIZARD__、选择来自 localStorage 与 URL，
 * 这些服务端都没有（见文件头 ①）。在这之前页面就是骨架态。
 *
 * 这里用 attach() 而不是只 load()：它顺带读一次锁文件状态 ——
 * 于是「跑到一半刷新 /setup」会被立刻分流到进度页，而不是停在一个看似无人操作的选择页。
 */
onMounted(async () => {
  await wizard.attach();
  if (shouldShowProgress.value) await navigateTo('/setup/progress');
});

/** 展示顺序固定：阻断 → 提醒 → 说明。先看到「不能提交的原因」，再看建议。 */
const orderedConflicts = computed(() => [
  ...blockConflicts.value,
  ...warnConflicts.value,
  ...infoConflicts.value,
]);

const leftGroups = computed(() => state.schema?.groups.filter((group) => group.column === 'left') ?? []);
const rightGroups = computed(() => state.schema?.groups.filter((group) => group.column === 'right') ?? []);
const loading = computed(() => !state.schema);

const previewOpen = ref(false);

/**
 * 复制分享链接。URL 的 query 本来就承载着完整选择（见 useWizard.syncQuery），
 * 所以「分享技术栈」不需要新接口，把当前链接发出去即可。
 * 反馈只亮 2.5 秒：按钮文案回位，避免「已复制」变成一个永久状态。
 */
const shareState = ref<'idle' | 'copied' | 'failed'>('idle');
let shareTimer: ReturnType<typeof setTimeout> | null = null;

/** 导入反馈：成功/失败都只亮几秒，不变成一条永久横幅。 */
const importState = ref<'idle' | 'ok' | 'failed'>('idle');
const importMessage = ref('');
let importTimer: ReturnType<typeof setTimeout> | null = null;
const fileInput = ref<HTMLInputElement | null>(null);

function showImportResult(ok: boolean, message: string): void {
  importState.value = ok ? 'ok' : 'failed';
  importMessage.value = message;
  if (importTimer) clearTimeout(importTimer);
  importTimer = setTimeout(() => {
    importState.value = 'idle';
    importMessage.value = '';
    importTimer = null;
  }, 4000);
}

async function copyShareLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(wizard.shareUrl.value);
    shareState.value = 'copied';
  } catch {
    // 剪贴板权限被拒（localhost 是安全上下文，正常走不到）：指条手动路，别留死按钮
    shareState.value = 'failed';
  }
  if (shareTimer) clearTimeout(shareTimer);
  shareTimer = setTimeout(() => {
    shareState.value = 'idle';
    shareTimer = null;
  }, 2500);
}

onBeforeUnmount(() => {
  if (shareTimer) clearTimeout(shareTimer);
  if (importTimer) clearTimeout(importTimer);
});

/** 清单加载失败后的重试入口（用具名函数而不是内联 wizard.load()，职责更清楚） */
function reloadSchema(): void {
  void wizard.load();
}

/**
 * 把当前选择导出成 selection.json。
 *
 * 引擎的 --selection 参数吃的就是这份裸 Selection 对象（与引导器接口写盘的
 * 格式一致），所以导出后可以直接离线重放：
 *   node scripts/init.mjs --selection selection.json --dry-run
 * 适用场景：把技术栈决定存档、发给不便于开 dev 服务的同事、
 * 或在自动化脚本里复现一次完全相同的初始化。
 */
function exportSelection(): void {
  const payload = JSON.stringify(state.selection, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'selection.json';
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * 读回导出的 selection.json。
 *
 * 真正的选择校验在 useWizard.importSelection 里（与服务端 /plan、引擎 CLI
 * 共用 shared 层的 assertShape / normalizeSelection）；这里只负责浏览器侧：
 * 限大小、解析 JSON、把结果讲清楚。读完立刻清 input.value，
 * 否则同一个文件再选一次不会触发 change 事件。
 */
async function onSelectionFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 64 * 1024) {
    showImportResult(false, '选择文件超过 64 KB，请确认选的是导出的 selection.json');
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    showImportResult(false, '选择文件不是合法 JSON');
    return;
  }
  const result = wizard.importSelection(raw);
  showImportResult(result.ok, result.message);
}

/** 按钮是隐藏文件选择器的唯一入口：不把 <input type="file"> 直接暴露在操作条里。 */
function pickSelectionFile(): void {
  fileInput.value?.click();
}

function onUpdate(next: Selection): void {
  wizard.updateSelection(next);
}

/**
 * 「预览变更」：先开弹窗再算计划 —— 顺序反过来的话，计算期间页面上没有任何反馈，
 * 用户会以为按钮没生效而重复点。
 *
 * 只有 status === 'planned' 才算「计划是最新的」：改过任一选项后状态会退回 selecting，
 * 此时旧计划已经不对应当前选择，必须重算（否则弹窗里展示的是一份过期承诺）。
 */
async function openPreview(): Promise<void> {
  previewOpen.value = true;
  if (state.status !== 'planned') await wizard.preview();
}

/**
 * 两步确认：第一次算计划并弹预览，第二次才动手。
 *
 * 动手那一步**不在这里等结果**：start() 要跑几分钟，而「跑」是另一页的职责。
 * 先起流（它同步的那一段会把状态置成 running、装上离开页面的守卫），再整页过去。
 * 顺序不能反 —— 反过来进度页挂载时状态还是 planned，会被它判成「没有初始化在跑」弹回来。
 */
async function onInit(): Promise<void> {
  if (state.status === 'planned') {
    previewOpen.value = false;
    void wizard.start();
    await navigateTo('/setup/progress');
    return;
  }
  await openPreview();
}
</script>

<template>
  <main class="wizard" :class="{ 'is-running': state.status === 'running' }">
    <!-- 滚动区：页首与两栏都在这一层里。页面本身不滚 —— 滚动收到这里，
         吸附区才可能真的钉在视口下方（见文件头 ⑤）。 -->
    <div class="wizard__body">
      <header class="wizard__head">
        <h1>Nuxt Shuttle · 初始化</h1>
        <p>
          选完点「初始化项目」。模板会自删引导器、改写配置区间、装上你选的依赖，
          产出一份干净的普通 Nuxt 工程 —— 不会有额外的运行时依赖留在产物里。
        </p>
      </header>

      <div v-if="loading" class="wizard__full">
        <!-- role="status"：骨架文案（含失败原因）变化时主动告知辅助技术 -->
        <div class="skeleton" role="status">
          {{ state.message || '正在读取候选清单…' }}
        </div>
        <div v-if="state.error" class="hint hint--block">
          {{ state.error }}
        </div>
        <!-- 清单读取失败给一条显式重试路：此前这里只有错误文案，
             唯一的恢复手段是手动刷新整页 —— 而刷新恰恰会把 URL 之外的
             本地状态一起抖掉。 -->
        <div v-if="state.error" class="wizard__retry">
          <button type="button" data-primary @click="reloadSchema()">重新加载候选清单</button>
        </div>
      </div>

      <template v-else>
        <div class="wizard__col">
          <h2>技术栈</h2>
          <OptionGroup
            v-for="group in leftGroups"
            :key="group.key"
            :group="group"
            :model-value="state.selection"
            :blocked="blockedFor(group.key)"
            @update:model-value="onUpdate"
          />
        </div>

        <div class="wizard__col">
          <NuxtConfigPanel
            :groups="rightGroups"
            :model-value="state.selection"
            :blocked-for="blockedFor"
            @update:model-value="onUpdate"
          />
        </div>
      </template>

      <!-- 进度**不在这里**渲染：点下确认之后整页交给 /setup/progress。
           一个正在删文件、装依赖的初始化，值得一整屏；把它塞在选项下方，
           等于让人在「刚改过的表单项」和「正在跑的进度」之间分走注意力。 -->
      <!-- 骨架态的错误已经在上面那块里显示过了：这里再加 v-if="state.error" 会渲染两遍。 -->
      <div v-if="state.error && !loading" class="wizard__full">
        <div class="hint hint--block">
          {{ state.error }}
        </div>
      </div>

      <!-- 导入反馈：不写进 state.error（那会同时点亮「初始化失败」的语义），
           用一条会自动消失的独立提示，role=status 让读屏用户也听得到。 -->
      <div v-if="importMessage" class="wizard__full">
        <div
          class="hint"
          :class="importState === 'failed' ? 'hint--block' : 'hint--info'"
          role="status"
        >
          {{ importMessage }}
        </div>
      </div>
    </div>

    <!-- 底部吸附区：冲突提示 + 操作条。它在 .wizard__body **之外**，所以上方怎么滚它都不动。
         为什么把冲突提示也收进来：操作条会因为阻断级冲突而禁用，把「为什么禁用」留在
         上面滚走的地方，用户看到的就是一个点不动的按钮。
         运行期不再需要整块撤掉它 —— 那时这一页已经整个让给进度页了。 -->
    <div class="wizard__dock">
      <!-- 骨架态不谈冲突：schema 还没到，此时的「没有冲突」是句假话。 -->
      <ConflictHint
        v-if="!loading"
        :conflicts="orderedConflicts"
        empty-text="当前组合没有已知冲突，可以直接初始化。"
      />

      <div class="wizard__footer">
        <!-- role="status"：提示文案（阻断数、计划已算）变化时主动告知辅助技术 ——
             操作条按钮的可用性由这些文案解释，静默变化会让读屏用户摸不着头脑。 -->
        <span class="wizard__footer-status" role="status">
          <template v-if="blockConflicts.length">
            有 {{ blockConflicts.length }} 项阻断级冲突，先按上面的说明调整再提交。
          </template>
          <template v-else-if="state.status === 'planned'">
            计划已计算。确认无误后点「确认并开始初始化」—— 之后会删文件、装依赖，中途不要关闭标签页。
          </template>
          <template v-else>
            尚未计算计划：点「预览变更」先看会删什么、装什么，那一步不动任何文件。
          </template>
        </span>

        <button
          type="button"
          :disabled="!state.schema"
          title="下载 selection.json：可用 node scripts/init.mjs --selection selection.json 离线重放，或留作选择快照"
          @click="exportSelection()"
        >
          导出选择文件
        </button>
        <!-- 文件选择器本身隐藏，按钮是唯一入口：键盘与读屏用户看到的是一个有名字的按钮。 -->
        <input
          ref="fileInput"
          type="file"
          accept="application/json,.json"
          hidden
          @change="onSelectionFile"
        >
        <button
          type="button"
          :disabled="!state.schema"
          title="读回此前导出的 selection.json；会按当前候选清单校验并归一化"
          @click="pickSelectionFile()"
        >
          导入选择文件
        </button>
        <button
          type="button"
          :disabled="!state.schema"
          :title="`当前链接已包含全部选择：${wizard.shareUrl.value}`"
          @click="copyShareLink()"
        >
          {{ shareState === 'copied' ? '已复制分享链接' : shareState === 'failed' ? '复制失败，请手动复制地址栏' : '复制分享链接' }}
        </button>
        <button type="button" :disabled="!state.schema" @click="wizard.resetSelection()">
          恢复推荐默认
        </button>
        <button type="button" :disabled="!canPreview" @click="openPreview()">
          {{ state.previewing ? '计算中…' : '预览变更' }}
        </button>
        <button
          type="button"
          data-primary
          :disabled="!canStart || blockConflicts.length > 0"
          @click="onInit()"
        >
          {{ state.status === 'planned' ? '确认并开始初始化' : '初始化项目' }}
        </button>
      </div>
    </div>

    <!-- 预览弹窗挂在滚动区与吸附区之外：`<dialog>` 关闭时是 display:none，不参与布局；
         打开时由浏览器提到顶层（top layer），也不需要任何 z-index 管理。
         留在这一层还有个好处：它不是 .wizard__body 的后代，滚轮落在遮罩上也不会带动背景滚动。 -->
    <DependencyPreview
      :open="previewOpen"
      :schema="state.schema"
      :selection="state.selection"
      :plan="state.plan"
      :previewing="state.previewing"
      :error="state.error"
      @close="previewOpen = false"
      @preview="wizard.preview()"
    />
  </main>
</template>
