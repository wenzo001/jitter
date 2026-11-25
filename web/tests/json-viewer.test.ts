import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import JsonViewer from '@/components/common/JsonViewer.vue'

describe('JsonViewer', () => {
  it('合法 JSON 渲染成树（vue-json-pretty）', () => {
    const wrapper = mount(JsonViewer, { props: { text: '{"ok":true,"code":0}' } })
    expect(wrapper.find('.vjs-tree').exists()).toBe(true)
    expect(wrapper.text()).toContain('ok')
    expect(wrapper.find('.json-plain').exists()).toBe(false)
  })

  it('数组也走树状渲染', () => {
    const wrapper = mount(JsonViewer, { props: { text: '[1,2,3]' } })
    expect(wrapper.find('.vjs-tree').exists()).toBe(true)
  })

  it('不是 JSON 时退回纯文本，内容不能丢', () => {
    const wrapper = mount(JsonViewer, { props: { text: '<html>hi</html>' } })
    expect(wrapper.find('.vjs-tree').exists()).toBe(false)
    expect(wrapper.find('.json-plain').text()).toContain('<html>hi</html>')
  })

  it('空内容显示 empty 文案', () => {
    const wrapper = mount(JsonViewer, { props: { text: '', empty: '（空）' } })
    expect(wrapper.find('.json-plain').text()).toBe('（空）')
  })

  it('null / undefined 也不会炸', () => {
    expect(mount(JsonViewer, { props: { text: null } }).find('.json-plain').exists()).toBe(true)
    expect(mount(JsonViewer, { props: { text: undefined } }).find('.json-plain').exists()).toBe(true)
  })
})
