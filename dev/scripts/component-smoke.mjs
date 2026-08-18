import assert from 'node:assert/strict'
import {rm} from 'node:fs/promises'
import {spawnSync} from 'node:child_process'
import {dirname, resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {componentState, resetComponentState} from '../test/component-host-mock.js'

const dev = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(dev, '..')
const output = resolve(dev, 'dist/component-smoke')
await rm(output, {recursive: true, force: true})
const result = spawnSync(resolve(dev, 'node_modules/.bin/jco'), [
  'transpile', resolve(root, 'wasm/module.wasm'), '-o', output, '--name', 'popmenu', '--no-typescript',
  '-M', 'lnbits:extension/host=../../test/component-host-mock.js',
  '-M', 'lnbits:extension/utils-currencies=../../test/component-currencies-mock.js',
  '-M', 'lnbits:extension/utils-lightning=../../test/component-lightning-mock.js'
], {encoding: 'utf8'})
if (result.status !== 0) throw new Error(result.stderr || result.stdout || 'component transpilation failed')

resetComponentState()
const component = await import(`${pathToFileURL(resolve(output, 'popmenu.js')).href}?smoke=${Date.now()}`)
const call = (name, input = {}) => {
  const response = JSON.parse(component[name](JSON.stringify(input)))
  assert.equal(response.ok, true, `${name}: ${response.error || 'failed'}`)
  return response.data
}

const menu = call('createMenu', {name: 'Tonight', currency: 'sat', walletId: 'wallet-1', lightningEnabled: true, manualEnabled: true}).menu
const tea = call('createItem', {menuId: menu.id, name: 'Tea', price: '2.5'}).item
call('createItem', {menuId: menu.id, name: 'Cake', price: '4'}).item
const publicMenu = call('getPublicMenu', {menuId: menu.id})
assert.equal(publicMenu.menu.items.length, 2)
const checkout = call('createOrder', {menuId: menu.id, checkoutToken: publicMenu.checkoutToken, paymentMethod: 'lightning', items: [{itemId: tea.id, quantity: 1}]})
assert.equal(checkout.order.total, '2.5')
const stored = componentState.tables.orders.get(checkout.order.id)
const attempt = componentState.tables.payment_attempts.get(stored.attempt_id)
const event = {extension: 'popmenu', tag: 'popmenu', status: 'success', pending: false, paymentHash: attempt.payment_hash, amount: 2500, extra: {source_id: menu.id, order_id: stored.id, attempt_id: attempt.id}}
const settled = call('handleInvoicePaid', event).order
const replayed = call('handleInvoicePaid', event).order
const confirmation = call('getOrderConfirmation', {orderId: stored.id}).order
const merchantOrder = call('listOrders', {menuId: menu.id}).orders[0]
assert.equal(settled.paymentStatus, 'paid')
assert.match(settled.paymentPin, /^\d{3}-\d{3}$/)
assert.equal(replayed.paymentPin, settled.paymentPin)
assert.equal(confirmation.paymentPin, settled.paymentPin)
assert.equal(merchantOrder.paymentPin, settled.paymentPin)
assert.equal(componentState.tables.settlements.size, 1)
console.log('component-smoke: OK (actual component checkout, settlement, confirmation, and replay)')
