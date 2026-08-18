import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {dirname, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'

const devRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function source(name) {
  return readFile(resolve(devRoot, 'src', name), 'utf8')
}

function internalModule(value) {
  return value.replace(/^export\s+/gm, '')
}

const host = internalModule(await source('host.js'))
const domain = internalModule(await source('domain.js'))
const entrypoint = (await source('index.js')).replace(
  /^import\s+\{[^}]+\}\s+from\s+['"]\.\/(?:host|domain)\.js['"]\s*\n/gm,
  ''
)

const output = resolve(devRoot, 'dist', 'index.bundle.js')
await mkdir(dirname(output), {recursive: true})
await writeFile(output, `${host}\n${domain}\n${entrypoint}`, 'utf8')
console.log(`bundle: ${output}`)
