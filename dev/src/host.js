/* The component-facing adapter.  Keep all WIT transport conversions here so
 * domain code can be exercised with a small in-memory host in Node. */
import {
  storageGet,
  storageGetPaginated,
  storageSet,
  createInvoicePublic,
  listUserWallets,
  randomId,
  now
} from 'lnbits:extension/host'
import {listCurrencies as hostListCurrencies} from 'lnbits:extension/utils-currencies'
import {invoiceAmountMsat, invoiceExpiry} from 'lnbits:extension/utils-lightning'

function readJson(response) {
  if (!response || !response.dataJson) return null
  const value = JSON.parse(response.dataJson)
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function rows(response) {
  const value = JSON.parse(response && response.rowsJson ? response.rowsJson : '[]')
  return Array.isArray(value) ? value : []
}

function timestamp(response) {
  const value = response && typeof response === 'object'
    ? response.timestamp ?? response.value
    : response
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error('Host returned an invalid timestamp.')
  return Math.trunc(number)
}

export const storage = {
  get(table, id, fallback = null) {
    return readJson(storageGet({table, id})) || fallback
  },
  set(table, data) {
    storageSet({table, dataJson: JSON.stringify(data || {})})
    return data
  },
  getPaginated(table, options = {}) {
    const response = storageGetPaginated({
      table,
      filtersJson: JSON.stringify(options.filters || {}),
      search: options.search || '',
      searchFields: options.searchFields || [],
      sortBy: options.sortBy || '',
      descending: options.descending === true,
      limit: options.limit || 100,
      offset: options.offset || 0
    })
    return {data: rows(response), total: Number(response && response.total || 0)}
  }
}

export const wallet = {
  listUserWallets() {
    const response = listUserWallets()
    return Array.isArray(response) ? response : (response && response.wallets) || []
  },
  createInvoicePublic({sourceId, amount, currency, memo, extra}) {
    return createInvoicePublic({
      sourceId,
      amount: Number(amount),
      currency: currency || 'sat',
      memo: memo || '',
      extra: Object.entries(extra || {}).map(([key, value]) => [
        key,
        value && typeof value === 'object' ? JSON.stringify(value) : String(value)
      ])
    })
  }
}

export const utils = {
  currencies: {
    list() {
      const response = hostListCurrencies()
      const values = Array.isArray(response) ? response : (response && response.currencies) || []
      return values.includes('sat') ? values : ['sat', ...values]
    }
  },
  lightning: {
    invoiceExpiry(bolt11) {
      const response = invoiceExpiry({bolt11})
      return Number(response && (response.expiresAt ?? response.expires_at) || 0)
    },
    invoiceAmountMsat(bolt11) {
      const response = invoiceAmountMsat({bolt11})
      return Number(response && (response.amountMsat ?? response.amount_msat) || 0)
    }
  }
}

export const system = {
  id(prefix) {
    const response = randomId({prefix: String(prefix || 'id')})
    return response && typeof response === 'object' ? response.id : response
  },
  now() {
    return timestamp(now())
  }
}

export function createHost() {
  return {storage, wallet, utils, system}
}
