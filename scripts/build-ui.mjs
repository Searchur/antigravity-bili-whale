import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const uiDir = path.join(root, 'web')
const outFile = path.join(root, 'dist', 'app.html')

const jsResult = await build({
  absWorkingDir: root,
  entryPoints: [path.join(uiDir, 'main.mjs')],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  charset: 'utf8',
  minify: true,
  write: false,
  legalComments: 'eof',
  metafile: true,
})

const bundledJs = jsResult.outputFiles[0].text
const readText = file => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const css = readText(path.join(uiDir, 'styles.css'))
const template = readText(path.join(uiDir, 'index.html'))

const bundledPackages = new Set()
for (const output of Object.values(jsResult.metafile.outputs)) {
  for (const [input, { bytesInOutput }] of Object.entries(output.inputs)) {
    if (!bytesInOutput) continue
    const parts = input.replaceAll('\\', '/').split('/')
    const i = parts.lastIndexOf('node_modules')
    if (i >= 0) bundledPackages.add(parts.slice(0, i + (parts[i + 1].startsWith('@') ? 3 : 2)).join('/'))
  }
}
const licenseNotices = [...bundledPackages].sort().map(installPath => {
  const dir = path.resolve(root, installPath)
  const pkg = JSON.parse(readText(path.join(dir, 'package.json')))
  const files = fs.readdirSync(dir).filter(name => /^(licen[cs]e|copying|copyright|notice)(\.[\w-]+)?$/i.test(name)).sort()
  if (!files.length) throw new Error(`Missing license notice for bundled package ${pkg.name}`)
  return [`${pkg.name}@${pkg.version}`, ...files.map(name => readText(path.join(dir, name)).trimEnd())].join('\n\n')
}).join('\n\n---\n\n')

// Inline the bundle and its license notices without ending a script block early.
const escapeScript = content => content.replace(/<\/script/gi, '<\\/script')
const html = template
  .replace('/*__INLINE_CSS__*/', () => css)
  .replace('/*__INLINE_JS__*/', () => escapeScript(bundledJs))
  .replace('</body>', () => `<script type="text/plain" id="third-party-licenses">\n${escapeScript(licenseNotices)}\n</script>\n</body>`)

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, html, 'utf8')
console.log(`Built single-file MCP App UI -> ${outFile} (${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KiB)`)
