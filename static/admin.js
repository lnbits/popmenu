(function (global) {
  'use strict'
  var Vue = global.Vue
  var client = global.createLNbitsExtensionClient({extensionId: 'popmenu'})
  var h = Vue.h

  function list(value, keys) {
    if (Array.isArray(value)) return value
    for (var i = 0; i < keys.length; i += 1) if (Array.isArray(value && value[keys[i]])) return value[keys[i]]
    return []
  }
  function text(value, fallback) { return value === undefined || value === null ? (fallback || '') : String(value) }
  function money(value, currency) { return text(value, '0') + (currency ? ' ' + text(currency) : '') }
  function configuredCurrencies() {
    var configured = []
    try {
      configured = global.g && (global.g.allowedCurrencies || global.g.currencies || [])
    } catch (_) {}
    if (!Array.isArray(configured)) configured = []
    if (!configured.length) {
      try { if (global.g && Array.isArray(global.g.currencies)) configured = global.g.currencies } catch (_) {}
    }
    return Array.from(new Set(configured.map(function (value) { return text(value).trim() }).filter(Boolean)))
  }
  function paidPaymentPin(order) {
    var paymentStatus = text(order && (order.payment_status || order.paymentStatus)).toLowerCase()
    var paymentMethod = text(order && (order.payment_method || order.paymentMethod)).toLowerCase()
    var pin = text(order && (order.paymentPin || order.payment_pin))
    return paymentMethod !== 'manual' && paymentMethod && paymentStatus === 'paid' && /^\d{3}-\d{3}$/.test(pin) ? pin : ''
  }
  function paymentRequest(order) { return text(order && (order.paymentRequest || order.payment_request || order.bolt11)) }
  function when(value) { var date = new Date(Number(value || 0) * 1000); return Number.isFinite(date.getTime()) ? date.toLocaleString() : '' }
  function safeError(error) { return error instanceof Error ? error.message : String(error || 'Request failed.') }
  function btn(label, onClick, props) {
    var QBtn = Vue.resolveComponent('q-btn')
    return h(QBtn, Object.assign({label: label, type: 'button', color: 'primary', unelevated: true, noCaps: true, onClick: onClick}, props || {}))
  }
  function field(label, value, onInput, type) {
    var QInput = Vue.resolveComponent('q-input')
    return h('div', {class: 'col-12 col-md-6'}, [h(QInput, {label: label, modelValue: text(value), 'onUpdate:modelValue': onInput, type: type || 'text', filled: true, dense: true, dark: true})])
  }
  function selectField(label, value, options, onInput) {
    var QSelect = Vue.resolveComponent('q-select')
    return h('div', {class: 'col-12 col-md-6'}, [h(QSelect, {label: label, modelValue: text(value), options: options, 'onUpdate:modelValue': onInput, emitValue: true, filled: true, dense: true, dark: true, hint: 'Independent of the selected wallet.'})])
  }
  function card(title, body, actions) {
    var QCard = Vue.resolveComponent('q-card')
    var QCardSection = Vue.resolveComponent('q-card-section')
    return h(QCard, {dark: true, flat: true, bordered: true, class: 'pop-panel q-mt-md'}, function () { return [
      h(QCardSection, {class: 'row items-center q-pb-sm'}, function () { return [h('h2', {class: 'text-h6 text-weight-bold q-my-none'}, [title]), h('div', {class: 'col'}), actions || null] }),
      h(QCardSection, {class: 'q-pt-sm'}, function () { return [body] })
    ] })
  }

  var App = {
    data: function () { return {
      loading: true, saving: false, error: '', currencies: configuredCurrencies(), wallets: [], menus: [], items: [], orders: [], selectedMenu: null, invoiceOrder: null,
      menuOpen: false, itemOpen: false, shareOpen: false, selectedOrder: null, pollTimer: null,
      menuForm: {id: '', name: '', description: '', currency: 'sat', wallet_id: '', lightning_enabled: true, manual_enabled: true, manual_instructions: '', active: true},
      itemForm: {id: '', menu_id: '', name: '', description: '', price: '', position: 0, active: true, sold_out: false}, share: {table: '', location: ''}
    } },
    computed: {
      publicUrl: function () { return this.menuPublicUrl(this.selectedMenu) },
      currencyOptions: function () { var options = this.currencies.slice(); var current = text(this.menuForm.currency).trim(); if (current && !options.includes(current)) options.push(current); return options },
      selectedItems: function () { return this.items.filter(function (item) { return text(item.menu_id || item.menuId) === text(this.selectedMenu && this.selectedMenu.id) }.bind(this)) }
    },
    mounted: async function () { var self = this; await this.load(); this.pollTimer = global.setInterval(function () { self.loadOrders() }, 15000) },
    beforeUnmount: function () { if (this.pollTimer) global.clearInterval(this.pollTimer); client.close() },
    methods: {
      async load () {
        this.loading = true; this.error = ''
        try {
          var configured = configuredCurrencies()
          var currencyRequest = configured.length || typeof client.currencies !== 'function' ? Promise.resolve(configured) : client.currencies()
          var result = await Promise.all([client.wallets(), client.menus(), client.orders(), currencyRequest])
          this.currencies = list(result[3], ['currencies', 'data']); if (!this.currencies.length) this.currencies = configured
          this.wallets = list(result[0], ['wallets', 'data']); this.menus = list(result[1], ['menus', 'data']); this.orders = list(result[2], ['orders', 'data'])
          if (this.selectedMenu) await this.selectMenu(this.selectedMenu)
          else if (this.menus.length) await this.selectMenu(this.menus[0])
        } catch (error) { this.error = safeError(error); client.notifyError(error).catch(function () {}) } finally { this.loading = false }
      },
      async loadOrders () { try { this.orders = list(await client.orders(), ['orders', 'data']) } catch (_) {} },
      async selectMenu (menu) { this.selectedMenu = menu; try { this.items = list(await client.items(menu.id), ['items', 'data']).map(function (item) { return Object.assign({}, item, {menu_id: item.menu_id || item.menuId, sold_out: item.sold_out === true || item.soldOut === true}) }) } catch (error) { this.error = safeError(error) } },
      menuPublicUrl: function (menu) { if (!menu || !menu.id || !global.location) return ''; return new URL('/ext/popmenu/menu/' + encodeURIComponent(menu.id), global.location.href).href },
      editMenu: function (menu) { this.menuForm = {id: menu.id || '', name: menu.name || '', description: menu.description || '', currency: menu.currency || 'sat', wallet_id: menu.wallet_id || menu.walletId || '', lightning_enabled: menu.lightning_enabled !== false && menu.lightningEnabled !== false, manual_enabled: menu.manual_enabled === true || menu.manualEnabled === true, manual_instructions: menu.manual_instructions || menu.manualInstructions || '', active: menu.active !== false}; this.menuOpen = true },
      newMenu: function () { var wallet = this.wallets[0] || {}; this.menuForm = {id: '', name: '', description: '', currency: this.currencies[0] || 'sat', wallet_id: wallet.id || '', lightning_enabled: true, manual_enabled: true, manual_instructions: '', active: true}; this.menuOpen = true },
      async saveMenu () {
        if (!text(this.menuForm.name).trim() || this.saving) return
        this.saving = true
        var body = Object.assign({}, this.menuForm, {name: text(this.menuForm.name).trim(), description: text(this.menuForm.description).trim() || null})
        try {
          var saved
          if (body.id) saved = await client.menu(body.id, body, 'PATCH')
          else saved = await client.menus(body)
          this.menuOpen = false; await this.load(); var savedMenu = saved && (saved.menu || saved.data || saved); if (savedMenu && savedMenu.id) await this.selectMenu(savedMenu); await client.notify('Menu saved.', 'positive')
        } catch (error) { this.error = safeError(error); await client.notifyError(error).catch(function () {}) } finally { this.saving = false }
      },
      editItem: function (item) { this.itemForm = Object.assign({}, this.itemForm, item, {id: item.id || '', menu_id: this.selectedMenu.id}); this.itemOpen = true },
      newItem: function () { this.itemForm = {id: '', menu_id: this.selectedMenu && this.selectedMenu.id || '', name: '', description: '', price: '', position: this.items.length, active: true, sold_out: false}; this.itemOpen = true },
      async saveItem () {
        if (!text(this.itemForm.name).trim() || !text(this.itemForm.price).trim() || this.saving) return
        this.saving = true; var body = Object.assign({}, this.itemForm, {name: text(this.itemForm.name).trim(), description: text(this.itemForm.description).trim() || null})
        try {
          if (body.id) await client.item(body.id, body, 'PATCH'); else await client.items(body.menu_id, body)
          this.itemOpen = false; await this.selectMenu(this.selectedMenu); await client.notify('Item saved.', 'positive')
        } catch (error) { this.error = safeError(error); await client.notifyError(error).catch(function () {}) } finally { this.saving = false }
      },
      async orderAction (order, action) { if (!order || !order.id || this.saving) return; this.saving = true; try { await client.orderAction(order.id, action); await this.loadOrders(); await client.notify('Order updated.', 'positive') } catch (error) { this.error = safeError(error); await client.notifyError(error).catch(function () {}) } finally { this.saving = false } },
      async showInvoice (order) {
        if (!order || text(order.payment_method || order.paymentMethod).toLowerCase() === 'manual') return
        var invoice = paymentRequest(order)
        if (!invoice) {
          try {
            var response = await client.publicOrder(order.id)
            var confirmation = response && (response.order || response)
            invoice = paymentRequest(response) || paymentRequest(confirmation)
            if (invoice) order = Object.assign({}, order, confirmation, {paymentRequest: invoice})
          } catch (error) { this.error = safeError(error); return }
        }
        if (invoice) this.invoiceOrder = order
        else this.error = 'No active Lightning invoice is available for this order.'
      },
      closeInvoice: function () { this.invoiceOrder = null },
      async copy (value) { try { await global.navigator.clipboard.writeText(value); await client.notify('Link copied.', 'positive') } catch (error) { await client.notifyError(error).catch(function () {}) } },
      shareUrl: function () { var url = this.publicUrl; var query = []; if (text(this.share.table).trim()) query.push('table=' + encodeURIComponent(text(this.share.table).trim())); if (text(this.share.location).trim()) query.push('location=' + encodeURIComponent(text(this.share.location).trim())); return url + (query.length ? '?' + query.join('&') : '') },
      openPublic: function () { var url = this.shareUrl(); if (url) client.openNewTab(url).catch(function (error) { client.notifyError(error).catch(function () {}) }) },
      printPoster: function () { if (global.print) global.print() }
    },
    render: function () {
      var self = this
      var title = h('div', {class: 'row items-center q-mb-md q-gutter-sm'}, [h('img', {class: 'popmenu-mark', src: '/ext-assets/popmenu/assets/icon.png', alt: ''}), h('div', [h('h1', {class: 'text-h4 text-weight-bold q-my-none'}, ['PopMenu']), h('p', {class: 'text-subtitle2 text-grey-5 q-my-none'}, ['Menu and order queue'])]), h('div', {class: 'col'}), btn('New menu', this.newMenu, {icon: 'add'})])
      var loading = this.loading ? h('div', {class: 'q-banner bg-grey-10 q-pa-sm q-mb-md', role: 'status'}, ['Loading PopMenu…']) : null
      var error = this.error ? h('div', {class: 'q-banner bg-negative text-white q-pa-sm q-mb-md', role: 'alert'}, [this.error]) : null
      var menus = card('Menus', h('div', {class: 'row q-col-gutter-sm'}, this.menus.length ? this.menus.map(function (menu) { return h('div', {class: 'col-12 col-md-4', key: menu.id}, [h('button', {type: 'button', class: 'full-width text-left q-pa-md rounded-borders ' + (self.selectedMenu && self.selectedMenu.id === menu.id ? 'bg-primary text-white' : 'bg-grey-10 text-white'), onClick: function () { self.selectMenu(menu) }}, [h('div', {class: 'text-subtitle1'}, [text(menu.name, 'Untitled menu')]), h('div', {class: 'text-caption'}, [text(menu.currency), menu.active === false ? ' · inactive' : ' · active'])])]) }) : [h('p', {class: 'pop-muted'}, ['Create your first menu.'])]), btn('Edit', function () { if (self.selectedMenu) self.editMenu(self.selectedMenu) }, {class: 'q-btn q-btn-item q-btn--flat text-primary q-mr-sm'}))
      var itemBody = this.selectedMenu ? h('div', [h('div', {class: 'row justify-between items-center q-mb-sm'}, [h('span', {class: 'pop-muted'}, [text(this.selectedMenu.name)]), btn('Add item', this.newItem)]), h('div', {class: 'row q-col-gutter-sm'}, this.items.length ? this.items.map(function (item) { return h('div', {class: 'col-12 col-md-6', key: item.id}, [h('div', {class: 'q-pa-md bg-grey-10 rounded-borders'}, [h('div', {class: 'row'}, [h('strong', [text(item.name)]), h('div', {class: 'col'}), h('span', {class: 'pop-price'}, [money(item.price, self.selectedMenu.currency)])]), item.description ? h('div', {class: 'pop-muted pop-wrap q-mt-xs'}, [text(item.description)]) : null, h('div', {class: 'text-caption q-mt-sm'}, [item.active === false ? 'Inactive' : 'Active', item.sold_out ? ' · Sold out' : '']), btn('Edit', function () { self.editItem(item) }, {class: 'q-btn q-btn-item q-btn--flat text-primary q-mt-sm'})])]) }) : [h('p', {class: 'pop-muted'}, ['No items yet.'])])]) : h('p', {class: 'pop-muted'}, ['Select a menu to manage its items.'])
      var itemsCard = card('Items', itemBody)
      var qrComponent = global.QrcodeVue && (global.QrcodeVue.default || global.QrcodeVue)
      var shareCard = this.selectedMenu ? card('Share menu', h('div', {class: 'row q-col-gutter-md'}, [h('div', {class: 'col-12 col-md-7'}, [h('p', {class: 'pop-wrap'}, [this.shareUrl()]), h('div', {class: 'row q-col-gutter-sm'}, [field('Table (optional)', this.share.table, function (v) { self.share.table = v }), field('Location (optional)', this.share.location, function (v) { self.share.location = v })]), h('div', {class: 'row q-gutter-sm q-mt-md'}, [btn('Copy link', function () { self.copy(self.shareUrl()) }), btn('Open public menu', this.openPublic, {class: 'q-btn q-btn-item q-btn--flat text-primary'}), btn('Print poster', this.printPoster, {class: 'q-btn q-btn-item q-btn--flat text-primary'})])]), h('div', {class: 'col-12 col-md-5'}, [h('div', {class: 'pop-qr bg-white text-dark'}, [qrComponent ? h(qrComponent, {value: this.shareUrl(), size: 200, level: 'M'}) : 'QR unavailable'])])])) : null
      if (shareCard) shareCard = h('div', {class: 'pop-print-poster'}, [shareCard])
      var ordersCard = card('Order queue', h('div', {class: 'q-gutter-y-sm'}, this.orders.length ? this.orders.map(function (order) {
        var status = text(order.payment_status || order.paymentStatus || order.status, 'pending')
        var orderStatus = text(order.status, status)
        var method = text(order.payment_method || order.paymentMethod)
        var rows = Array.isArray(order.items) ? order.items : []
        var place = [text(order.tableLabel || order.table_label), text(order.locationLabel || order.location_label)].filter(Boolean).join(' · ')
        var customer = text(order.customerName || order.customer_name)
        var note = text(order.customerNote || order.customer_note)
        var paymentPin = paidPaymentPin(order)
        return h('article', {class: 'q-pa-md bg-grey-10 rounded-borders', key: order.id}, [
          h('div', {class: 'row items-start q-gutter-sm'}, [h('div', [h('strong', ['#' + text(order.order_number || order.orderNumber || order.id).slice(0, 12)]), h('div', {class: 'text-caption pop-muted'}, [when(order.createdAt || order.created_at)])]), h('div', {class: 'col'}), h('div', {class: 'text-right'}, [h('div', {class: 'text-caption'}, [orderStatus]), h('div', {class: 'text-caption pop-muted'}, [method + ' · ' + status])])]),
          rows.length ? h('div', {class: 'pop-order-lines q-my-sm'}, rows.map(function (item) { return h('div', {class: 'row q-py-xs', key: item.item_id || item.itemId}, [h('span', {class: 'col'}, [String(item.quantity) + ' × ' + text(item.name)]), h('span', {class: 'pop-price'}, [money(item.price, order.currency)])]) })) : null,
          h('div', {class: 'text-weight-bold q-mt-xs'}, [money(order.total, order.currency)]),
          paymentPin ? h('div', {class: 'pop-payment-pin pop-payment-pin--merchant q-mt-md'}, [h('span', {class: 'pop-payment-pin__label'}, ['Payment PIN']), h('strong', {class: 'pop-payment-pin__value'}, [paymentPin])]) : null,
          place ? h('div', {class: 'text-caption pop-muted'}, [place]) : null,
          customer ? h('div', {class: 'q-mt-xs'}, ['Customer: ', customer]) : null,
          note ? h('div', {class: 'text-caption pop-muted pop-wrap'}, [note]) : null,
          h('div', {class: 'row q-gutter-sm q-mt-sm'}, [method !== 'manual' && method ? btn('Show invoice', function () { self.showInvoice(order) }, {flat: true, icon: 'qr_code_2'}) : null, method === 'manual' && status === 'manual_pending' ? btn('Mark paid', function () { self.orderAction(order, 'manual-paid') }) : null, ['paid', 'manual_pending'].includes(orderStatus) ? btn('Complete', function () { self.orderAction(order, 'complete') }, {flat: true}) : null, !['completed', 'cancelled', 'paid'].includes(orderStatus) ? btn('Cancel', function () { self.orderAction(order, 'cancel') }, {flat: true, color: 'negative'}) : null])
        ])
      }) : [h('p', {class: 'pop-muted'}, ['No orders yet.'])]))
      var menuDialog = this.menuOpen ? h('div', {class: 'pop-modal-backdrop', role: 'presentation'}, [h('section', {class: 'q-card pop-modal q-pa-md', role: 'dialog', 'aria-modal': 'true'}, [h('div', {class: 'row items-center'}, [h('h2', {class: 'text-h6 q-my-none'}, [this.menuForm.id ? 'Edit menu' : 'New menu']), h('div', {class: 'col'}), btn('Close', function () { self.menuOpen = false }, {class: 'q-btn q-btn-item q-btn--flat text-white'})]), h('div', {class: 'row q-col-gutter-md q-mt-md'}, [field('Name', this.menuForm.name, function (v) { self.menuForm.name = v }), selectField('Currency', this.menuForm.currency, this.currencyOptions, function (v) { self.menuForm.currency = v }), field('Description', this.menuForm.description, function (v) { self.menuForm.description = v }), field('Manual instructions', this.menuForm.manual_instructions, function (v) { self.menuForm.manual_instructions = v })]), h('label', {class: 'block q-mt-md'}, [h('span', {class: 'text-caption'}, ['Wallet']), h('select', {class: 'full-width q-pa-sm bg-grey-10 text-white rounded-borders', value: this.menuForm.wallet_id, onChange: function (event) { self.menuForm.wallet_id = event.target.value }}, this.wallets.map(function (wallet) { return h('option', {value: wallet.id, key: wallet.id}, [text(wallet.name || wallet.id)]) }))]), h('div', {class: 'row q-gutter-md q-mt-md'}, [h('label', [h('input', {type: 'checkbox', checked: this.menuForm.active !== false, onChange: function (event) { self.menuForm.active = event.target.checked }}), ' Menu active']), h('label', [h('input', {type: 'checkbox', checked: this.menuForm.lightning_enabled !== false, onChange: function (event) { self.menuForm.lightning_enabled = event.target.checked }}), ' Lightning']), h('label', [h('input', {type: 'checkbox', checked: this.menuForm.manual_enabled !== false, onChange: function (event) { self.menuForm.manual_enabled = event.target.checked }}), ' Manual'])]), h('div', {class: 'row q-gutter-sm q-mt-md'}, [btn(this.saving ? 'Saving…' : 'Save menu', this.saveMenu, {disabled: this.saving || !text(this.menuForm.name).trim()}), btn('Cancel', function () { self.menuOpen = false }, {class: 'q-btn q-btn-item q-btn--flat text-white'})])])]) : null
      var itemDialog = this.itemOpen ? h('div', {class: 'pop-modal-backdrop'}, [h('section', {class: 'q-card pop-modal q-pa-md', role: 'dialog', 'aria-modal': 'true'}, [h('div', {class: 'row items-center'}, [h('h2', {class: 'text-h6 q-my-none'}, [this.itemForm.id ? 'Edit item' : 'New item']), h('div', {class: 'col'}), btn('Close', function () { self.itemOpen = false }, {class: 'q-btn q-btn-item q-btn--flat text-white'})]), h('div', {class: 'row q-col-gutter-md q-mt-md'}, [field('Name', this.itemForm.name, function (v) { self.itemForm.name = v }), field('Price', this.itemForm.price, function (v) { self.itemForm.price = v }, 'text'), field('Description', this.itemForm.description, function (v) { self.itemForm.description = v }), field('Position', this.itemForm.position, function (v) { self.itemForm.position = v }, 'number')]), h('div', {class: 'row q-gutter-md q-mt-md'}, [h('label', [h('input', {type: 'checkbox', checked: this.itemForm.active !== false, onChange: function (event) { self.itemForm.active = event.target.checked }}), ' Item active']), h('label', [h('input', {type: 'checkbox', checked: this.itemForm.sold_out === true, onChange: function (event) { self.itemForm.sold_out = event.target.checked }}), ' Sold out'])]), h('div', {class: 'row q-gutter-sm q-mt-md'}, [btn(this.saving ? 'Saving…' : 'Save item', this.saveItem, {disabled: this.saving || !text(this.itemForm.name).trim() || !text(this.itemForm.price).trim()}), btn('Cancel', function () { self.itemOpen = false }, {class: 'q-btn q-btn-item q-btn--flat text-white'})])])]) : null
      var invoiceDialogValue = this.invoiceOrder ? paymentRequest(this.invoiceOrder) : ''
      var invoiceDialog = invoiceDialogValue ? h('div', {class: 'pop-modal-backdrop', role: 'presentation'}, [h('section', {class: 'q-card pop-modal pop-invoice-dialog q-pa-lg', role: 'dialog', 'aria-modal': 'true'}, [h('div', {class: 'row items-start'}, [h('div', {class: 'col'}, [h('div', {class: 'pop-confirmation-eyebrow'}, ['Lightning invoice']), h('h2', {class: 'text-h6 text-weight-bold q-my-xs'}, ['Show payment at counter']), h('p', {class: 'pop-muted q-my-none'}, ['Scan this invoice with a Lightning wallet.'])]), btn('Close', this.closeInvoice, {flat: true})]), h('div', {class: 'pop-payment-amount'}, [money(this.invoiceOrder.total, this.invoiceOrder.currency)]), h('div', {class: 'pop-qr pop-admin-invoice-qr bg-white text-dark'}, [qrComponent ? h(qrComponent, {value: 'lightning:' + invoiceDialogValue.toUpperCase(), size: 280, margin: 3, level: 'Q'}) : 'QR unavailable']), h('div', {class: 'row justify-center q-gutter-sm q-mt-md'}, [btn('Copy invoice', function () { self.copy(invoiceDialogValue) }, {flat: true, icon: 'content_copy'})])])]) : null
      return h('main', {class: 'pop-shell q-pa-md'}, [title, loading, error, menus, itemsCard, shareCard, ordersCard, menuDialog, itemDialog, invoiceDialog])
    }
  }
  var app = Vue.createApp(App)
  if (global.QrcodeVue) app.component('qrcode-vue', global.QrcodeVue.default || global.QrcodeVue)
  if (global.Quasar) app.use(global.Quasar)
  app.mount('#app')
  global.PopMenuAdminApp = App
})(window)
