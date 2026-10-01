/**
 * Stylelint 配置。
 *
 * 这一个文件被 Sass 与 Less 两个选项共用 —— 引擎按所选预处理器把 extends 里的
 * 生态配置换成对应的那一项（stylelint-config-standard-scss / -standard-less）。
 * 没有这一层就得维护两个只差一行的文件，而「只差一行」正是最容易漂移的那种重复。
 *
 * 注意本配置只覆盖独立的样式文件（.css/.scss/.less）。要连 .vue 里的
 * <style> 一起检查，需要额外装 postcss-html 并在这里加 customSyntax ——
 * 那是另一件事，模板不替你决定。
 */
export default {
  extends: [
    'stylelint-config-standard',
    {{stylelintExtends}}
  ],
  rules: {
    // 令牌层（tokens.{{styleLang}}）故意用空行把变量分组，这条规则会与它冲突
    'custom-property-empty-line-before': null,
    // Vue 的 :deep() / :slotted() 会被默认规则误判为未知伪类
    'selector-pseudo-class-no-unknown': [true, {
      ignorePseudoClasses: ['deep', 'slotted', 'global'],
    }],
    // 空文件里的注释块不该报错
    'no-empty-source': null,
  },
  ignoreFiles: ['**/node_modules/**', '**/.nuxt/**', '**/.output/**', '**/dist/**'],
};
