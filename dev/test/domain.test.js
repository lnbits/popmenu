import test from 'node:test'
import assert from 'node:assert/strict'
import {createDomain, decimalAdd, decimalCompare, decimalMultiply, decimalString} from '../src/domain.js'

test('decimal helpers stay exact without relying on engine BigInt support', () => {
  assert.equal(decimalString('0000000000001.23000000'), '1.23')
  assert.equal(decimalAdd('99999999999999999999.99999999', '0.00000001'), '100000000000000000000')
  assert.equal(decimalMultiply('12345678901234567890.12345678', 99), '1222222211222222221122.22222122')
  assert.equal(decimalCompare('10.00000000', '9.99999999'), 1)
})

function fakeHost() {
  const tables = {menus: new Map(), items: new Map(), orders: new Map(), payment_attempts: new Map(), settlements: new Map()}
  let sequence = 0
  let clock = 1_700_000_000
  const calls = {invoice: []}
  const host = {
    tables, calls,
    system: {now: () => clock, id: prefix => `${prefix}_${++sequence}`},
    utils: {currencies: {list: () => ['sat', 'EUR']}, lightning: {invoiceExpiry: () => clock + 600, invoiceAmountMsat: () => Number(calls.invoice.at(-1)?.amount || 0) * 1000}},
    wallet: {
      listUserWallets: () => [{id: 'wallet-a', name: 'Till', currency: 'sat'}],
      createInvoicePublic: input => {
        calls.invoice.push(input)
        return {paymentHash: 'a'.repeat(63) + (calls.invoice.length % 10), paymentRequest: `bolt_${calls.invoice.length}`, checkingId: `checking_${calls.invoice.length}`}
      }
    },
    storage: {
      get: (table, id) => tables[table].get(id) || null,
      set: (table, row) => tables[table].set(row.id, JSON.parse(JSON.stringify(row))),
      getPaginated: (table, options = {}) => {
        const filters = options.filters || {}
        const data = [...tables[table].values()].filter(row => Object.entries(filters).every(([key, value]) => row[key] === value))
        return {data, total: data.length}
      }
    },
    advance: seconds => { clock += seconds }
  }
  return host
}

function setup() {
  const host = fakeHost()
  const domain = createDomain(host)
  const menu = domain.createMenu({name: 'Tonight', currency: 'sat', walletId: 'wallet-a', lightningEnabled: true, manualEnabled: true}).menu
  const item = domain.createItem({menuId: menu.id, name: 'Tea', price: '1.25'}).item
  return {host, domain, menu, item}
}

test('checkout uses current server prices and immutable snapshots', () => {
  const {domain, menu, item} = setup()
  const order = domain.createOrder({menuId: menu.id, checkoutToken: 'checkout_1', paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 2}]}).order
  assert.equal(order.total, '2.5')
  assert.equal(order.items[0].price, '1.25')
  const tampered = domain.createOrder({menuId: menu.id, checkoutToken: 'checkout_2', paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 1, price: '0.01'}]})
  assert.equal(tampered.order.total, '1.25')
})

test('inactive and sold-out items are rejected', () => {
  const {domain, menu, item, host} = setup()
  host.tables.items.get(item.id).sold_out = true
  assert.throws(() => domain.createOrder({menuId: menu.id, checkoutToken: 'checkout_3', paymentMethod: 'manual', items: [{itemId: item.id, quantity: 1}]}), /available/)
})

test('checkout rejects inactive menus, cross-menu items, duplicates, and invalid quantities', () => {
  const {domain, menu, item, host} = setup()
  const other = domain.createMenu({name: 'Other', currency: 'sat', walletId: 'wallet-a', lightningEnabled: true}).menu
  const otherItem = domain.createItem({menuId: other.id, name: 'Other tea', price: '1'}).item
  const base = {menuId: menu.id, paymentMethod: 'manual'}
  assert.throws(() => domain.createOrder({...base, checkoutToken: 'cross', items: [{itemId: otherItem.id, quantity: 1}]}), /not part/)
  assert.throws(() => domain.createOrder({...base, checkoutToken: 'duplicate', items: [{itemId: item.id, quantity: 1}, {itemId: item.id, quantity: 1}]}), /duplicate/)
  assert.throws(() => domain.createOrder({...base, checkoutToken: 'zero', items: [{itemId: item.id, quantity: 0}]}), /quantity/)
  host.tables.menus.get(menu.id).active = false
  assert.throws(() => domain.createOrder({...base, checkoutToken: 'inactive', items: [{itemId: item.id, quantity: 1}]}), /not active/)
})

test('menu creation rejects unavailable wallets but allows a display currency independent of the wallet', () => {
  const host = fakeHost()
  const domain = createDomain(host)
  assert.throws(() => domain.createMenu({name: 'No wallet', currency: 'sat', walletId: 'missing'}), /not available/)
  const menu = domain.createMenu({name: 'Different currency', currency: 'EUR', walletId: 'wallet-a'}).menu
  assert.equal(menu.currency, 'EUR')
  assert.throws(() => domain.createMenu({name: 'No payments', currency: 'sat', walletId: 'wallet-a', lightningEnabled: false, manualEnabled: false}), /At least one/)
})

test('menu items are returned in merchant-defined position order', () => {
  const {domain, menu, item} = setup()
  const later = domain.createItem({menuId: menu.id, name: 'Later', price: '1', position: 20}).item
  const first = domain.createItem({menuId: menu.id, name: 'First', price: '1', position: 1}).item
  assert.deepEqual(domain.getPublicMenu({menuId: menu.id}).menu.items.map(row => row.id), [item.id, first.id, later.id])
  assert.deepEqual(domain.listItems({menuId: menu.id}).items.map(row => row.id), [item.id, first.id, later.id])
})

test('checkout replay returns the same order and invoice', () => {
  const {domain, menu, item, host} = setup()
  const request = {menuId: menu.id, checkoutToken: 'same_token', paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 1}]}
  const first = domain.createOrder(request)
  const second = domain.createOrder({...request, items: [{itemId: item.id, quantity: 99}]})
  assert.equal(second.order.id, first.order.id)
  assert.equal(host.calls.invoice.length, 1)
})

test('Lightning orders are not persisted until the host invoice is validated', () => {
  const {domain, menu, item, host} = setup()
  const createInvoice = host.wallet.createInvoicePublic
  host.wallet.createInvoicePublic = input => {
    assert.equal(host.tables.orders.size, 0)
    assert.equal(host.tables.payment_attempts.size, 0)
    return createInvoice(input)
  }
  const result = domain.createOrder({menuId: menu.id, checkoutToken: 'persist_after_invoice', paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 1}]})
  assert.equal(result.order.status, 'pending_payment')
  assert.equal(host.tables.orders.size, 1)
  assert.equal(host.tables.payment_attempts.size, 1)
})

test('initial invoice failure preserves one retryable order instead of a stuck checkout', () => {
  const {domain, menu, item, host} = setup()
  host.wallet.createInvoicePublic = input => { host.calls.invoice.push(input); throw new Error('offline') }
  const request = {menuId: menu.id, checkoutToken: 'invoice_failure', paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 1}]}
  const first = domain.createOrder(request)
  const replay = domain.createOrder(request)
  assert.equal(first.order.status, 'expired')
  assert.equal(replay.order.id, first.order.id)
  assert.equal(host.calls.invoice.length, 1)
})

test('paid events settle once and public responses omit private fields', () => {
  const {domain, menu, item, host} = setup()
  const result = domain.createOrder({menuId: menu.id, checkoutToken: 'paid_token', paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 1}]})
  const stored = host.tables.orders.get(result.order.id)
  const attempt = host.tables.payment_attempts.get(stored.attempt_id)
  const event = {extension: 'popmenu', tag: 'popmenu', status: 'success', pending: false, paymentHash: attempt.payment_hash, amount: 1250, extra: {source_id: stored.menu_id, extra_popmenu: {order_id: stored.id, attempt_id: attempt.id}}}
  assert.equal(domain.handleInvoicePaid(event).order.status, 'paid')
  const replay = domain.handleInvoicePaid(event).order
  assert.equal(replay.status, 'paid')
  assert.match(replay.paymentPin, /^\d{3}-\d{3}$/)
  assert.equal(replay.paymentPin, domain.confirmation({orderId: stored.id}).order.paymentPin)
  const publicOrder = domain.confirmation({orderId: stored.id}).order
  assert.equal('wallet_id' in publicOrder, false)
  assert.equal('paymentHash' in publicOrder, false)
  assert.equal('checkingId' in result, false)
  assert.equal(host.tables.settlements.size, 1)
})

test('a second paid attempt cannot settle an order twice', () => {
  const {domain, menu, item, host} = setup()
  const first = domain.createOrder({menuId: menu.id, checkoutToken: 'two_attempts', paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 1}]})
  const order = host.tables.orders.get(first.order.id)
  const oldAttempt = host.tables.payment_attempts.get(order.attempt_id)
  host.advance(601)
  domain.confirmation({orderId: order.id})
  domain.retryPayment({orderId: order.id})
  const newAttempt = host.tables.payment_attempts.get(host.tables.orders.get(order.id).attempt_id)
  const event = attempt => ({extension: 'popmenu', tag: 'popmenu', status: 'success', pending: false, paymentHash: attempt.payment_hash, amount: attempt.amount_msat, extra: {source_id: menu.id, order_id: order.id, attempt_id: attempt.id}})
  assert.equal(domain.handleInvoicePaid(event(oldAttempt)).order.paymentStatus, 'paid')
  assert.throws(() => domain.handleInvoicePaid(event(newAttempt)), /already settled/)
  assert.equal(host.tables.settlements.size, 1)
})

test('merchant queue prioritizes paid, manual, payment-pending, then history', () => {
  const {domain, menu, item, host} = setup()
  const manual = domain.createOrder({menuId: menu.id, checkoutToken: 'manual_order', paymentMethod: 'manual', items: [{itemId: item.id, quantity: 1}]}).order
  host.advance(10)
  const paidCandidate = domain.createOrder({menuId: menu.id, checkoutToken: 'paid_order', paymentMethod: 'manual', items: [{itemId: item.id, quantity: 1}]}).order
  const paid = domain.markManualPaid({orderId: paidCandidate.id}).order
  host.advance(10)
  const pending = domain.createOrder({menuId: menu.id, checkoutToken: 'pending_order', paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 1}]}).order
  host.advance(10)
  const history = domain.createOrder({menuId: menu.id, checkoutToken: 'history_order', paymentMethod: 'manual', items: [{itemId: item.id, quantity: 1}]}).order
  domain.completeOrder({orderId: history.id})
  const listed = domain.listOrders({menuId: menu.id}).orders
  assert.deepEqual(listed.map(order => order.id), [paid.id, manual.id, pending.id, history.id])
  assert.equal(listed.find(order => order.id === pending.id).paymentRequest, 'bolt_1')
  assert.equal('paymentRequest' in listed.find(order => order.id === manual.id), false)
})

test('fiat settlement uses the decoded invoice millisatoshi amount', () => {
  const host = fakeHost()
  host.wallet.listUserWallets = () => [{id: 'wallet-eur', name: 'Till', currency: 'EUR'}]
  host.utils.lightning.invoiceAmountMsat = () => 42_000
  const domain = createDomain(host)
  const menu = domain.createMenu({name: 'Tonight', currency: 'EUR', walletId: 'wallet-eur', lightningEnabled: true, manualEnabled: false}).menu
  const item = domain.createItem({menuId: menu.id, name: 'Tea', price: '1.25'}).item
  const result = domain.createOrder({menuId: menu.id, checkoutToken: 'fiat_token', paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 1}]})
  assert.equal(menu.currency, 'EUR')
  assert.equal(host.calls.invoice[0].currency, 'EUR')
  const order = host.tables.orders.get(result.order.id)
  const attempt = host.tables.payment_attempts.get(order.attempt_id)
  const event = {extension: 'popmenu', tag: 'popmenu', status: 'success', pending: false, paymentHash: attempt.payment_hash, amount: 42_000, extra: {source_id: menu.id, extra_popmenu: {order_id: order.id, attempt_id: attempt.id}}}
  assert.equal(domain.handleInvoicePaid(event).order.paymentStatus, 'paid')
})

test('invalid invoice details leave one retryable order instead of a stuck checkout', () => {
  const {domain, menu, item, host} = setup()
  host.utils.lightning.invoiceAmountMsat = () => 999
  const request = {menuId: menu.id, checkoutToken: 'wrong_invoice_amount', paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 1}]}
  const first = domain.createOrder(request)
  const replay = domain.createOrder(request)
  assert.equal(first.order.status, 'expired')
  assert.equal(replay.order.id, first.order.id)
  assert.equal(host.tables.payment_attempts.size, 0)
  assert.equal(host.tables.orders.size, 1)
})

test('manual lifecycle requires explicit merchant actions', () => {
  const {domain, menu, item} = setup()
  const order = domain.createOrder({menuId: menu.id, checkoutToken: 'manual_lifecycle', paymentMethod: 'manual', items: [{itemId: item.id, quantity: 1}]}).order
  assert.equal(order.status, 'manual_pending')
  assert.equal('paymentPin' in order, false)
  const paid = domain.markManualPaid({orderId: order.id}).order
  assert.equal(paid.status, 'paid')
  assert.match(paid.paymentPin, /^\d{3}-\d{3}$/)
  assert.throws(() => domain.cancelOrder({orderId: order.id}), /Paid orders/)
  const completed = domain.completeOrder({orderId: order.id}).order
  assert.equal(completed.status, 'completed')
  assert.equal(completed.paymentPin, paid.paymentPin)
})

test('payment events reject unconfirmed, mismatched source, amount, and hash reuse across orders', () => {
  const {domain, menu, item, host} = setup()
  const create = token => domain.createOrder({menuId: menu.id, checkoutToken: token, paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 1}]})
  const first = create('event_first').order
  const firstStored = host.tables.orders.get(first.id)
  const firstAttempt = host.tables.payment_attempts.get(firstStored.attempt_id)
  const event = {extension: 'popmenu', tag: 'popmenu', status: 'success', pending: false, paymentHash: firstAttempt.payment_hash, amount: firstAttempt.amount_msat, extra: {source_id: menu.id, order_id: first.id, attempt_id: firstAttempt.id}}
  assert.throws(() => domain.handleInvoicePaid({...event, status: 'pending'}), /not a confirmed/)
  assert.throws(() => domain.handleInvoicePaid({...event, amount: 1}), /amount/)
  assert.throws(() => domain.handleInvoicePaid({...event, extra: {...event.extra, source_id: 'wrong'}}), /source/)
  assert.equal(domain.handleInvoicePaid(event).order.status, 'paid')
  const second = create('event_second').order
  const secondStored = host.tables.orders.get(second.id)
  const secondAttempt = host.tables.payment_attempts.get(secondStored.attempt_id)
  secondAttempt.payment_hash = firstAttempt.payment_hash
  const reused = {...event, extra: {source_id: menu.id, order_id: second.id, attempt_id: secondAttempt.id}}
  assert.throws(() => domain.handleInvoicePaid(reused), /conflicts/)
})

test('public menu and order responses exclude wallet and private payment fields', () => {
  const {domain, menu, item} = setup()
  const publicMenu = domain.getPublicMenu({menuId: menu.id})
  assert.equal('walletId' in publicMenu.menu, false)
  assert.equal('wallet_id' in publicMenu.menu, false)
  const checkout = domain.createOrder({menuId: menu.id, checkoutToken: 'privacy', paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 1}]})
  assert.equal('checkingId' in checkout, false)
  assert.equal('attemptId' in checkout.order, false)
})

test('paid orders cannot be cancelled and expired invoices can be retried', () => {
  const {domain, menu, item, host} = setup()
  const result = domain.createOrder({menuId: menu.id, checkoutToken: 'retry_token', paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 1}]})
  const stored = host.tables.orders.get(result.order.id)
  host.advance(601)
  assert.equal(domain.confirmation({orderId: stored.id}).order.status, 'expired')
  const retry = domain.retryPayment({orderId: stored.id})
  assert.equal(retry.order.status, 'pending_payment')
  assert.equal(domain.cancelOrder({orderId: stored.id}).order.status, 'cancelled')
})

test('merchant queue lazily expires unpaid Lightning orders', () => {
  const {domain, menu, item, host} = setup()
  const order = domain.createOrder({menuId: menu.id, checkoutToken: 'queue_expiry', paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 1}]}).order
  host.advance(601)
  assert.equal(domain.listOrders({menuId: menu.id}).orders.find(row => row.id === order.id).status, 'expired')
})

test('a confirmed event arriving after lazy expiry still authoritatively pays the order', () => {
  const {domain, menu, item, host} = setup()
  const result = domain.createOrder({menuId: menu.id, checkoutToken: 'late_event', paymentMethod: 'lightning', items: [{itemId: item.id, quantity: 1}]})
  const order = host.tables.orders.get(result.order.id)
  const attempt = host.tables.payment_attempts.get(order.attempt_id)
  host.advance(601)
  assert.equal(domain.confirmation({orderId: order.id}).order.status, 'expired')
  const event = {extension: 'popmenu', tag: 'popmenu', status: 'success', pending: false, paymentHash: attempt.payment_hash, amount: attempt.amount_msat, extra: {source_id: menu.id, order_id: order.id, attempt_id: attempt.id}}
  assert.equal(domain.handleInvoicePaid(event).order.status, 'paid')
})
