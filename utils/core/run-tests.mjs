// Runs every utils/core/*.test.js in Node (bundled with esbuild so the ES modules and top-level await work). `npm run test:core`
import { build } from 'esbuild'
import { readdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { spawnSync } from 'child_process'

const dir = dirname(fileURLToPath(import.meta.url))
const out = mkdtempSync(join(tmpdir(), 'core-tests-'))
let failed = false
for (const f of readdirSync(dir).filter((f) => f.endsWith('.test.js'))) {
  const outfile = join(out, f.replace('.test.js', '.js'))
  await build({ entryPoints: [join(dir, f)], bundle: true, platform: 'node', format: 'esm', target: 'node18', outfile: outfile.replace(/\.js$/, '.mjs'), logLevel: 'error' })
  console.log('--- ' + f)
  const r = spawnSync('node', [outfile.replace(/\.js$/, '.mjs')], { stdio: 'inherit' })
  if (r.status !== 0) failed = true
}
process.exit(failed ? 1 : 0)
