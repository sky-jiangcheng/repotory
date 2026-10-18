import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import testingLibrary from 'eslint-plugin-testing-library'

// ADR-0026 条件 4：C 是**形态守卫**，不是本 ADR 那一类竞态的解法——它拦得住
// 未 await 的 `findBy*`、`getBy` 与 `waitFor` 的误用，拦不住「等了一个无条件挂载
// 的锚点、随后同步读 effect 状态」。这条边界写在 ADR-0026 与 CONTRIBUTING 里，
// 别把挂了插件当成时序安全。
//
// v7 没有 `flat/recommended`，只有按框架拆的 `flat/*`。本项目用 @testing-library/
// react（含 DOM 查询），所以取 dom + react 两套。
//
// 范围必须限定在**真正用 testing-library 的文件**，不能一把梭 `**/*.test.{ts,tsx}`：
// `render-result-naming-convention` 会匹配任何以 render 开头的调用，于是纯逻辑测试里
// 的 `const result = renderMarkdown(...)` 被判成「render 返回值命名不当」——
// src/utils/markdown.test.ts 一个 RTL 引用都没有，却中了 16 条。留个精确清单，代价是
// 将来若有非 hooks 目录的 `.test.ts` 用上 RTL，得记得登记；这条维护账写在这里而不是
// 藏在 glob 里。
const testingLibraryFiles = ['**/*.test.tsx', 'src/hooks/*.test.ts', 'src/test/**/*.tsx']
const testingLibraryConfigs = [
  testingLibrary.configs['flat/dom'],
  testingLibrary.configs['flat/react'],
].map((config) => ({ ...config, files: testingLibraryFiles }))

export default tseslint.config(
  {
    ignores: ['dist', 'node_modules', 'src/lib'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: { ...globals.browser, ...globals.es2022 },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // The Wails/i18n interop uses dynamic window access by design.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  ...testingLibraryConfigs,
  {
    files: testingLibraryFiles,
    rules: {
      // ADR-0026 条件 4 —— 这条是**有意不采**，不是疏漏，也不静默：
      // render-result-naming-convention 只给变量命名建议，不承载任何正确性；而它靠
      // 函数名前缀匹配，会在纯逻辑测试里误报——src/utils/markdown.test.ts 一个
      // testing-library 引用都没有，却因 `const result = renderMarkdown(...)` 中了
      // 16 条。剩下的 12 条集中在 useApiData.test.tsx，那里的 a/b/c/d 表达的是
      // 「共享同一 cacheKey 的多个消费者」，改成 viewA/viewB 并不更能说明问题。
      'testing-library/render-result-naming-convention': 'off',
    },
  },
)
