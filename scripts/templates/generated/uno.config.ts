import { defineConfig, presetWind4 } from 'unocss';

/**
 * UnoCSS 配置。
 *
 * 三条值得知道的默认行为：
 *   ① presetWind4 提供与 Tailwind 4 一致的原子类语法（w-4、text-sm、bg-brand-500）；
 *   ② 工具类是**按需生成**的 —— 只扫描源码里真实出现过的类名，产物体积与用法成正比；
 *   ③ 它的 reset 排在样式入口的第一位（见 nuxt.config.ts 的 TEMPLATE:CSS 区间），
 *      否则自定义样式会被 reset 覆盖。
 *
 * 想要 Attributify（把类名写成 HTML 属性）或纯 CSS 图标，在下面加对应预设即可，
 * 它们是可选的，不该默认塞进每个项目。
 */
export default defineConfig({
  presets: [presetWind4()],

  // 常用组合写在这里，比在模板里重复十几个类名好维护。
  shortcuts: {
    'btn': 'inline-flex items-center gap-2 px-4 py-2 rounded border border-gray-200',
    'card': 'p-4 rounded-lg border border-gray-200 bg-white',
  },

  theme: {
    colors: {
      // 与 app/assets/styles/tokens.css 的品牌色对齐，两套写法指向同一个色值。
      brand: {
        50: '#effdf5',
        500: '#00dc82',
        600: '#00c16a',
        700: '#007f45',
      },
    },
  },
});
