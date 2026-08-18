import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {dirname, join} from 'node:path'

test('backend exports contain the complete PopMenu operation set', async () => {
  const source = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../src/index.js'), 'utf8')
  for (const name of [
    'listCurrencies', 'listWallets', 'listMenus', 'createMenu', 'updateMenu', 'listItems', 'createItem', 'updateItem',
    'listOrders', 'markManualPaid', 'completeOrder', 'cancelOrder', 'getPublicMenu', 'createOrder',
    'getOrderConfirmation', 'retryPayment', 'handleInvoicePaid'
  ]) assert.match(source, new RegExp(`export function ${name}\\b`))
  assert.match(source, /JSON\.stringify\(\{ok: true, data:/)
})
