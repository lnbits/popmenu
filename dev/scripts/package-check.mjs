import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const archive = process.argv[2] || join(root, 'dist', 'popmenu-0.1.0.zip')
const required = new Set([
  'popmenu/README.md', 'popmenu/config.json', 'popmenu/wasm/module.wasm',
  'popmenu/wasm/lnbits-extension.wit', 'popmenu/wasm/openapi.json',
  'popmenu/storage/schema.json', 'popmenu/storage/migrations/0001_initial.json',
  'popmenu/ui/admin.html', 'popmenu/ui/public.html',
  'popmenu/static/app.css', 'popmenu/static/admin.js', 'popmenu/static/public.js',
  'popmenu/static/lnbits-extension-sdk.js', 'popmenu/static/assets/icon.png'
])

function run(args, input = undefined) {
  const result = spawnSync('unzip', args, {input, encoding: null, maxBuffer: 32 * 1024 * 1024})
  if (result.status !== 0) throw new Error(result.stderr?.toString() || `unzip ${args[0]} failed`)
  return result.stdout
}

async function main() {
  const entries = run(['-Z1', archive]).toString('utf8').split(/\r?\n/).filter(Boolean)
  const files = entries.filter(entry => !entry.endsWith('/'))
  if (!files.some(entry => entry === 'popmenu/wasm/module.wasm')) throw new Error('archive does not contain popmenu/wasm/module.wasm')
  if (files.some(entry => !entry.startsWith('popmenu/'))) throw new Error('archive contains a second top-level directory')
  if (files.some(entry => /(?:^|\/)(?:dev|node_modules|\.git)(?:\/|$)/.test(entry))) throw new Error('archive contains development files')
  for (const entry of required) if (!files.includes(entry)) throw new Error(`archive is missing ${entry}`)
  const archivedModule = run(['-p', archive, 'popmenu/wasm/module.wasm'])
  const sourceModule = await readFile(join(root, 'wasm/module.wasm'))
  const archivedHash = createHash('sha256').update(archivedModule).digest('hex')
  const sourceHash = createHash('sha256').update(sourceModule).digest('hex')
  if (archivedHash !== sourceHash) throw new Error(`module hash mismatch: archive ${archivedHash}, source ${sourceHash}`)
  console.log(`package-check: OK (${files.length} files, module sha256 ${sourceHash})`)
}

main().catch(error => {
  console.error(`package-check: ${error.message}`)
  process.exitCode = 1
})
