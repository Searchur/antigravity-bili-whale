import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const uiDir = path.join(root, 'ui-src')
const outFile = path.join(root, 'mcp', 'dist', 'app.html')

const jsResult = await build({
  entryPoints: [path.join(uiDir, 'main.js')],
  bundle: true,
  format: 'iife',
  target: ['es2022'],
  minify: true,
  write: false,
  legalComments: 'none',
})

const bundledJs = jsResult.outputFiles[0].text
const css = fs.readFileSync(path.join(uiDir, 'styles.css'), 'utf8')
const template = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8')

// Escape </script> inside bundled JS to keep inline HTML safe
const safeJs = bundledJs.replace(/<\/script/gi, '<\\/script')
const html = template
  .replace('/*__INLINE_CSS__*/', () => css)
  .replace('/*__INLINE_JS__*/', () => safeJs)

fs.mkdirSync(path.dirname(outFile), { recursive: true })
fs.writeFileSync(outFile, html, 'utf8')
console.log(`Built single-file MCP App UI -> ${outFile} (${(Buffer.byteLength(html, 'utf8') / 1024).toFixed(1)} KiB)`)
