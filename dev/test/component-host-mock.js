const tables = Object.fromEntries(['menus', 'items', 'orders', 'payment_attempts', 'settlements'].map(name => [name, new Map()]))
let sequence = 0
let clock = 1_700_000_000n

export const componentState = {tables}
export function resetComponentState() {
  for (const table of Object.values(tables)) table.clear()
  sequence = 0
  clock = 1_700_000_000n
}
export function storageGet({table, id}) {
  const row = tables[table]?.get(id)
  return {dataJson: row ? JSON.stringify(row) : undefined}
}
export function storageSet({table, dataJson}) {
  const row = JSON.parse(dataJson)
  tables[table].set(row.id, row)
  return {ok: true}
}
export function storageGetPaginated({table, filtersJson, sortBy, descending, limit, offset}) {
  const filters = JSON.parse(filtersJson || '{}')
  let rows = [...tables[table].values()].filter(row => Object.entries(filters).every(([key, value]) => row[key] === value))
  if (sortBy) rows.sort((left, right) => (Number(left[sortBy] || 0) - Number(right[sortBy] || 0)) * (descending ? -1 : 1))
  return {rowsJson: JSON.stringify(rows.slice(offset, offset + limit)), total: BigInt(rows.length)}
}
export function createInvoicePublic() {
  sequence += 1
  return {paymentHash: sequence.toString(16).padStart(64, '0'), paymentRequest: `invoice-${sequence}`, checkingId: `checking-${sequence}`}
}
export function listUserWallets() { return {wallets: [{id: 'wallet-1', name: 'Till', currency: 'sat'}]} }
export function randomId({prefix}) { sequence += 1; return {id: `${prefix}-${sequence}`} }
export function now() { return {timestamp: clock} }
