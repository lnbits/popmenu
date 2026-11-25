import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("../..", import.meta.url).pathname);
const failures = [];

async function loadJson(relativePath) {
  const path = resolve(root, relativePath);
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    failures.push(`${relativePath}: ${error.message}`);
    return null;
  }
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const config = await loadJson("config.json");
const schema = await loadJson("storage/schema.json");
const migration = await loadJson("storage/migrations/0001_initial.json");
const openapi = await loadJson("wasm/openapi.json");
let wit = "";
let source = null;
try {
  wit = await readFile(resolve(root, "wasm/lnbits-extension.wit"), "utf8");
} catch (error) {
  failures.push(`wasm/lnbits-extension.wit: ${error.message}`);
}
try {
  source = await readFile(resolve(root, "dev/src/lib.rs"), "utf8");
} catch {
  // The contract scaffold is valid before the implementation source exists.
}

if (config) {
  assert(config.id === "popmenu", "config id must be popmenu");
  assert(config.extension_type === "wasm", "config extension_type must be wasm");
  assert(config.wasm?.world === "popmenu", "config wasm.world must be popmenu");
  assert(config.wasm?.wit === "wasm/lnbits-extension.wit", "config WIT path drift");
  assert(config.wasm?.module === "wasm/module.wasm", "config module path drift");

  const exportsByName = new Map((config.wasm?.exports ?? []).map((item) => [item.name, item.visibility]));
  const exportNames = [...exportsByName.keys()].sort();
  const witExports = [...wit.matchAll(/\bexport\s+([\w-]+)\s*:/g)].map((match) => match[1]).sort();
  assert(sameJson(exportNames, witExports), "config exports and WIT exports differ");
  assert(new Set(exportNames).size === exportNames.length, "config exports contain duplicates");

  const eventExport = config.events?.onInvoicePaid;
  assert(eventExport && exportsByName.get(eventExport) === "event", "onInvoicePaid must target an event export");
  if (source !== null) {
    for (const name of exportNames) {
      assert(source.includes(name.replaceAll("-", "_")), "configured export is missing from Rust routes: " + name);
    }
  }
  for (const route of config.api_routes ?? []) {
    const visibility = exportsByName.get(route.export);
    assert(visibility, `API route targets undeclared export: ${route.export}`);
    assert(visibility !== "event", `API route targets event export: ${route.export}`);
    assert(route.auth === "public" ? visibility === "public" : visibility === "authenticated", `route/export visibility mismatch: ${route.export}`);

    const placeholders = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const mappings = route.path_params ?? {};
    assert(placeholders.every((name) => typeof mappings[name] === "string" && mappings[name]), `missing path mapping on ${route.path}`);
    assert(Object.keys(mappings).every((name) => placeholders.includes(name)), `extra path mapping on ${route.path}`);
    if (route.ownerContext) {
      assert(route.auth === "public", `ownerContext requires public route: ${route.path}`);
      assert(typeof route.ownerContext.table === "string" && typeof route.ownerContext.idParam === "string", `invalid ownerContext on ${route.path}`);
      assert(Object.values(mappings).includes(route.ownerContext.idParam), `ownerContext idParam is not mapped on ${route.path}`);
    }
  }
  for (const route of config.ui_routes ?? []) {
    const placeholders = [...route.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const mappings = route.path_params ?? {};
    assert(placeholders.every((name) => typeof mappings[name] === "string" && mappings[name]), `missing UI path mapping on ${route.path}`);
    assert(Object.keys(mappings).every((name) => placeholders.includes(name)), `extra UI path mapping on ${route.path}`);
    assert(/^(?:ui|static)\/[A-Za-z0-9._/-]+\.html$/.test(route.entrypoint), `unsafe UI entrypoint: ${route.entrypoint}`);
  }

  const permissionIds = (config.permissions ?? []).map((permission) => permission.id).sort();
  assert(sameJson(permissionIds, ["ext.storage.read", "ext.storage.write", "utils.basic", "wallet.create_invoice_public", "wallet.list"]), "permission set drift");
  const invoicePermission = (config.permissions ?? []).find((permission) => permission.id === "wallet.create_invoice_public");
  assert(sameJson(invoicePermission?.policies, [{ table: "menus", wallet_field: "wallet_id" }]), "public invoice policy must be exactly menus.wallet_id");
}

if (openapi && config) {
  const routeKeys = (config.api_routes ?? []).map((route) => route.export).sort();
  const documentedKeys = Object.keys(openapi.routes ?? {}).sort();
  assert(sameJson(routeKeys, documentedKeys), "OpenAPI route keys and config API exports differ");
  const operationIds = Object.values(openapi.routes ?? []).map((route) => route.operationId).filter(Boolean);
  assert(operationIds.length === new Set(operationIds).size, "OpenAPI operationIds must be unique");
  for (const [name, route] of Object.entries(openapi.routes ?? {})) {
    assert(typeof route.summary === "string" && route.summary.length > 0, `OpenAPI route ${name} needs a summary`);
    assert(route.responses && typeof route.responses === "object", `OpenAPI route ${name} needs responses`);
  }
}

if (schema && migration) {
  const schemaTables = schema.tables ?? {};
  const migrationTables = Object.fromEntries((migration.operations ?? []).filter((operation) => operation.op === "create_table").map((operation) => [operation.table, { fields: operation.fields }]));
  assert(schema.version === migration.version, "schema and initial migration versions differ");
  assert(sameJson(schemaTables, migrationTables), "schema tables and initial migration tables differ");
  const schemaIndexes = schema.indexes ?? [];
  const migrationIndexes = (migration.operations ?? []).filter((operation) => operation.op === "create_index").map(({ op, ...index }) => index);
  assert(sameJson(schemaIndexes, migrationIndexes), "schema indexes and initial migration indexes differ");
  const supportedTypes = new Set(["string", "integer", "number", "boolean", "datetime"]);
  const requiredFields = {
    menus: [
      ["id", "string"], ["name", "string"], ["description", "string", true], ["currency", "string"],
      ["wallet_id", "string"], ["lightning_enabled", "boolean"], ["manual_enabled", "boolean"],
      ["manual_instructions", "string", true], ["active", "boolean"], ["created_at", "datetime"], ["updated_at", "datetime"]
    ],
    items: [
      ["id", "string"], ["menu_id", "string"], ["name", "string"], ["description", "string", true],
      ["price", "string"], ["position", "integer"], ["active", "boolean"], ["sold_out", "boolean"],
      ["created_at", "datetime"], ["updated_at", "datetime"]
    ],
    orders: [
      ["id", "string"], ["checkout_token", "string"], ["menu_id", "string"], ["order_number", "string"],
      ["items", "string", false, true], ["total", "string"], ["currency", "string"], ["payment_method", "string"],
      ["payment_status", "string"], ["status", "string"], ["fulfillment_status", "string"],
      ["manual_instructions", "string", true], ["customer_name", "string", true], ["customer_note", "string", true],
      ["table_label", "string", true], ["location_label", "string", true], ["attempt_id", "string", true],
      ["created_at", "datetime"], ["updated_at", "datetime"], ["paid_at", "datetime", true],
      ["completed_at", "datetime", true], ["cancelled_at", "datetime", true]
    ],
    payment_attempts: [
      ["id", "string"], ["order_id", "string"], ["menu_id", "string"], ["payment_hash", "string"],
      ["checking_id", "string"], ["bolt11", "string"], ["amount", "string"], ["amount_msat", "integer"],
      ["currency", "string"], ["expires_at", "datetime"], ["status", "string"], ["created_at", "datetime"],
      ["paid_at", "datetime", true]
    ],
    settlements: [
      ["id", "string"], ["order_id", "string"], ["attempt_id", "string"], ["menu_id", "string"],
      ["amount", "string"], ["amount_msat", "integer"], ["paid_at", "datetime"]
    ]
  };
  assert(sameJson(Object.keys(schemaTables).sort(), Object.keys(requiredFields).sort()), "storage table set differs from the PopMenu contract");
  for (const [tableName, table] of Object.entries(schemaTables)) {
    const fields = table.fields ?? [];
    const expected = requiredFields[tableName];
    if (expected) {
      const normalized = fields.map((field) => [field.name, field.type, field.nullable === true, field.list === true]);
      const expectedNormalized = expected.map(([name, type, nullable = false, list = false]) => [name, type, nullable, list]);
      assert(sameJson(normalized, expectedNormalized), `${tableName} fields differ from the PopMenu contract`);
    }
    assert(fields.some((field) => field.name === "id"), `${tableName} must define id`);
    assert(!fields.some((field) => field.name === "__lnbits_owner_id__"), `${tableName} defines reserved owner field`);
    for (const field of fields) {
      assert(supportedTypes.has(field.type), `${tableName}.${field.name} uses unsupported type ${field.type}`);
      assert(field.list === undefined || field.list === true, `${tableName}.${field.name} has invalid list modifier`);
    }
  }
  for (const index of schemaIndexes) {
    assert(schemaTables[index.table], `index references unknown table: ${index.table}`);
    assert(schemaTables[index.table]?.fields?.some((field) => field.name === index.field), `index references unknown field: ${index.table}.${index.field}`);
  }
}

if (wit) {
  const imports = [...wit.matchAll(/\bimport\s+([\w-]+)\s*;/g)].map((match) => match[1]).sort();
  assert(sameJson(imports, ["host", "utils-currencies", "utils-lightning"]), "WIT imports must be the selected runtime host interfaces only");
  const requiredSnippets = [
    "storage-get: func(request: storage-get-request) -> storage-get-response;",
    "storage-set: func(request: storage-set-request) -> storage-set-response;",
    "storage-get-paginated: func(request: storage-paginated-request) -> storage-paginated-response;",
    "create-invoice-public: func(request: invoice-public-request) -> invoice-response;",
    "list-user-wallets: func() -> list-user-wallets-response;",
    "random-id: func(request: random-id-request) -> random-id-response;",
    "now: func() -> now-response;",
    "list-currencies: func() -> currency-list-response;",
    "invoice-expiry: func(request: bolt11-request) -> invoice-expiry-response;",
    "invoice-amount-msat: func(request: bolt11-request) -> invoice-amount-msat-response;"
  ];
  for (const snippet of requiredSnippets) assert(wit.includes(snippet), `WIT host contract missing: ${snippet}`);
}

if (failures.length) {
  console.error(failures.map((failure) => `contract-check: ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log("contract-check: OK (config, WIT, OpenAPI, schema, and migration are synchronized)");
}
