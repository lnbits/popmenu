(function (global) {
  'use strict'
  var Vue = global.Vue
  var client = global.createLNbitsExtensionClient({extensionId: 'popmenu'})
  var h = Vue.h
  function text(value, fallback) { return value === undefined || value === null ? (fallback || '') : String(value) }
  function list(value, keys) { if (Array.isArray(value)) return value; for (var i = 0; i < keys.length; i += 1) if (Array.isArray(value && value[keys[i]])) return value[keys[i]]; return [] }
  function errorText(error) { return error instanceof Error ? error.message : String(error || 'Request failed.') }
  function money(value, currency) { return text(value, '0') + (currency ? ' ' + text(currency) : '') }
  function orderStatus(order) { var lifecycle = text(order && (order.status || order.orderStatus)).toLowerCase(); return ['pending_payment', 'manual_pending', 'paid', 'completed', 'cancelled', 'expired'].includes(lifecycle) ? lifecycle : text(order && (order.payment_status || order.paymentStatus || order.status), 'pending').toLowerCase() }
  function orderStatusLabel(order) { var status = orderStatus(order); return {pending_payment: 'Awaiting payment', manual_pending: 'Waiting for seller', paid: 'Paid', completed: 'Completed', cancelled: 'Cancelled', expired: 'Invoice expired'}[status] || 'Order received' }
  function paymentConfirmed(order) { return ['paid', 'completed'].includes(text(order && (order.payment_status || order.paymentStatus)).toLowerCase()) }
  function paidPaymentPin(order) {
    var paymentStatus = text(order && (order.payment_status || order.paymentStatus)).toLowerCase()
    var pin = text(order && (order.paymentPin || order.payment_pin))
    return paymentStatus === 'paid' && /^\d{3}-\d{3}$/.test(pin) ? pin : ''
  }
  function invoiceFrom(response, order) { return response && response.invoice ? response.invoice : (response && (response.bolt11 || response.payment_request || response.paymentRequest || response.payment_hash || response.paymentHash) ? response : (order && order.invoice) || null) }
  function btn(label, onClick, props) { var QBtn = Vue.resolveComponent('q-btn'); return h(QBtn, Object.assign({label: label, type: 'button', color: 'primary', unelevated: true, noCaps: true, onClick: onClick}, props || {})) }
  function field(label, value, onInput, type) { var QInput = Vue.resolveComponent('q-input'); return h('div', {class: 'col-12'}, [h(QInput, {label: label, modelValue: text(value), 'onUpdate:modelValue': onInput, type: type || 'text', filled: true, dense: true, dark: true})]) }
  function qr(value, size) { var component = global.QrcodeVue && (global.QrcodeVue.default || global.QrcodeVue); return value && component ? h('div', {class: 'pop-qr'}, [h(component, {value: 'lightning:' + String(value).toUpperCase(), size: size || 220, margin: 3, level: 'Q'})]) : h('div', {class: 'pop-qr text-dark'}, ['QR unavailable']) }

  var App = {
    data: function () { return {
      loading: true, submitting: false, error: '', context: {}, menu: null, items: [], cart: {}, checkoutToken: '', savedCheckout: null,
      checkoutOpen: false, order: null, invoice: null, paymentSubscription: null, pollTimer: null, pollCount: 0,
      form: {customer_name: '', customer_note: '', table_label: '', location_label: '', payment_method: 'lightning'}, retrying: false
    } },
    computed: {
      cartLines: function () { var self = this; return Object.keys(this.cart).map(function (id) { var line = self.cart[id]; var item = self.items.find(function (candidate) { return text(candidate.id) === text(id) }); return item ? {item: item, quantity: line.quantity, note: line.note || ''} : null }).filter(Boolean) },
      estimatedTotal: function () { return this.cartLines.reduce(function (total, line) { var value = Number(line.item.price); return total + (Number.isFinite(value) ? value * line.quantity : 0) }, 0).toFixed(2) },
      hasCart: function () { return this.cartLines.length > 0 },
      isConfirmation: function () { return Boolean(this.order) },
      activeMenuId: function () { return text(this.context.routeParams && (this.context.routeParams.menuId || this.context.routeParams.menu_id)) },
      activeOrderId: function () { return text(this.context.routeParams && (this.context.routeParams.orderId || this.context.routeParams.order_id)) }
    },
    mounted: async function () { try { this.context = await client.context(); var query = this.context.query || {}; this.form.table_label = text(query.table); this.form.location_label = text(query.location); if (this.activeOrderId) await this.loadOrder(this.activeOrderId); else { await this.loadMenu(this.activeMenuId); await this.restoreSession() } } catch (error) { this.fail(error) } finally { this.loading = false } },
    beforeUnmount: function () { if (this.pollTimer) global.clearInterval(this.pollTimer); this.stopPaymentWatch(); client.close() },
    methods: {
      fail: function (error) { this.error = errorText(error); client.notifyError(error).catch(function () {}) },
      async loadMenu (id) { if (!id) throw new Error('Menu link is missing a menu identifier.'); var result = await client.publicMenu(id); this.menu = result.menu || result; var menuItems = list(result, ['items']); if (!menuItems.length) menuItems = list(this.menu, ['items']); this.items = menuItems.filter(function (item) { return item.active !== false && item.sold_out !== true && item.soldOut !== true }); this.checkoutToken = text(result.checkoutToken || result.checkout_token || (this.menu && (this.menu.checkoutToken || this.menu.checkout_token))); if (this.form.payment_method === 'lightning' && this.menu.lightning_enabled === false && this.menu.lightningEnabled === false) this.form.payment_method = 'manual' },
      add: function (item) { if (!item || item.active === false || item.sold_out === true || item.soldOut === true) return; var current = this.cart[item.id] || {quantity: 0, note: ''}; this.cart = Object.assign({}, this.cart, {[item.id]: {quantity: Math.min(99, current.quantity + 1), note: current.note || ''}}); this.persistCart() },
      change: function (item, delta) { var current = this.cart[item.id]; if (!current) return; var quantity = current.quantity + delta; if (quantity <= 0) { var next = Object.assign({}, this.cart); delete next[item.id]; this.cart = next } else this.cart = Object.assign({}, this.cart, {[item.id]: {quantity: Math.min(99, quantity), note: current.note || ''}}); this.persistCart() },
      clearCart: function () { this.cart = {}; this.persistCart() },
      setNote: function (item, note) { var current = this.cart[item.id]; if (!current) return; this.cart = Object.assign({}, this.cart, {[item.id]: {quantity: current.quantity, note: text(note).slice(0, 240)}}); this.persistCart() },
      persistCart: function () { client.sessionSet('cart', JSON.stringify({menuId: this.activeMenuId, cart: this.cart})).catch(function () {}) },
      async restoreSession () {
        try {
          var rawCart = await client.sessionGet('cart'); var savedCart = rawCart ? JSON.parse(rawCart) : null
          if (savedCart && text(savedCart.menuId) === this.activeMenuId && savedCart.cart && typeof savedCart.cart === 'object') {
            var restored = {}; var allowed = this.items.map(function (item) { return text(item.id) })
            Object.keys(savedCart.cart).forEach(function (id) { var row = savedCart.cart[id]; if (allowed.includes(text(id)) && row && Number(row.quantity) > 0) restored[id] = {quantity: Math.min(99, Math.floor(Number(row.quantity))), note: text(row.note).slice(0, 240)} })
            this.cart = restored
          }
          var rawCheckout = await client.sessionGet('checkout'); var checkout = rawCheckout ? JSON.parse(rawCheckout) : null
          if (checkout && checkout.orderId && text(checkout.menuId) === this.activeMenuId) this.savedCheckout = checkout
          var rawToken = await client.sessionGet('checkout-token'); var tokenState = rawToken ? JSON.parse(rawToken) : null
          if (tokenState && text(tokenState.menuId) === this.activeMenuId && tokenState.token) this.checkoutToken = text(tokenState.token)
          else if (this.checkoutToken) await client.sessionSet('checkout-token', JSON.stringify({menuId: this.activeMenuId, token: this.checkoutToken}))
        } catch (_) {}
      },
      async continueSaved () { if (!this.savedCheckout || !this.savedCheckout.orderId) return; await this.loadOrder(this.savedCheckout.orderId); await client.replace('/ext/popmenu/order/' + encodeURIComponent(this.savedCheckout.orderId)).catch(function () {}); this.savedCheckout = null },
      startFreshSaved: function () { this.savedCheckout = null; this.cart = {}; this.checkoutToken = ''; client.sessionSet('cart', '').catch(function () {}); client.sessionSet('checkout', '').catch(function () {}); client.sessionSet('checkout-token', '').catch(function () {}) },
      openCheckout: function () { if (!this.hasCart || this.submitting) return; if (this.menu && this.menu.lightning_enabled === false && this.menu.lightningEnabled === false && this.menu.manual_enabled === false && this.menu.manualEnabled === false) { this.fail(new Error('This menu is not accepting orders.')); return } this.checkoutOpen = true },
      closeCheckout: function () { if (!this.submitting) this.checkoutOpen = false },
      async checkout () {
        if (!this.hasCart || this.submitting || !this.menu) return
        this.submitting = true
        var body = {checkout_token: this.checkoutToken, items: this.cartLines.map(function (line) { return {item_id: line.item.id, quantity: line.quantity, note: line.note || undefined} }), customer_name: text(this.form.customer_name).trim() || undefined, customer_note: text(this.form.customer_note).trim() || undefined, table_label: text(this.form.table_label).trim() || undefined, location_label: text(this.form.location_label).trim() || undefined, payment_method: this.form.payment_method}
        try { var response = await client.publicOrders(this.activeMenuId, body); this.order = response.order || response; this.invoice = invoiceFrom(response, this.order); this.checkoutOpen = false; await client.sessionSet('checkout', JSON.stringify({orderId: this.order.id, menuId: this.activeMenuId})); if (this.invoice && (this.invoice.payment_hash || this.invoice.paymentHash)) await this.startPaymentWatch(this.invoice.payment_hash || this.invoice.paymentHash); this.startPolling(); await client.notify('Order created.', 'positive'); await client.replace('/ext/popmenu/order/' + encodeURIComponent(this.order.id)) } catch (error) { this.fail(error) } finally { this.submitting = false }
      },
      async loadOrder (id) { var response = await client.publicOrder(id); this.order = response.order || response; this.invoice = invoiceFrom(response, this.order); if (this.invoice && (this.invoice.payment_hash || this.invoice.paymentHash)) await this.startPaymentWatch(this.invoice.payment_hash || this.invoice.paymentHash); this.startPolling() },
      refreshOrder: async function () { if (!this.order || !this.order.id) return; try { var response = await client.publicOrder(this.order.id); var next = response.order || response; this.order = next; if (['paid', 'completed', 'cancelled', 'expired'].includes(text(next.payment_status || next.paymentStatus || next.status))) this.stopPaymentWatch() } catch (_) {} },
      startPolling: function () { var self = this; if (this.pollTimer) global.clearInterval(this.pollTimer); this.pollCount = 0; this.pollTimer = global.setInterval(async function () { if (!self.order || self.pollCount++ > 100) { global.clearInterval(self.pollTimer); self.pollTimer = null; return } await self.refreshOrder() }, 3000) },
      async startPaymentWatch (hash) { this.stopPaymentWatch(); try { this.paymentSubscription = await client.paymentSubscribe(hash, function (event) { if (event && event.event === 'payment.settled') this.refreshOrder() }.bind(this)) } catch (_) {} },
      stopPaymentWatch: function () { if (this.paymentSubscription) { this.paymentSubscription.unsubscribe().catch(function () {}); this.paymentSubscription = null } },
      async retry () { if (!this.order || this.retrying) return; this.retrying = true; try { var response = await client.retryOrder(this.order.id); this.order = response.order || response; this.invoice = invoiceFrom(response, this.order); if (this.invoice && (this.invoice.payment_hash || this.invoice.paymentHash)) await this.startPaymentWatch(this.invoice.payment_hash || this.invoice.paymentHash); this.startPolling() } catch (error) { this.fail(error) } finally { this.retrying = false } },
      startNew: function () { var menuId = this.activeMenuId || (this.order && (this.order.menu_id || this.order.menuId)) || ''; this.order = null; this.invoice = null; this.cart = {}; this.checkoutToken = ''; this.savedCheckout = null; client.sessionSet('cart', '').catch(function () {}); client.sessionSet('checkout', '').catch(function () {}); client.sessionSet('checkout-token', '').catch(function () {}); this.stopPaymentWatch(); if (this.pollTimer) global.clearInterval(this.pollTimer); this.pollTimer = null; if (menuId) client.replace('/ext/popmenu/menu/' + encodeURIComponent(menuId)).catch(function () {}) },
      copyInvoice: async function () { var value = text(this.invoice && (this.invoice.bolt11 || this.invoice.payment_request || this.invoice.paymentRequest)); if (!value) return; try { await global.navigator.clipboard.writeText(value); await client.notify('Invoice copied.', 'positive') } catch (error) { this.fail(error) } },
      copyOrder: async function () { var orderId = text(this.order && this.order.id); var value = orderId ? new URL('/ext/popmenu/order/' + encodeURIComponent(orderId), global.location.href).href : ''; if (!value) return; try { await global.navigator.clipboard.writeText(value); await client.notify('Confirmation link copied.', 'positive') } catch (error) { this.fail(error) } }
    },
    render: function () {
      var self = this
      var error = this.error ? h('div', {class: 'q-banner bg-negative text-white q-pa-sm q-mb-md', role: 'alert'}, [this.error]) : null
      var loading = this.loading ? h('div', {class: 'q-pa-xl text-center'}, ['Loading menu…']) : null
      var header = this.menu ? h('header', {class: 'q-mb-lg'}, [h('div', {class: 'text-h4'}, [text(this.menu.name, 'Menu')]), this.menu.description ? h('p', {class: 'pop-muted pop-wrap'}, [text(this.menu.description)]) : null, this.form.table_label || this.form.location_label ? h('div', {class: 'q-banner bg-grey-10 q-pa-sm'}, ['For ', text(this.form.table_label || this.form.location_label)]) : null]) : null
      var cards = this.items.map(function (item) {
        var inCart = self.cart[item.id] && self.cart[item.id].quantity || 0
        var QInput = Vue.resolveComponent('q-input')
        var quantity = inCart
          ? h('div', {class: 'row items-center q-gutter-sm'}, [btn('−', function () { self.change(item, -1) }, {class: 'pop-quantity-btn', round: true, dense: true, ariaLabel: 'Remove one ' + text(item.name)}), h('span', {class: 'text-weight-bold text-center pop-quantity'}, [String(inCart)]), btn('+', function () { self.add(item) }, {class: 'pop-quantity-btn', round: true, dense: true, ariaLabel: 'Add one ' + text(item.name)})])
          : btn('Add to cart', function () { self.add(item) }, {icon: 'add', class: 'pop-add-btn'})
        var note = inCart ? h(QInput, {class: 'q-mt-md', label: 'Item note (optional)', modelValue: self.cart[item.id].note || '', 'onUpdate:modelValue': function (value) { self.setNote(item, value) }, maxlength: 240, counter: true, filled: true, dense: true, dark: true}) : null
        return h('div', {class: 'col-12 col-sm-6 col-lg-4', key: item.id}, [h('article', {class: 'q-card pop-menu-item'}, [h('div', {class: 'pop-menu-item__body q-pa-md'}, [h('div', {class: 'row items-start no-wrap q-col-gutter-md'}, [h('div', {class: 'col'}, [h('h2', {class: 'text-subtitle1 text-weight-bold q-my-none pop-wrap'}, [text(item.name)]), item.description ? h('p', {class: 'pop-muted pop-wrap q-my-sm'}, [text(item.description)]) : null]), h('div', {class: 'pop-menu-item__price pop-price'}, [money(item.price, self.menu.currency)])]), h('div', {class: 'row items-center justify-between q-mt-lg'}, [quantity]), note])])])
      })
      var menuContent = this.menu ? h('div', {class: 'row q-col-gutter-lg'}, [h('div', {class: 'col-12 col-md-8'}, [h('div', {class: 'row q-col-gutter-md'}, cards)]), h('aside', {class: 'col-12 col-md-4'}, [h('section', {class: 'q-card pop-cart-card q-pa-md pop-sticky-cart'}, [h('div', {class: 'row items-center'}, [h('h2', {class: 'text-h6 q-my-none'}, ['Cart']), h('div', {class: 'col'}), h('span', {class: 'pop-price text-weight-bold'}, [money(this.estimatedTotal, this.menu.currency)])]), this.cartLines.length ? this.cartLines.map(function (line) { return h('div', {class: 'row q-mt-sm', key: line.item.id}, [h('span', {class: 'col pop-wrap'}, [String(line.quantity) + ' × ' + text(line.item.name)]), h('span', {class: 'pop-price'}, [money(Number(line.item.price) * line.quantity, self.menu.currency)])]) }) : [h('p', {class: 'pop-muted'}, ['Your cart is empty.']),], btn('Checkout', this.openCheckout, {class: 'full-width q-mt-lg', disabled: !this.hasCart}), btn('Clear cart', this.clearCart, {class: 'full-width q-mt-sm', color: 'negative', flat: true, disabled: !this.hasCart})])])]) : null
      var manualInstructions = text((this.order && (this.order.manualInstructions || this.order.manual_instructions)) || (this.menu && (this.menu.manual_instructions || this.menu.manualInstructions)))
      var currentOrderStatus = orderStatus(this.order)
      var confirmationItems = this.order ? list(this.order, ['items']) : []
      var confirmationContext = this.order ? [text(this.order.tableLabel || this.order.table_label), text(this.order.locationLabel || this.order.location_label)].filter(Boolean).join(' · ') : ''
      var confirmationPin = paidPaymentPin(this.order)
      var invoiceValue = text(this.invoice && (this.invoice.bolt11 || this.invoice.payment_request || this.invoice.paymentRequest))
      var pendingPayment = this.order && currentOrderStatus === 'pending_payment' && invoiceValue
      var paymentPanel = pendingPayment ? h('section', {class: 'pop-payment-panel q-mt-lg'}, [
        h('div', {class: 'pop-payment-eyebrow'}, ['Lightning payment']),
        h('h3', {class: 'text-h6 text-weight-bold q-my-sm'}, ['Complete payment']),
        h('p', {class: 'pop-muted q-my-none'}, ['Scan with your Lightning wallet or copy the invoice below.']),
        h('div', {class: 'pop-payment-amount'}, [money(this.order.total, this.order.currency || (this.menu && this.menu.currency))]),
        qr(invoiceValue, 280),
        h('div', {class: 'row justify-center q-gutter-sm q-mt-md'}, [btn('Copy invoice', this.copyInvoice, {flat: true, icon: 'content_copy'}), h('span', {class: 'pop-payment-status'}, ['Waiting for payment'])])
      ]) : null
      var confirmation = this.order ? h('section', {class: 'q-card q-pa-lg q-mt-lg pop-status pop-confirmation'}, [
        h('div', {class: 'row items-start q-col-gutter-md'}, [h('div', {class: 'col'}, [h('div', {class: 'pop-confirmation-eyebrow'}, ['Order confirmation']), h('h2', {class: 'text-h5 text-weight-bold q-my-xs'}, ['#' + text(this.order.order_number || this.order.orderNumber || this.order.id).slice(0, 16)]), h('p', {class: 'pop-muted q-my-none'}, [orderStatusLabel(this.order)])]), btn('Start new order', this.startNew, {flat: true})]),
        confirmationItems.length ? h('div', {class: 'pop-order-lines q-my-lg'}, confirmationItems.map(function (item) { return h('div', {class: 'row q-py-sm', key: item.item_id || item.itemId}, [h('span', {class: 'col'}, [String(item.quantity) + ' × ' + text(item.name)]), h('span', {class: 'pop-price'}, [money(item.price, self.order.currency)])]) })) : null,
        h('div', {class: 'row items-center q-mt-md'}, [h('span', {class: 'pop-muted col'}, ['Total']), h('strong', {class: 'pop-price text-h6'}, [money(this.order.total, this.order.currency || (this.menu && this.menu.currency))])]),
        confirmationContext ? h('p', {class: 'pop-muted q-mb-none q-mt-sm'}, [confirmationContext]) : null,
        paymentPanel,
        text(this.order.payment_method || this.order.paymentMethod) === 'manual' && manualInstructions ? h('div', {class: 'pop-instructions q-mt-lg pop-wrap'}, [h('div', {class: 'text-caption text-weight-bold q-mb-xs'}, ['Payment instructions']), manualInstructions]) : null,
        currentOrderStatus === 'manual_pending' ? h('div', {class: 'pop-awaiting q-mt-lg'}, ['Your order is with the seller. It will update here when they confirm payment.']) : null,
        currentOrderStatus === 'expired' ? btn(this.retrying ? 'Retrying…' : 'Retry payment', this.retry, {disabled: this.retrying, class: 'q-mt-lg'}) : null,
        confirmationPin ? h('div', {class: 'pop-payment-pin pop-payment-pin--customer q-mt-lg'}, [h('span', {class: 'pop-payment-pin__label'}, ['Payment PIN']), h('strong', {class: 'pop-payment-pin__value'}, [confirmationPin])]) : null,
        paymentConfirmed(this.order) ? h('div', {class: 'pop-seller-handoff q-mt-lg'}, ['Payment received — show this confirmation to the seller.']) : null,
        h('div', {class: 'row q-gutter-sm q-mt-lg'}, [btn('Copy confirmation link', this.copyOrder, {flat: true, icon: 'link'})])
      ]) : null
      var checkout = this.checkoutOpen ? h('div', {class: 'pop-modal-backdrop'}, [h('section', {class: 'q-card pop-modal q-pa-md', role: 'dialog', 'aria-modal': 'true'}, [h('div', {class: 'row items-center'}, [h('h2', {class: 'text-h6 q-my-none'}, ['Checkout']), h('div', {class: 'col'}), btn('Close', this.closeCheckout, {class: 'q-btn q-btn-item q-btn--flat text-white'})]), h('div', {class: 'row q-col-gutter-md q-mt-md'}, [field('Name (optional)', this.form.customer_name, function (v) { self.form.customer_name = v }), field('Table', this.form.table_label, function (v) { self.form.table_label = v }), field('Location', this.form.location_label, function (v) { self.form.location_label = v }), field('Order note (optional)', this.form.customer_note, function (v) { self.form.customer_note = v })]), h('div', {class: 'q-mt-md'}, [h('div', {class: 'text-caption'}, ['Payment method']), this.menu.lightning_enabled !== false && this.menu.lightningEnabled !== false ? h('label', {class: 'q-mr-md'}, [h('input', {type: 'radio', name: 'payment_method', value: 'lightning', checked: this.form.payment_method === 'lightning', onChange: function () { self.form.payment_method = 'lightning' }}), ' Lightning']) : null, this.menu.manual_enabled !== false && this.menu.manualEnabled !== false ? h('label', [h('input', {type: 'radio', name: 'payment_method', value: 'manual', checked: this.form.payment_method === 'manual', onChange: function () { self.form.payment_method = 'manual' }}), ' Manual']) : null]), h('div', {class: 'row q-gutter-sm q-mt-md'}, [btn(this.submitting ? 'Submitting…' : 'Place order', this.checkout, {disabled: this.submitting || !this.hasCart}), btn('Cancel', this.closeCheckout, {class: 'q-btn q-btn-item q-btn--flat text-white'})])])]) : null
      var continuation = this.savedCheckout && !this.order ? h('section', {class: 'q-banner bg-warning text-dark q-pa-md q-mb-md'}, [h('div', {class: 'text-subtitle1'}, ['You have an order in progress.']), h('div', {class: 'q-mt-sm row q-gutter-sm'}, [btn('Continue payment', this.continueSaved, {class: 'bg-dark text-white'}), btn('Start a new order', this.startFreshSaved, {class: 'q-btn q-btn-item q-btn--flat text-dark'})])]) : null
      return h('main', {class: 'pop-shell q-pa-md'}, [loading, error, header, continuation, menuContent, confirmation, checkout])
    }
  }
  var app = Vue.createApp(App)
  if (global.QrcodeVue) app.component('qrcode-vue', global.QrcodeVue.default || global.QrcodeVue)
  if (global.Quasar) app.use(global.Quasar)
  app.mount('#app')
  global.PopMenuPublicApp = App
})(window)
