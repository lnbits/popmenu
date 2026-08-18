/* PopMenu domain rules.  This module has no component/WASI dependencies; the
 * host object is injected so every rule can be tested with an in-memory fake. */

export const TABLES = Object.freeze({
  MENUS: 'menus', ITEMS: 'items', ORDERS: 'orders', ATTEMPTS: 'payment_attempts', SETTLEMENTS: 'settlements'
})

export class PopMenuError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PopMenuError'
    this.public = true
  }
}

function fail(message) { throw new PopMenuError(message) }
function valueOf(object, camel, snake = camel) {
  return object && object[camel] !== undefined ? object[camel] : object && object[snake]
}
function text(value, name, max, required = false) {
  if (typeof value !== 'string') {
    if (required) fail(`${name} is required.`)
    return ''
  }
  const result = value.trim()
  if (required && !result) fail(`${name} is required.`)
  if (result.length > max) fail(`${name} is too long.`)
  return result
}
function id(value, name) { return text(value, name, 160, true) }
function bool(value, name, fallback = false) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(`${name} must be a boolean.`)
  return value
}
function integer(value, name, min, max) {
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value)
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${name} is invalid.`)
  return value
}
function timestampNow(host) { return integer(host.system.now(), 'timestamp', 1, 9007199254740991) }
function copy(value) { return JSON.parse(JSON.stringify(value)) }
function objectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (_) { return {} }
  }
  return {}
}

/* Decimal arithmetic deliberately never goes through Number or BigInt.  The
 * component engine used by the supported jco release does not provide BigInt. */
function stripZeroes(value) { return value.replace(/^0+(?=\d)/, '') || '0' }
function alignDecimal(parsed, scale) { return parsed.units.padEnd(parsed.units.length + scale - parsed.scale, '0') }
function addDigits(left, right) {
  const width = Math.max(left.length, right.length)
  const a = left.padStart(width, '0')
  const b = right.padStart(width, '0')
  let carry = 0
  let result = ''
  for (let index = width - 1; index >= 0; index -= 1) {
    const sum = Number(a[index]) + Number(b[index]) + carry
    result = String(sum % 10) + result
    carry = Math.floor(sum / 10)
  }
  return stripZeroes((carry ? String(carry) : '') + result)
}
function multiplyDigits(value, multiplier) {
  let carry = 0
  let result = ''
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const product = Number(value[index]) * multiplier + carry
    result = String(product % 10) + result
    carry = Math.floor(product / 10)
  }
  while (carry) {
    result = String(carry % 10) + result
    carry = Math.floor(carry / 10)
  }
  return stripZeroes(result)
}
function fromUnits(units, scale) {
  const padded = stripZeroes(units).padStart(scale + 1, '0')
  return decimalString(scale ? `${padded.slice(0, -scale)}.${padded.slice(-scale)}` : padded, 'amount', false)
}
export function decimal(value, name = 'price', positive = true) {
  if (typeof value !== 'string' && typeof value !== 'number') fail(`${name} is invalid.`)
  const raw = String(value).trim()
  if (!/^\d+(?:\.\d{1,8})?$/.test(raw)) fail(`${name} is invalid.`)
  const [whole, fraction = ''] = raw.split('.')
  const units = `${whole}${fraction}`.replace(/^0+(?=\d)/, '')
  if (positive && /^0+$/.test(units)) fail(`${name} must be greater than zero.`)
  const scale = fraction.length
  return {units: units || '0', scale}
}
export function decimalString(value, name = 'price', positive = true) {
  const parsed = decimal(value, name, positive)
  let units = parsed.units.padStart(parsed.scale + 1, '0')
  if (parsed.scale) {
    const split = units.length - parsed.scale
    units = `${units.slice(0, split)}.${units.slice(split)}`
  }
  units = units.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
  return units
}
export function decimalAdd(left, right) {
  const a = decimal(left, 'amount', false)
  const b = decimal(right, 'amount', false)
  const scale = Math.max(a.scale, b.scale)
  return fromUnits(addDigits(alignDecimal(a, scale), alignDecimal(b, scale)), scale)
}
export function decimalMultiply(value, quantity) {
  const parsed = decimal(value, 'price')
  return fromUnits(multiplyDigits(parsed.units, quantity), parsed.scale)
}
export function decimalCompare(left, right) {
  const a = decimal(left, 'amount', false)
  const b = decimal(right, 'amount', false)
  const scale = Math.max(a.scale, b.scale)
  const au = stripZeroes(alignDecimal(a, scale))
  const bu = stripZeroes(alignDecimal(b, scale))
  if (au.length !== bu.length) return au.length < bu.length ? -1 : 1
  return au < bu ? -1 : au > bu ? 1 : 0
}

function addMany(values) {
  let result = '0'
  for (const value of values) result = decimalAdd(result, value)
  return result
}
function invoiceAmount(value) {
  const number = Number(decimalString(value, 'total'))
  if (!Number.isFinite(number) || number <= 0 || number > Number.MAX_SAFE_INTEGER) fail('The total is outside the supported invoice range.')
  return number
}
function publicMenu(menu, items) {
  return {
    id: menu.id, name: menu.name, description: menu.description || '', currency: menu.currency,
    lightningEnabled: menu.lightning_enabled === true, manualEnabled: menu.manual_enabled === true,
    manualInstructions: menu.manual_instructions || '', active: menu.active === true,
    items: items.map(publicItem)
  }
}
function publicItem(item) {
  return {id: item.id, menuId: item.menu_id, name: item.name, description: item.description || '', price: item.price, position: item.position, active: item.active === true, soldOut: item.sold_out === true}
}
function snapshotItem(item, quantity, note) {
  return {item_id: item.id, name: item.name, price: decimalString(item.price), quantity, note: note || ''}
}
function paymentPin(order) {
  const value = `popmenu:${order.id}:${order.order_number}`
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619) >>> 0
  }
  const digits = String(hash % 1000000).padStart(6, '0')
  return `${digits.slice(0, 3)}-${digits.slice(3)}`
}
function publicOrder(order) {
  const result = {
    id: order.id, orderNumber: order.order_number, menuId: order.menu_id, items: copy(order.items || []), total: order.total,
    currency: order.currency, paymentMethod: order.payment_method, paymentStatus: order.payment_status,
    status: order.status, fulfillmentStatus: order.fulfillment_status || '', customerName: order.customer_name || '',
    customerNote: order.customer_note || '', tableLabel: order.table_label || '', locationLabel: order.location_label || '',
    createdAt: order.created_at, paidAt: order.paid_at || null, completedAt: order.completed_at || null,
    cancelledAt: order.cancelled_at || null, manualInstructions: order.manual_instructions || ''
  }
  if (order.payment_status === 'paid') result.paymentPin = paymentPin(order)
  return result
}
function privateOrder(host, order) {
  const result = {...publicOrder(order), attemptId: order.attempt_id || null}
  if (order.payment_method === 'lightning' && order.attempt_id) {
    const attempt = host.storage.get(TABLES.ATTEMPTS, order.attempt_id)
    if (attempt && attempt.bolt11) result.paymentRequest = attempt.bolt11
  }
  return result
}
function orderPriority(order) {
  if (order.status === 'paid') return 0
  if (order.status === 'manual_pending') return 1
  if (order.status === 'pending_payment') return 2
  return 3
}
function invoiceResponse(order, attempt) {
  return {
    order: publicOrder(order), paymentRequest: attempt ? attempt.bolt11 : '', paymentHash: attempt ? attempt.payment_hash : '',
    expiresAt: attempt ? attempt.expires_at : null
  }
}
function currencyAllowed(host, currency) {
  const currencies = host.utils.currencies.list()
  const match = Array.isArray(currencies)
    ? currencies.find(value => String(value).toLowerCase() === String(currency).toLowerCase())
    : null
  if (match === undefined || match === null) fail('That currency is not supported.')
  return String(match)
}
function menuFor(host, menuId) {
  const menu = host.storage.get(TABLES.MENUS, id(menuId, 'menuId'))
  if (!menu || menu.id !== menuId) fail('Menu not found.')
  return menu
}
function itemOrder(left, right) {
  return Number(left.position || 0) - Number(right.position || 0) || Number(left.created_at || 0) - Number(right.created_at || 0)
}
function itemRows(host, menuId) {
  return (host.storage.getPaginated(TABLES.ITEMS, {filters: {menu_id: menuId}, limit: 100, offset: 0}).data || []).slice().sort(itemOrder)
}
function orderFor(host, orderId) {
  const order = host.storage.get(TABLES.ORDERS, id(orderId, 'orderId'))
  if (!order || order.id !== orderId) fail('Order not found.')
  return order
}
function save(host, table, row) { host.storage.set(table, copy(row)); return row }
function walletExists(host, walletId) {
  const wallets = host.wallet.listUserWallets()
  const wallet = (wallets || []).find(item => item && item.id === walletId)
  if (!wallet) fail('The selected wallet is not available.')
}
function menuFields(request, existing, host) {
  const currency = currencyAllowed(host, text(valueOf(request, 'currency'), 'currency', 8, true))
  const walletId = text(valueOf(request, 'walletId', 'wallet_id'), 'walletId', 128, true)
  walletExists(host, walletId)
  const result = {
    name: text(valueOf(request, 'name'), 'name', 120, true), description: text(valueOf(request, 'description'), 'description', 1000), currency,
    wallet_id: walletId, lightning_enabled: bool(valueOf(request, 'lightningEnabled', 'lightning_enabled'), 'lightningEnabled', true),
    manual_enabled: bool(valueOf(request, 'manualEnabled', 'manual_enabled'), 'manualEnabled', false),
    manual_instructions: text(valueOf(request, 'manualInstructions', 'manual_instructions'), 'manualInstructions', 1000),
    active: bool(valueOf(request, 'active'), 'active', true)
  }
  if (!result.lightning_enabled && !result.manual_enabled) fail('At least one payment method must be enabled.')
  return {...(existing || {}), ...result}
}
function validateCart(host, menu, request) {
  const rawItems = valueOf(request, 'items')
  if (!Array.isArray(rawItems) || rawItems.length < 1 || rawItems.length > 100) fail('At least one cart item is required.')
  const current = new Map(itemRows(host, menu.id).map(item => [item.id, item]))
  const seen = new Set()
  const snapshots = []
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Cart items are invalid.')
    const itemId = id(valueOf(raw, 'itemId', 'item_id') || valueOf(raw, 'id'), 'itemId')
    if (seen.has(itemId)) fail('Cart contains a duplicate item.')
    seen.add(itemId)
    const item = current.get(itemId)
    if (!item || item.menu_id !== menu.id) fail('A cart item is not part of this menu.')
    if (item.active !== true || item.sold_out === true) fail('A cart item is no longer available.')
    const quantity = integer(valueOf(raw, 'quantity'), 'quantity', 1, 99)
    const note = text(valueOf(raw, 'note'), 'item note', 500)
    snapshots.push(snapshotItem(item, quantity, note))
  }
  return {snapshots, total: addMany(snapshots.map(item => decimalMultiply(item.price, item.quantity)))}
}
function requestedMethod(menu, request) {
  const method = text(valueOf(request, 'paymentMethod', 'payment_method'), 'paymentMethod', 20, true).toLowerCase()
  if (!['lightning', 'manual'].includes(method)) fail('Payment method is invalid.')
  if (method === 'lightning' && menu.lightning_enabled !== true) fail('Lightning payment is not enabled for this menu.')
  if (method === 'manual' && menu.manual_enabled !== true) fail('Manual payment is not enabled for this menu.')
  return method
}
function checkoutFields(request) {
  return {
    customer_name: text(valueOf(request, 'customerName', 'customer_name'), 'customerName', 120),
    customer_note: text(valueOf(request, 'customerNote', 'customer_note'), 'customerNote', 1000),
    table_label: text(valueOf(request, 'tableLabel', 'table_label'), 'tableLabel', 120),
    location_label: text(valueOf(request, 'locationLabel', 'location_label'), 'locationLabel', 120)
  }
}
function orderFromCheckout(host, menu, request, token, cart, method) {
  const timestamp = timestampNow(host)
  const orderId = id(host.system.id('order'), 'orderId')
  const orderNumber = text(host.system.id('receipt'), 'orderNumber', 80, true)
  return {
    id: orderId, checkout_token: token, menu_id: menu.id, order_number: orderNumber, items: copy(cart.snapshots), total: cart.total, currency: menu.currency,
    payment_method: method, payment_status: method === 'manual' ? 'manual_pending' : 'pending', status: method === 'manual' ? 'manual_pending' : 'pending_payment',
    fulfillment_status: 'unfulfilled', manual_instructions: method === 'manual' ? menu.manual_instructions || '' : null,
    attempt_id: null, ...checkoutFields(request), created_at: timestamp, updated_at: timestamp, paid_at: null, completed_at: null, cancelled_at: null
  }
}

function invoiceDetails(host, invoice, expectedAmount, currency) {
  const expiresAt = host.utils.lightning.invoiceExpiry(invoice.paymentRequest)
  const amountMsat = host.utils.lightning.invoiceAmountMsat(invoice.paymentRequest)
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) fail('The invoice has no valid expiry.')
  if (!Number.isSafeInteger(amountMsat) || amountMsat <= 0) fail('The invoice has no valid amount.')
  if (String(currency).toLowerCase() === 'sat' && amountMsat !== invoiceAmount(decimalMultiply(expectedAmount, 1000))) fail('The invoice amount does not match the order total.')
  return {expiresAt, amountMsat}
}

export function createDomain(host) {
  function listCurrencies() {
    return {currencies: (host.utils.currencies.list() || []).map(value => String(value))}
  }
  function listWallets() {
    return {wallets: (host.wallet.listUserWallets() || []).map(wallet => ({id: wallet.id, name: wallet.name, currency: wallet.currency || null}))}
  }
  function listMenus(request = {}) {
    const requestedLimit = valueOf(request, 'limit')
    const requestedOffset = valueOf(request, 'offset')
    const page = host.storage.getPaginated(TABLES.MENUS, {limit: requestedLimit === undefined ? 100 : integer(requestedLimit, 'limit', 1, 100), offset: requestedOffset === undefined ? 0 : integer(requestedOffset, 'offset', 0, 1000000)})
    return {menus: (page.data || []).map(menu => ({id: menu.id, name: menu.name, description: menu.description || '', currency: menu.currency, walletId: menu.wallet_id, lightningEnabled: menu.lightning_enabled === true, manualEnabled: menu.manual_enabled === true, manualInstructions: menu.manual_instructions || '', active: menu.active === true, createdAt: menu.created_at, updatedAt: menu.updated_at})), total: Number(page.total || 0)}
  }
  function createMenu(request) {
    const data = request && typeof request === 'object' ? request : fail('Input must be an object.')
    const timestamp = timestampNow(host)
    const menu = menuFields(data, null, host)
    const row = {...menu, id: id(host.system.id('menu'), 'menuId'), created_at: timestamp, updated_at: timestamp}
    save(host, TABLES.MENUS, row)
    return {menu: row}
  }
  function updateMenu(request) {
    const menu = menuFor(host, valueOf(request, 'menuId', 'menu_id'))
    const updated = menuFields({...menu, ...(request || {})}, menu, host)
    updated.updated_at = timestampNow(host)
    save(host, TABLES.MENUS, updated)
    return {menu: updated}
  }
  function listItems(request) {
    const menuId = id(valueOf(request, 'menuId', 'menu_id'), 'menuId')
    menuFor(host, menuId)
    const page = host.storage.getPaginated(TABLES.ITEMS, {filters: {menu_id: menuId}, limit: 100, offset: 0})
    return {items: (page.data || []).slice().sort(itemOrder).map(privateItem), total: Number(page.total || 0)}
  }
  function privateItem(item) { return {...publicItem(item), menuId: item.menu_id, soldOut: item.sold_out === true, createdAt: item.created_at, updatedAt: item.updated_at} }
  function createItem(request) {
    const menuId = id(valueOf(request, 'menuId', 'menu_id'), 'menuId')
    menuFor(host, menuId)
    const timestamp = timestampNow(host)
    const row = {id: id(host.system.id('item'), 'itemId'), menu_id: menuId, name: text(valueOf(request, 'name'), 'name', 120, true), description: text(valueOf(request, 'description'), 'description', 1000), price: decimalString(valueOf(request, 'price'), 'price'), position: integer(valueOf(request, 'position') === undefined ? 0 : valueOf(request, 'position'), 'position', 0, 1000000), active: bool(valueOf(request, 'active'), 'active', true), sold_out: bool(valueOf(request, 'soldOut', 'sold_out'), 'soldOut', false), created_at: timestamp, updated_at: timestamp}
    save(host, TABLES.ITEMS, row)
    return {item: privateItem(row)}
  }
  function updateItem(request) {
    const item = host.storage.get(TABLES.ITEMS, id(valueOf(request, 'itemId', 'item_id'), 'itemId'))
    if (!item) fail('Item not found.')
    const updated = {...item}
    if (valueOf(request, 'name') !== undefined) updated.name = text(valueOf(request, 'name'), 'name', 120, true)
    if (valueOf(request, 'description') !== undefined) updated.description = text(valueOf(request, 'description'), 'description', 1000)
    if (valueOf(request, 'price') !== undefined) updated.price = decimalString(valueOf(request, 'price'), 'price')
    if (valueOf(request, 'position') !== undefined) updated.position = integer(valueOf(request, 'position'), 'position', 0, 1000000)
    if (valueOf(request, 'active') !== undefined) updated.active = bool(valueOf(request, 'active'), 'active')
    if (valueOf(request, 'soldOut', 'sold_out') !== undefined) updated.sold_out = bool(valueOf(request, 'soldOut', 'sold_out'), 'soldOut')
    updated.updated_at = timestampNow(host)
    save(host, TABLES.ITEMS, updated)
    return {item: privateItem(updated)}
  }
  function listOrders(request = {}) {
    const filters = {}
    const menuId = valueOf(request, 'menuId', 'menu_id')
    if (menuId) filters.menu_id = id(menuId, 'menuId')
    const status = valueOf(request, 'status')
    if (status) filters.status = text(status, 'status', 30, true)
    const requestedLimit = valueOf(request, 'limit')
    const requestedOffset = valueOf(request, 'offset')
    const page = host.storage.getPaginated(TABLES.ORDERS, {filters, limit: requestedLimit === undefined ? 100 : integer(requestedLimit, 'limit', 1, 100), offset: requestedOffset === undefined ? 0 : integer(requestedOffset, 'offset', 0, 1000000), sortBy: 'created_at', descending: true})
    const orders = (page.data || []).map(expireIfNeeded).sort((left, right) =>
      orderPriority(left) - orderPriority(right) || Number(right.created_at || 0) - Number(left.created_at || 0)
    )
    return {orders: orders.map(order => privateOrder(host, order)), total: Number(page.total || 0)}
  }
  function markManualPaid(request) {
    const order = orderFor(host, valueOf(request, 'orderId', 'order_id'))
    if (order.payment_method !== 'manual' || order.status !== 'manual_pending') fail('Only pending manual orders can be marked paid.')
    const timestamp = timestampNow(host)
    const updated = {...order, status: 'paid', payment_status: 'paid', fulfillment_status: 'unfulfilled', paid_at: timestamp, updated_at: timestamp}
    save(host, TABLES.ORDERS, updated)
    return {order: privateOrder(host, updated)}
  }
  function completeOrder(request) {
    const order = orderFor(host, valueOf(request, 'orderId', 'order_id'))
    if (!['paid', 'manual_pending'].includes(order.status)) fail('This order cannot be completed in its current state.')
    const timestamp = timestampNow(host)
    const updated = {...order, status: 'completed', fulfillment_status: 'completed', completed_at: timestamp, updated_at: timestamp}
    save(host, TABLES.ORDERS, updated)
    return {order: privateOrder(host, updated)}
  }
  function cancelOrder(request) {
    const order = orderFor(host, valueOf(request, 'orderId', 'order_id'))
    if (['paid', 'completed'].includes(order.status) || order.payment_status === 'paid') fail('Paid orders cannot be cancelled.')
    if (!['pending_payment', 'manual_pending', 'expired'].includes(order.status)) fail('This order cannot be cancelled.')
    const timestamp = timestampNow(host)
    const updated = {...order, status: 'cancelled', payment_status: 'cancelled', cancelled_at: timestamp, updated_at: timestamp}
    save(host, TABLES.ORDERS, updated)
    return {order: privateOrder(host, updated)}
  }
  function getPublicMenu(request) {
    const menu = menuFor(host, valueOf(request, 'menuId', 'menu_id'))
    if (menu.active !== true) fail('This menu is not active.')
    const items = itemRows(host, menu.id).filter(item => item.active === true)
    return {menu: publicMenu(menu, items), checkoutToken: id(host.system.id('checkout'), 'checkoutToken')}
  }
  function findCheckoutOrder(token) {
    const page = host.storage.getPaginated(TABLES.ORDERS, {filters: {checkout_token: token}, limit: 2, offset: 0})
    return (page.data || [])[0] || null
  }
  function createOrder(request) {
    const menu = menuFor(host, valueOf(request, 'menuId', 'menu_id'))
    if (menu.active !== true) fail('This menu is not active.')
    const token = id(valueOf(request, 'checkoutToken', 'checkout_token'), 'checkoutToken')
    const existing = findCheckoutOrder(token)
    if (existing) {
      if (existing.menu_id !== menu.id) fail('Checkout token does not belong to this menu.')
      const current = expireIfNeeded(existing)
      const attempt = current.attempt_id ? host.storage.get(TABLES.ATTEMPTS, current.attempt_id) : null
      return invoiceResponse(current, attempt && attempt.status === 'pending' ? attempt : null)
    }
    const method = requestedMethod(menu, request)
    const cart = validateCart(host, menu, request)
    const order = orderFromCheckout(host, menu, request, token, cart, method)
    if (method === 'manual') {
      save(host, TABLES.ORDERS, order)
      return {order: publicOrder(order)}
    }
    const attemptId = id(host.system.id('attempt'), 'attemptId')
    let invoice
    try {
      invoice = host.wallet.createInvoicePublic({sourceId: menu.id, amount: invoiceAmount(order.total), currency: order.currency, memo: `PopMenu order ${order.order_number}`, extra: {order_id: order.id, attempt_id: attemptId, checkout_token: token}})
    } catch (_) {
      const failed = {...order, status: 'expired', payment_status: 'expired', updated_at: timestampNow(host)}
      save(host, TABLES.ORDERS, failed)
      return invoiceResponse(failed, null)
    }
    if (!invoice || !invoice.paymentHash || !invoice.paymentRequest) {
      const failed = {...order, status: 'expired', payment_status: 'expired', updated_at: timestampNow(host)}
      save(host, TABLES.ORDERS, failed)
      return invoiceResponse(failed, null)
    }
    let details
    try {
      details = invoiceDetails(host, invoice, order.total, order.currency)
    } catch (_) {
      const failed = {...order, status: 'expired', payment_status: 'expired', updated_at: timestampNow(host)}
      save(host, TABLES.ORDERS, failed)
      return invoiceResponse(failed, null)
    }
    const attempt = {id: attemptId, order_id: order.id, menu_id: menu.id, payment_hash: invoice.paymentHash, checking_id: invoice.checkingId || '', bolt11: invoice.paymentRequest, amount: order.total, amount_msat: details.amountMsat, currency: order.currency, expires_at: details.expiresAt, status: 'pending', created_at: timestampNow(host), paid_at: null}
    save(host, TABLES.ATTEMPTS, attempt)
    const updated = {...order, attempt_id: attempt.id, updated_at: timestampNow(host)}
    save(host, TABLES.ORDERS, updated)
    return invoiceResponse(updated, attempt)
  }
  function expireIfNeeded(order) {
    if (order.status !== 'pending_payment' || !order.attempt_id) return order
    const attempt = host.storage.get(TABLES.ATTEMPTS, order.attempt_id)
    if (!attempt || attempt.status !== 'pending' || !attempt.expires_at || attempt.expires_at > timestampNow(host)) return order
    const updatedAttempt = {...attempt, status: 'expired'}
    save(host, TABLES.ATTEMPTS, updatedAttempt)
    const updatedOrder = {...order, status: 'expired', payment_status: 'expired', updated_at: timestampNow(host)}
    save(host, TABLES.ORDERS, updatedOrder)
    return updatedOrder
  }
  function confirmation(request) {
    const order = expireIfNeeded(orderFor(host, valueOf(request, 'orderId', 'order_id')))
    const attempt = order.status === 'pending_payment' && order.attempt_id
      ? host.storage.get(TABLES.ATTEMPTS, order.attempt_id)
      : null
    return invoiceResponse(order, attempt && attempt.status === 'pending' ? attempt : null)
  }
  function retryPayment(request) {
    let order = expireIfNeeded(orderFor(host, valueOf(request, 'orderId', 'order_id')))
    if (order.payment_method !== 'lightning') fail('Only Lightning orders can be retried.')
    if (order.status === 'paid' || order.status === 'completed') fail('This order is already paid.')
    if (order.status !== 'expired') fail('The current invoice has not expired.')
    const menu = menuFor(host, order.menu_id)
    if (menu.active !== true || menu.lightning_enabled !== true) fail('Lightning payment is not currently available.')
    const attemptId = id(host.system.id('attempt'), 'attemptId')
    const invoice = host.wallet.createInvoicePublic({sourceId: menu.id, amount: invoiceAmount(order.total), currency: order.currency, memo: `PopMenu order ${order.order_number}`, extra: {order_id: order.id, attempt_id: attemptId, checkout_token: order.checkout_token}})
    if (!invoice || !invoice.paymentHash || !invoice.paymentRequest) fail('Invoice creation failed.')
    const details = invoiceDetails(host, invoice, order.total, order.currency)
    const attempt = {id: attemptId, order_id: order.id, menu_id: menu.id, payment_hash: invoice.paymentHash, checking_id: invoice.checkingId || '', bolt11: invoice.paymentRequest, amount: order.total, amount_msat: details.amountMsat, currency: order.currency, expires_at: details.expiresAt, status: 'pending', created_at: timestampNow(host), paid_at: null}
    save(host, TABLES.ATTEMPTS, attempt)
    order = {...order, status: 'pending_payment', payment_status: 'pending', attempt_id: attempt.id, updated_at: timestampNow(host)}
    save(host, TABLES.ORDERS, order)
    return invoiceResponse(order, attempt)
  }
  function handleInvoicePaid(event) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) fail('Payment event is invalid.')
    const payment = event.payment && typeof event.payment === 'object' ? event.payment : {}
    const hash = text(event.paymentHash || event.payment_hash || payment.paymentHash || payment.payment_hash, 'paymentHash', 200, true)
    if (!/^[0-9a-f]{64}$/i.test(hash)) fail('Payment hash is invalid.')
    const extension = event.extension || payment.extension
    const extra = event.extra && typeof event.extra === 'object' ? event.extra : {}
    const tag = event.tag || payment.tag || extra.tag
    if (extension !== 'popmenu' || tag !== 'popmenu' || event.pending === true || payment.pending === true || (event.status || payment.status) !== 'success') fail('Payment event is not a confirmed PopMenu settlement.')
    const nested = objectValue(extra.extra_popmenu || (payment.extra && payment.extra.extra_popmenu))
    const orderId = id(nested.order_id || extra.order_id || payment.extra?.order_id, 'orderId')
    const attemptId = id(nested.attempt_id || extra.attempt_id || payment.extra?.attempt_id, 'attemptId')
    const order = orderFor(host, orderId)
    const sourceId = extra.source_id || payment.extra?.source_id
    if (sourceId !== order.menu_id) fail('Payment event source does not match this menu.')
    const attempt = host.storage.get(TABLES.ATTEMPTS, attemptId)
    if (!attempt || attempt.order_id !== order.id || attempt.payment_hash !== hash) fail('Payment event does not match this order.')
    const amount = event.amount ?? payment.amount
    const eventCurrency = event.currency || payment.currency
    if (eventCurrency && String(eventCurrency).toLowerCase() !== String(attempt.currency).toLowerCase()) fail('Payment currency does not match this order.')
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount !== attempt.amount_msat) fail('Payment amount does not match this order.')
    const settlement = host.storage.get(TABLES.SETTLEMENTS, hash)
    if (settlement) {
      if (settlement.order_id !== order.id || settlement.attempt_id !== attempt.id || settlement.amount_msat !== attempt.amount_msat) fail('Payment settlement conflicts with this order.')
      return {settled: true, order: publicOrder(order)}
    }
    if (!['pending_payment', 'expired'].includes(order.status)) fail('This order was already settled or is no longer payable.')
    const timestamp = timestampNow(host)
    save(host, TABLES.SETTLEMENTS, {id: hash, order_id: order.id, attempt_id: attempt.id, menu_id: order.menu_id, amount: attempt.amount, amount_msat: attempt.amount_msat, paid_at: timestamp})
    save(host, TABLES.ATTEMPTS, {...attempt, status: 'paid', paid_at: timestamp})
    const updated = {...order, status: 'paid', payment_status: 'paid', paid_at: timestamp, updated_at: timestamp}
    save(host, TABLES.ORDERS, updated)
    return {settled: true, order: publicOrder(updated)}
  }
  return {listCurrencies, listWallets, listMenus, createMenu, updateMenu, listItems, createItem, updateItem, listOrders, markManualPaid, completeOrder, cancelOrder, getPublicMenu, createOrder, confirmation, retryPayment, handleInvoicePaid}
}
