import {cp, lstat, mkdir, mkdtemp, readFile, rm} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {dirname, join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const version = '0.1.0'
const output = join(root, 'dist', `popmenu-${version}.zip`)
const files = [
  'README.md', 'config.json',
  'wasm/module.wasm', 'wasm/lnbits-extension.wit', 'wasm/openapi.json',
  'storage/schema.json', 'storage/migrations',
  'ui/admin.html', 'ui/public.html',
  'static/app.css', 'static/admin.js', 'static/public.js',
  'static/lnbits-extension-sdk.js', 'static/assets/icon.png'
]

async function main() {
  for (const relative of files) {
    try {
      const stat = await lstat(join(root, relative))
      if (!stat.isFile() && !stat.isDirectory()) throw new Error('not a file or directory')
    } catch (error) {
      throw new Error(`required package path is missing: ${relative} (${error.message})`)
    }
  }
  await mkdir(dirname(output), {recursive: true})
  await rm(output, {force: true})
  const staging = await mkdtemp(join(tmpdir(), 'popmenu-package-'))
  const packageRoot = join(staging, 'popmenu')
  try {
    await mkdir(packageRoot, {recursive: true})
    for (const relative of files) await cp(join(root, relative), join(packageRoot, relative), {recursive: true})
    const result = spawnSync('zip', ['-qr', output, 'popmenu'], {cwd: staging, encoding: 'utf8'})
    if (result.status !== 0) throw new Error(result.stderr || 'zip failed')
    const digest = createHash('sha256').update(await readFile(join(root, 'wasm/module.wasm'))).digest('hex')
    console.log(`package: ${output}`)
    console.log(`package: module sha256 ${digest}`)
  } finally {
    await rm(staging, {recursive: true, force: true})
  }
}

main().catch(error => {
  console.error(`package: ${error.message}`)
  process.exitCode = 1
})
