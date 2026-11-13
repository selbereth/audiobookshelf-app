// Runs every utils/core/*.test.js in Node (bundled with esbuild so the ES modules and top-level await work). `npm run test:core`
import { build } from 'esbuild'
import { readdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const dir = dirname(fileURLToPath(import.meta.url))
const pebbleDir = join(dir, '..', 'pebble') // the watch's hub tests run here too
const out = mkdtempSync(join(tmpdir(), 'core-tests-'))
let failed = false
const files = [...readdirSync(dir).map((f) => join(dir, f)), ...readdirSync(pebbleDir).map((f) => join(pebbleDir, f))].filter((f) => f.endsWith('.test.js'))
for (const path of files) {
  const f = path.split('/').slice(-1)[0]
  const outfile = join(out, f.replace('.test.js', '.js'))
  await build({ entryPoints: [path], bundle: true, platform: 'node', format: 'esm', target: 'node18', outfile: outfile.replace(/\.js$/, '.mjs'), logLevel: 'error' })
  console.log('--- ' + f)
  const r = spawnSync('node', [outfile.replace(/\.js$/, '.mjs')], { stdio: 'inherit' })
  if (r.status !== 0) failed = true
}
process.exit(failed ? 1 : 0)
