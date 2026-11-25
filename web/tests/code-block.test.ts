import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CodeBlock from '@/components/common/CodeBlock.vue'

/** 取组件渲染出的高亮 HTML 文本。 */
function htmlOf(text: string | null | undefined, language?: string): string {
  const wrapper = mount(CodeBlock, { props: { text, language } })
  return wrapper.find('.code-block').exists() ? wrapper.find('.code-block').text() : ''
}

describe('CodeBlock', () => {
  it('JSON 先缩进排版再高亮', () => {
    const wrapper = mount(CodeBlock, { props: { text: '{"ok":true,"code":0}' } })
    const code = wrapper.find('.code-block')
    expect(code.exists()).toBe(true)
    // 两行 + 缩进：{ 之后是换行和两个空格
    expect(code.text()).toContain('\n  "ok": true')
    // 高亮类名在，说明走了 highlight.js
    expect(code.find('.hljs-attr').exists()).toBe(true)
  })

  it('嵌套 JSON 按层级缩进', () => {
    const wrapper = mount(CodeBlock, {
      props: { text: '{"data":{"list":[1,2]}}' },
    })
    expect(wrapper.find('.code-block').text()).toContain('\n  "data": {')
    expect(wrapper.find('.code-block').text()).toContain('\n    "list": [')
  })

  it('curl / bash 脚本按 bash 高亮', () => {
    const wrapper = mount(CodeBlock, {
      props: { text: 'curl -X POST https://example.com/api -d \'{"a":1}\'' },
    })
    // bash 高亮会把引号里的内容标成字符串；纯文本则一个 hljs-* 标签都没有
    expect(wrapper.find('.code-block').find('.hljs-string').exists()).toBe(true)
  })

  it('显式指定语言优先于自动识别', () => {
    const wrapper = mount(CodeBlock, {
      props: { text: 'SELECT 1', language: 'sql' },
    })
    expect(wrapper.find('.code-block').find('.hljs-keyword').exists()).toBe(true)
  })

  it('认不出来的内容按纯文本显示，HTML 不会被执行', () => {
    const wrapper = mount(CodeBlock, { props: { text: '<script>alert(1)</script>' } })
    const code = wrapper.find('.code-block')
    expect(code.text()).toContain('<script>alert(1)</script>')
    expect(code.find('script').exists()).toBe(false)
  })

  it('空内容显示 empty 文案', () => {
    const wrapper = mount(CodeBlock, { props: { text: '', empty: '（空）' } })
    expect(wrapper.find('.code-empty').text()).toBe('（空）')
  })

  it('null / undefined 也不会炸', () => {
    expect(mount(CodeBlock, { props: { text: null } }).find('.code-empty').exists()).toBe(true)
    expect(mount(CodeBlock, { props: { text: undefined } }).find('.code-empty').exists()).toBe(true)
  })
})
