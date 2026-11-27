import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

class Element {
  constructor(tag, text = '') {
    this.tag = tag
    this.text = text
    this.children = []
    this.events = {}
    this.attrs = {}
    this.style = {}
    this.disabled = false
  }
  get textContent() { return this.text + this.children.map(n => n.textContent).join('') }
  set textContent(value) { this.text = value; this.children = [] }
  setAttribute(key, value) { this.attrs[key] = value }
  appendChild(node) { this.children.push(node) }
  replaceChildren(...children) { this.children = children }
  addEventListener(name, handler) { this.events[name] = handler }
  nodes() { return [this, ...this.children.flatMap(n => n.nodes())] }
  querySelector(selector) { return this.nodes().find(n => '.' + n.className === selector) }
}

export async function openConsole(t, handle) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-ui-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const uiDir = path.join(dir, 'web')
  await fs.cp(new URL('../../web/', import.meta.url), uiDir, { recursive: true })
  await fs.cp(new URL('../../src/shared/', import.meta.url), path.join(dir, 'src', 'shared'), { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module"}')
  await fs.writeFile(path.join(uiDir, 'bridge.mjs'), 'export const createMcpBridge = () => globalThis.testBridge')
  const root = new Element('div')
  const document = {
    getElementById: id => id === 'root' ? root : root.nodes().find(n => n.attrs.id === id),
    createElement: tag => new Element(tag),
    createTextNode: text => new Element('#text', text),
  }
  const settings = { self: { mid: '100' }, owner: { mid: '', name: '' }, preferences: {}, night: {} }
  globalThis.document = document
  globalThis.testBridge = {
    connect: async () => {},
    callTool: async (name, args = {}) => {
      const custom = handle?.(name, args)
      if (custom !== undefined) return custom
      if (name === 'whale_app_bootstrap') return { settings: { config: structuredClone(settings) }, status: {} }
      if (name === 'whale_app_settings') return { config: structuredClone(args.config) }
      if (name === 'whale_app_life') return { state: { pending: [{ id: 'example' }] } }
      return {}
    },
  }
  t.after(() => { delete globalThis.document; delete globalThis.testBridge })
  await import(pathToFileURL(path.join(uiDir, 'main.mjs')).href)
  await new Promise(setImmediate)
  const button = label => root.nodes().find(n => n.tag === 'button' && n.textContent.includes(label))
  const input = placeholder => root.nodes().find(n => n.attrs.placeholder === placeholder)
  const change = (node, value) => { node.value = value; return node.events.input({ target: node }) }
  return { root, button, input, change, click: label => button(label).events.click() }
}

