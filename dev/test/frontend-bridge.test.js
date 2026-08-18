import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

class Port {
  constructor() { this.listeners = [] ; this.peer = null }
  addEventListener(type, listener) { if (type === 'message') this.listeners.push(listener) }
  removeEventListener(type, listener) { if (type === 'message') this.listeners = this.listeners.filter(item => item !== listener) }
  start() {}
  close() {}
  postMessage(data) { if (this.peer) this.peer.listeners.slice().forEach(listener => listener({data})) }
}

class Channel {
  constructor() {
    this.port1 = new Port()
    this.port2 = new Port()
    this.port1.peer = this.port2
    this.port2.peer = this.port1
  }
}

function loadSdk(parentPostMessage) {
  const window = {
    MessageChannel: Channel,
    parent: {postMessage: parentPostMessage},
    location: {href: 'https://example.test/ext-frame/popmenu/0'},
    URL,
    setTimeout,
    clearTimeout,
    Promise,
    Map,
    Date
  }
  const context = vm.createContext({window, URL, setTimeout, clearTimeout, Promise, Map, Date})
  vm.runInContext(fs.readFileSync(path.join(root, 'static/lnbits-extension-sdk.js'), 'utf8'), context)
  return window.createLNbitsExtensionClient({extensionId: 'popmenu', timeout: 200})
}

test('bridge connects over MessageChannel and unwraps the API envelope', async () => {
  let hostPort
  const client = loadSdk((message, _origin, ports) => {
    hostPort = ports[0]
    hostPort.postMessage({type: 'lnbits-extension:connected', id: message.id})
    hostPort.addEventListener('message', event => {
      if (event.data.action === 'api') {
        assert.equal(event.data.method, 'GET')
        assert.equal(event.data.path, '/api/v1/ext/popmenu/public/menus/m-1')
        hostPort.postMessage({type: 'lnbits-extension:response', id: event.data.id, ok: true, data: {ok: true, data: {id: 'm-1'}}})
      }
    })
  })
  assert.deepEqual(await client.publicMenu('m-1'), {id: 'm-1'})
  client.close()
})

test('bridge rejects host errors and validates resource path identifiers', async () => {
  const client = loadSdk((message, _origin, ports) => {
    const port = ports[0]
    port.postMessage({type: 'lnbits-extension:connected', id: message.id})
    port.addEventListener('message', event => port.postMessage({type: 'lnbits-extension:response', id: event.data.id, ok: false, error: 'Denied'}))
  })
  await assert.rejects(client.api('GET', '/api/v1/ext/popmenu/orders'), /Denied/)
  assert.throws(() => client.publicMenu('../private'), /Invalid resource identifier/)
  client.close()
})

test('frontend files stay CSP-safe and expose rendered button handlers', () => {
  const files = ['static/lnbits-extension-sdk.js', 'static/admin.js', 'static/public.js'].map(file => fs.readFileSync(path.join(root, file), 'utf8'))
  for (const source of files) {
    assert.doesNotMatch(source, /(?:new\s+Function|\beval\s*\(|innerHTML|\bfetch\s*\()/)
  }
  const admin = files[1]
  const publicPage = files[2]
  assert.match(admin, /type:\s*['"]button['"]/)
  assert.match(publicPage, /type:\s*['"]button['"]|type:\s*['"]radio['"]/)
  assert.match(admin, /saveMenu\s*\(/)
  assert.match(admin, /orderAction\s*\(/)
  assert.match(publicPage, /checkout\s*\(/)
  assert.match(publicPage, /retry\s*\(/)
  assert.match(publicPage, /paymentSubscribe/)
  assert.match(admin, /resolveComponent\(['"]q-card['"]\)/)
  assert.match(admin, /resolveComponent\(['"]q-input['"]\)/)
  assert.match(admin, /resolveComponent\(['"]q-select['"]\)/)
  assert.match(admin, /resolveComponent\(['"]q-btn['"]\)/)
  assert.doesNotMatch(admin, /setInterval\(this\.loadOrders/)
  assert.match(admin, /setInterval\(function \(\) \{ self\.loadOrders\(\) \}/)
  assert.match(publicPage, /resolveComponent\(['"]q-input['"]\)/)
  assert.match(publicPage, /pop-menu-item/)
  assert.match(publicPage, /col-12 col-sm-6 col-lg-4/)
  const css = fs.readFileSync(path.join(root, 'static/app.css'), 'utf8')
  const adminHtml = fs.readFileSync(path.join(root, 'ui/admin.html'), 'utf8')
  assert.match(css, /\[v-cloak\]/)
  assert.match(css, /\.pop-panel/)
  assert.match(adminHtml, /data-theme="bitcoin"/)
  assert.match(adminHtml, /admin\.js\?v=ui-8/)
  assert.match(adminHtml, /lnbits-extension-sdk\.js\?v=ui-8/)
  assert.match(fs.readFileSync(path.join(root, 'ui/public.html'), 'utf8'), /public\.js\?v=ui-8/)
})

function loadPublicApp(fakeClient) {
  const h = (type, props, children) => {
    if (Array.isArray(props)) return {type, props: {}, children: props}
    return {type, props: props || {}, children: typeof children === 'function' ? children() : (children === undefined ? [] : children)}
  }
  const Vue = {
    h,
    resolveComponent: name => name,
    createApp: () => ({use() { return this }, component() { return this }, mount() { return this }})
  }
  const window = {
    Vue,
    Quasar: null,
    QrcodeVue: null,
    createLNbitsExtensionClient: () => fakeClient,
    location: {href: 'https://example.test/ext/popmenu/menu/m-1'},
    setInterval: () => 1,
    clearInterval: () => {},
    navigator: {clipboard: {writeText: async () => {}}},
    parent: {}
  }
  const context = vm.createContext({window, URL, Promise, Map, Date, setTimeout, clearTimeout})
  vm.runInContext(fs.readFileSync(path.join(root, 'static/public.js'), 'utf8'), context)
  return window.PopMenuPublicApp
}

function loadAdminApp(fakeClient, intervalCallbacks = []) {
  const h = (type, props, children) => {
    if (Array.isArray(props)) return {type, props: {}, children: props}
    return {type, props: props || {}, children: typeof children === 'function' ? children() : (children === undefined ? [] : children)}
  }
  const Vue = {h, resolveComponent: name => name, createApp: () => ({use() { return this }, component() { return this }, mount() { return this }})}
  const window = {Vue, Quasar: null, QrcodeVue: null, createLNbitsExtensionClient: () => fakeClient, location: {href: 'https://example.test/ext/popmenu'}, setInterval: callback => { intervalCallbacks.push(callback); return intervalCallbacks.length }, clearInterval: () => {}, navigator: {clipboard: {writeText: async () => {}}}, print() {}}
  vm.runInContext(fs.readFileSync(path.join(root, 'static/admin.js'), 'utf8'), vm.createContext({window, URL, Promise, Map, Date, setTimeout, clearTimeout}))
  return window.PopMenuAdminApp
}

function bindAdminState(App, state) {
  Object.assign(state, App.methods)
  for (const [name, getter] of Object.entries(App.computed)) Object.defineProperty(state, name, {configurable: true, get: () => getter.call(state)})
  return state
}

function bindPublicState(App, state) {
  Object.assign(state, App.methods)
  for (const [name, getter] of Object.entries(App.computed)) Object.defineProperty(state, name, {configurable: true, get: () => getter.call(state)})
  return state
}

function findButton(node, label) {
  if (!node) return null
  if ((node.type === 'button' && node.children && node.children.some(child => child === label)) || (node.type === 'q-btn' && node.props.label === label)) return node
  const children = Array.isArray(node.children) ? node.children : [node.children]
  for (const child of children) {
    const found = findButton(child, label)
    if (found) return found
  }
  return null
}

test('public rendered checkout button validates cart and submits the expected snapshot', async () => {
  const calls = []
  const fakeClient = {
    publicOrders: async (menuId, body) => { calls.push({menuId, body}); return {order: {id: 'order-1', payment_status: 'pending'}}},
    sessionSet: async (...args) => calls.push({sessionSet: args}),
    notify: async () => {},
    paymentSubscribe: async () => ({unsubscribe: async () => {}}),
    publicOrder: async () => ({order: {id: 'order-1', payment_status: 'pending'}}),
    notifyError: async () => {},
    replace: async () => {}
  }
  const App = loadPublicApp(fakeClient)
  const state = bindPublicState(App, Object.assign(App.data(), {
    loading: false,
    context: {routeParams: {menuId: 'm-1'}, query: {}},
    menu: {id: 'm-1', name: 'Menu', currency: 'sat'},
    items: [{id: 'i-1', name: 'Tea', price: '2.50', active: true}],
    cart: {}
  }))
  let tree = App.render.call(state)
  assert.equal(findButton(tree, 'Checkout').props.disabled, true)

  state.cart = {'i-1': {quantity: 2, note: 'Less ice'}}
  tree = App.render.call(state)
  const checkoutButton = findButton(tree, 'Checkout')
  assert.equal(checkoutButton.props.disabled, false)
  checkoutButton.props.onClick.call(state)
  assert.equal(state.checkoutOpen, true)

  tree = App.render.call(state)
  const placeOrder = findButton(tree, 'Place order')
  assert.equal(placeOrder.props.disabled, false)
  await placeOrder.props.onClick.call(state)
  assert.deepEqual(JSON.parse(JSON.stringify(calls.find(call => call.menuId))), {
    menuId: 'm-1',
    body: {checkout_token: '', items: [{item_id: 'i-1', quantity: 2, note: 'Less ice'}], payment_method: 'lightning'}
  })
  assert.equal(state.order.id, 'order-1')
  assert.equal(state.checkoutOpen, false)
})

test('public menu loading accepts envelope-level items/token and clears persisted cart for a new order', async () => {
  const sessionWrites = []
  const fakeClient = {
    publicMenu: async () => ({menu: {id: 'm-1', currency: 'sat'}, items: [{id: 'i-1', name: 'Tea', price: '2.50'}], checkout_token: 'token-1'}),
    sessionSet: async (...args) => sessionWrites.push(args),
    replace: async () => {},
    notifyError: async () => {}
  }
  const App = loadPublicApp(fakeClient)
  const state = bindPublicState(App, Object.assign(App.data(), {context: {routeParams: {menuId: 'm-1'}, query: {}}}))
  await state.loadMenu('m-1')
  assert.equal(state.items.length, 1)
  assert.equal(state.checkoutToken, 'token-1')
  state.cart = {'i-1': {quantity: 1, note: ''}}
  state.startNew()
  assert.ok(sessionWrites.some(([key, value]) => key === 'cart' && value === ''))
})

test('saved checkout reset clears cart and token while confirmation renders seller details', () => {
  const sessionWrites = []
  const fakeClient = {sessionSet: (...args) => { sessionWrites.push(args); return Promise.resolve() }, notifyError: async () => {}, replace: async () => {}}
  const App = loadPublicApp(fakeClient)
  const state = bindPublicState(App, Object.assign(App.data(), {
    loading: false,
    context: {routeParams: {orderId: 'order-1'}, query: {}},
    savedCheckout: {orderId: 'order-1', menuId: 'menu-1'},
    cart: {'item-1': {quantity: 1, note: ''}},
    checkoutToken: 'checkout-1',
    order: {id: 'order-1', orderNumber: '42', paymentStatus: 'paid', status: 'paid', paymentPin: '123-456', currency: 'sat', total: '5', tableLabel: 'Table 7', items: [{item_id: 'item-1', name: 'Tea', price: '2.5', quantity: 2}]}
  }))
  const rendered = JSON.stringify(App.render.call(state))
  assert.match(rendered, /2 × Tea/)
  assert.match(rendered, /Table 7/)
  assert.match(rendered, /show this confirmation to the seller/)
  assert.match(rendered, /Payment PIN/)
  assert.match(rendered, /123-456/)
  state.startFreshSaved()
  assert.equal(state.savedCheckout, null)
  assert.equal(Object.keys(state.cart).length, 0)
  assert.equal(state.checkoutToken, '')
  for (const key of ['cart', 'checkout', 'checkout-token']) assert.ok(sessionWrites.some(([written, value]) => written === key && value === ''))
})

test('admin render uses Quasar panels and shows complete merchant order details', () => {
  const App = loadAdminApp({close() {}, notifyError: async () => {}})
  const menu = {id: 'menu-1', name: 'Tonight', currency: 'sat', active: true}
  const state = bindAdminState(App, Object.assign(App.data(), {
    loading: false,
    menus: [menu],
    selectedMenu: menu,
    items: [],
    orders: [{id: 'order-1', orderNumber: '42', createdAt: 1_700_000_000, status: 'paid', paymentStatus: 'paid', paymentPin: '654-321', paymentMethod: 'lightning', paymentRequest: 'lnbc1exampleinvoice', currency: 'sat', total: '5', tableLabel: 'Table 7', customerName: 'Alice', customerNote: 'No sugar', items: [{item_id: 'item-1', name: 'Tea', price: '2.5', quantity: 2}]}]
  }))
  const rendered = JSON.stringify(App.render.call(state))
  assert.match(rendered, /"type":"q-card"/)
  assert.match(rendered, /2 × Tea/)
  assert.match(rendered, /Table 7/)
  assert.match(rendered, /Alice/)
  assert.match(rendered, /No sugar/)
  assert.match(rendered, /pop-print-poster/)
  assert.match(rendered, /Payment PIN/)
  assert.match(rendered, /654-321/)
  assert.match(rendered, /Show invoice/)
})

test('admin hides PINs for manual orders and opens their Lightning invoice dialog', () => {
  const App = loadAdminApp({close() {}, notifyError: async () => {}})
  const state = bindAdminState(App, Object.assign(App.data(), {
    loading: false,
    menus: [{id: 'menu-1', name: 'Tonight', currency: 'sat', active: true}],
    selectedMenu: {id: 'menu-1', name: 'Tonight', currency: 'sat', active: true},
    orders: [{id: 'manual-1', status: 'paid', paymentStatus: 'paid', paymentMethod: 'manual', paymentPin: '111-222', total: '1', items: []}, {id: 'lightning-1', status: 'pending_payment', paymentStatus: 'pending', paymentMethod: 'lightning', paymentRequest: 'lnbc1exampleinvoice', total: '1', items: []}]
  }))
  let rendered = JSON.stringify(App.render.call(state))
  assert.doesNotMatch(rendered, /111-222/)
  const showInvoice = findButton(App.render.call(state), 'Show invoice')
  assert.ok(showInvoice)
  showInvoice.props.onClick.call(state)
  rendered = JSON.stringify(App.render.call(state))
  assert.match(rendered, /Show payment at counter/)
  assert.match(rendered, /Copy invoice/)
})

test('payment PIN is shown only for a formatted paid payment status, including completed orders', () => {
  const App = loadPublicApp({close() {}, notifyError: async () => {}})
  const state = bindPublicState(App, Object.assign(App.data(), {
    loading: false,
    menu: {currency: 'sat'},
    order: {id: 'order-1', status: 'completed', paymentStatus: 'paid', payment_pin: '112-233', total: '1', items: []}
  }))
  let rendered = JSON.stringify(App.render.call(state))
  assert.match(rendered, /Payment PIN/)
  assert.match(rendered, /112-233/)

  state.order = {id: 'order-1', status: 'paid', paymentStatus: 'pending', paymentPin: '445-566', total: '1', items: []}
  rendered = JSON.stringify(App.render.call(state))
  assert.doesNotMatch(rendered, /Payment PIN/)
  assert.doesNotMatch(rendered, /445-566/)

  state.order = {id: 'order-1', status: 'completed', paymentStatus: 'paid', paymentPin: '123456', total: '1', items: []}
  rendered = JSON.stringify(App.render.call(state))
  assert.doesNotMatch(rendered, /Payment PIN/)
})

test('pending Lightning confirmation has a focused payment panel and no seller handoff', () => {
  const App = loadPublicApp({close() {}, notifyError: async () => {}})
  const state = bindPublicState(App, Object.assign(App.data(), {
    loading: false,
    menu: {currency: 'sat'},
    order: {id: 'order-1', status: 'pending_payment', paymentStatus: 'pending', total: '1', items: []},
    invoice: {bolt11: 'lnbc1exampleinvoice'}
  }))
  const rendered = JSON.stringify(App.render.call(state))
  assert.match(rendered, /pop-payment-panel/)
  assert.match(rendered, /Complete payment/)
  assert.match(rendered, /Waiting for payment/)
  assert.doesNotMatch(rendered, /Show this to the seller/)
  assert.doesNotMatch(rendered, /pop-seller-handoff/)
})

test('public cart clear button empties cart and persists the empty cart', () => {
  const writes = []
  const App = loadPublicApp({sessionSet: async (...args) => writes.push(args), notifyError: async () => {}})
  const state = bindPublicState(App, Object.assign(App.data(), {
    menu: {id: 'menu-1', currency: 'sat'},
    context: {routeParams: {menuId: 'menu-1'}, query: {}},
    items: [{id: 'item-1', name: 'Tea', price: '1'}],
    cart: {'item-1': {quantity: 2, note: ''}}
  }))
  const clearButton = findButton(App.render.call(state), 'Clear cart')
  assert.equal(clearButton.props.disabled, false)
  clearButton.props.onClick.call(state)
  assert.equal(Object.keys(state.cart).length, 0)
  assert.ok(writes.some(([key, value]) => key === 'cart' && JSON.parse(value).cart && Object.keys(JSON.parse(value).cart).length === 0))
})

test('admin queue dispatches manual-paid, complete, and cancel actions', async () => {
  const actions = []
  const fakeClient = {
    orderAction: async (...args) => { actions.push(args); return {} },
    orders: async () => [],
    notify: async () => {},
    notifyError: async () => {}
  }
  const App = loadAdminApp(fakeClient)
  const state = bindAdminState(App, Object.assign(App.data(), {saving: false}))
  for (const action of ['manual-paid', 'complete', 'cancel']) await state.orderAction({id: 'order-1'}, action)
  assert.deepEqual(actions.map(([id, action]) => [id, action]), [
    ['order-1', 'manual-paid'],
    ['order-1', 'complete'],
    ['order-1', 'cancel']
  ])
  assert.equal(state.saving, false)
})

test('admin queue polling keeps the Vue receiver and refreshes orders', async () => {
  const intervals = []
  let orderCall = 0
  const fakeClient = {
    wallets: async () => [],
    menus: async () => [],
    items: async () => [],
    orders: async () => orderCall++ === 0 ? [{id: 'old'}] : [{id: 'new'}],
    notifyError: async () => {}
  }
  const App = loadAdminApp(fakeClient, intervals)
  const state = bindAdminState(App, Object.assign(App.data(), {saving: false}))
  await App.mounted.call(state)
  assert.equal(intervals.length, 1)
  assert.deepEqual(state.orders.map(order => order.id), ['old'])
  await intervals[0]()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(state.orders.map(order => order.id), ['new'])
})

test('admin menu currency comes from supported currencies, not the first wallet currency', async () => {
  const fakeClient = {
    currencies: async () => ({currencies: ['EUR', 'sat']}),
    wallets: async () => [{id: 'wallet-1', name: 'Till', currency: 'sat'}],
    menus: async () => [],
    orders: async () => [],
    notifyError: async () => {}
  }
  const App = loadAdminApp(fakeClient)
  const state = bindAdminState(App, App.data())
  await App.mounted.call(state)
  state.newMenu()
  assert.deepEqual(state.currencies, ['EUR', 'sat'])
  assert.equal(state.menuForm.currency, 'EUR')
  assert.match(JSON.stringify(App.render.call(state)), /q-select/)
})

test('public manual checkout dispatches manual payment without subscribing to an invoice', async () => {
  const calls = []
  const fakeClient = {
    publicOrders: async (menuId, body) => { calls.push([menuId, body]); return {order: {id: 'order-1', payment_status: 'manual_pending'}} },
    sessionSet: async () => {},
    notify: async () => {},
    paymentSubscribe: async () => { throw new Error('manual checkout must not subscribe') },
    notifyError: async () => {},
    publicOrder: async () => ({order: {id: 'order-1', payment_status: 'manual_pending'}})
  }
  const App = loadPublicApp(fakeClient)
  const state = bindPublicState(App, Object.assign(App.data(), {
    context: {routeParams: {menuId: 'menu-1'}, query: {}},
    menu: {id: 'menu-1', currency: 'sat', lightning_enabled: false, manual_enabled: true},
    items: [{id: 'item-1', name: 'Coffee', price: '3'}],
    cart: {'item-1': {quantity: 1, note: 'No sugar'}},
    form: {customer_name: 'Alice', customer_note: 'Ready now', table_label: 'T1', location_label: '', payment_method: 'manual'}
  }))
  await state.checkout()
  assert.equal(calls.length, 1)
  const [menuId, body] = calls[0]
  assert.equal(menuId, 'menu-1')
  assert.equal(body.payment_method, 'manual')
  assert.deepEqual(JSON.parse(JSON.stringify(body.items)), [{item_id: 'item-1', quantity: 1, note: 'No sugar'}])
  assert.equal(state.order.payment_status, 'manual_pending')
  assert.equal(state.invoice, null)
})

test('public expired invoice retry creates a fresh attempt and watches its payment hash', async () => {
  const retries = []
  const hashes = []
  const fakeClient = {
    retryOrder: async id => { retries.push(id); return {order: {id, payment_status: 'pending_payment'}, invoice: {payment_hash: 'hash-2', bolt11: 'lnbc-new'}} },
    paymentSubscribe: async (hash) => { hashes.push(hash); return {unsubscribe: async () => {}} },
    publicOrder: async () => ({order: {id: 'order-1', payment_status: 'pending_payment'}}),
    notifyError: async () => {}
  }
  const App = loadPublicApp(fakeClient)
  const state = bindPublicState(App, Object.assign(App.data(), {order: {id: 'order-1', payment_status: 'expired'}}))
  await state.retry()
  assert.deepEqual(retries, ['order-1'])
  assert.deepEqual(hashes, ['hash-2'])
  assert.equal(state.invoice.bolt11, 'lnbc-new')
  assert.equal(state.retrying, false)
})

test('public payment settlement refreshes the confirmation exactly through the payment event', async () => {
  let callback
  let refreshes = 0
  const fakeClient = {
    paymentSubscribe: async (_hash, handler) => { callback = handler; return {unsubscribe: async () => {}} },
    publicOrder: async () => { refreshes += 1; return {order: {id: 'order-1', payment_status: 'paid'}} },
    notifyError: async () => {}
  }
  const App = loadPublicApp(fakeClient)
  const state = bindPublicState(App, Object.assign(App.data(), {order: {id: 'order-1', payment_status: 'pending_payment'}}))
  await state.startPaymentWatch('hash-1')
  await callback({event: 'payment.settled'})
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(refreshes, 1)
  assert.equal(state.order.payment_status, 'paid')
})
