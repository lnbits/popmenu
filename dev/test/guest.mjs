import {component} from './component.mjs'

export function createDomain(host) {
  const interfaces = {
    'lnbits:extension/host': {
      randomId: ({prefix}) => ({id: host.system.id(prefix)}),
      now: () => ({timestamp: BigInt(host.system.now())}),
      storageGet: ({table, id}) => ({dataJson: JSON.stringify(host.storage.get(table, id))}),
      storageSet({table, dataJson}) {host.storage.set(table, JSON.parse(dataJson)); return {ok: true}},
      storageGetPaginated({table, filtersJson, ...options}) {
        const page = host.storage.getPaginated(table, {...options, filters: JSON.parse(filtersJson)})
        return {rowsJson: JSON.stringify(page.data), total: BigInt(page.total)}
      },
      listUserWallets: () => ({wallets: host.wallet.listUserWallets()}),
      createInvoicePublic(req) {
        try {return host.wallet.createInvoicePublic({...req, extra: Object.fromEntries(req.extra)})}
        catch {return {paymentHash: '', checkingId: '', paymentRequest: ''}}
      }
    },
    'lnbits:extension/utils-currencies': {listCurrencies: () => ({currencies: host.utils.currencies.list()})},
    'lnbits:extension/utils-lightning': {
      invoiceExpiry: ({bolt11}) => ({expiresAt: BigInt(host.utils.lightning.invoiceExpiry(bolt11))}),
      invoiceAmountMsat: ({bolt11}) => ({amountMsat: BigInt(host.utils.lightning.invoiceAmountMsat(bolt11))})
    }
  }
  return new Proxy({}, {get(_, name) {
    return (input = {}) => {
      const fn = name === 'confirmation' ? 'getOrderConfirmation' : name
      const result = JSON.parse(component(interfaces)[fn](JSON.stringify(input)))
      if (!result.ok) throw new Error(result.error)
      return result.data
    }
  }})
}
