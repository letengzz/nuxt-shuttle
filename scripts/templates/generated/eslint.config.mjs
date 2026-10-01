import withNuxt from './.nuxt/eslint.config.mjs';
import prettier from 'eslint-config-prettier';

/**
 * ESLint flat config。
 *
 * 分工：**ESLint 管「对不对」（未使用变量、错误的响应式用法、Vue 的坑），
 * Prettier 管「好不好看」（缩进、引号、换行）**。两条线各管一段，不重叠 ——
 * `eslint-config-prettier` 放在最后，作用就是把所有格式化类规则关掉，
 * 否则两边会互相「修正」，形成保存一次改一次的循环。
 *
 * 注意 `withNuxt` 读的是 `.nuxt/eslint.config.mjs`，那是 `nuxt prepare` 生成的。
 * 所以 clone 之后必须先安装依赖（postinstall 会自动 prepare），
 * 直接跑 `eslint .` 会报「找不到 .nuxt/eslint.config.mjs」。
 */
export default withNuxt(
  prettier,
  {
    rules: {
      // 页面与布局组件的文件名天然是单词（index、about），这条规则对它们是噪音
      'vue/multi-word-component-names': 'off',
    },
  },
);
