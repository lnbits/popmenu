import {createHost} from './host.js'
import {createDomain, PopMenuError} from './domain.js'

const domain = createDomain(createHost())

function requestObject(requestJson, allowEmpty = false) {
  if (requestJson === undefined || requestJson === null || requestJson === '') {
    if (allowEmpty) return {}
    throw new PopMenuError('A JSON object is required.')
  }
  let value
  try { value = JSON.parse(requestJson) } catch (_) { throw new PopMenuError('Request JSON is invalid.') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PopMenuError('Request must be a JSON object.')
  return value
}

function publicError(error) {
  if (error && error.public === true && typeof error.message === 'string' && error.message.length <= 180) return error.message
  return 'The request could not be completed.'
}

export function runJson(operation) {
  try { return JSON.stringify({ok: true, data: operation()}) } catch (error) { return JSON.stringify({ok: false, error: publicError(error)}) }
}

export function listCurrencies(_requestJson) { return runJson(() => domain.listCurrencies()) }
export function listWallets(_requestJson) { return runJson(() => domain.listWallets()) }
export function listMenus(requestJson) { return runJson(() => domain.listMenus(requestObject(requestJson, true))) }
export function createMenu(requestJson) { return runJson(() => domain.createMenu(requestObject(requestJson))) }
export function updateMenu(requestJson) { return runJson(() => domain.updateMenu(requestObject(requestJson))) }
export function listItems(requestJson) { return runJson(() => domain.listItems(requestObject(requestJson))) }
export function createItem(requestJson) { return runJson(() => domain.createItem(requestObject(requestJson))) }
export function updateItem(requestJson) { return runJson(() => domain.updateItem(requestObject(requestJson))) }
export function listOrders(requestJson) { return runJson(() => domain.listOrders(requestObject(requestJson, true))) }
export function markManualPaid(requestJson) { return runJson(() => domain.markManualPaid(requestObject(requestJson))) }
export function completeOrder(requestJson) { return runJson(() => domain.completeOrder(requestObject(requestJson))) }
export function cancelOrder(requestJson) { return runJson(() => domain.cancelOrder(requestObject(requestJson))) }
export function getPublicMenu(requestJson) { return runJson(() => domain.getPublicMenu(requestObject(requestJson))) }
export function createOrder(requestJson) { return runJson(() => domain.createOrder(requestObject(requestJson))) }
export function getOrderConfirmation(requestJson) { return runJson(() => domain.confirmation(requestObject(requestJson))) }
export function retryPayment(requestJson) { return runJson(() => domain.retryPayment(requestObject(requestJson))) }
export function handleInvoicePaid(eventJson) { return runJson(() => domain.handleInvoicePaid(requestObject(eventJson))) }
