import { Fragment } from 'react'

interface Segment {
  content: string
  isCode: boolean
}

/**
 * 把带 `<code>` 标签的文本切成片段。纯函数：解析放在渲染之外，组件里只做
 * 映射——渲染期改局部变量会被 React Compiler 的规则拦下（这条规则是对的：
 * 渲染必须是纯函数）。
 */
function parseCodeSegments(text: string): Segment[] {
  const out: Segment[] = []
  let isCode = false
  for (const part of text.split(/(<\/?code>)/g)) {
    if (part === '<code>') { isCode = true; continue }
    if (part === '</code>') { isCode = false; continue }
    if (part === '') continue
    out.push({ content: part, isCode })
  }
  return out
}

/**
 * 渲染一段可能含 `<code>` 标签的 locale 文本。
 *
 * 设置页的几条描述里带 `<code>`，是为了让路径/标识符用等宽字体显示（如
 * `plugins/`、`plugin.go`）。但那是**翻译内容**——用 `dangerouslySetInnerHTML`
 * 塞它，等于把「词条」变成注入点：哪天有人把某个词条改成含 `<img onerror=…>`
 * 的字符串，就直接在界面上执行了。词条是数据，不该有执行权。
 *
 * 这里只认 `<code>` / `</code>` 两个固定标签，其余一律当纯文本渲染，产出的
 * DOM 与原先的 innerHTML 完全一致（同样的 `<code>` 元素、同样的文字），样式
 * 选择器（`.settings-section > .section-desc code`）照旧命中。
 */
export default function CodeText({ text }: { text: string }) {
  return (
    <>
      {parseCodeSegments(text).map((seg, i) => (
        seg.isCode
          ? <code key={i}>{seg.content}</code>
          : <Fragment key={i}>{seg.content}</Fragment>
      ))}
    </>
  )
}
