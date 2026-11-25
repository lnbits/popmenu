# PopMenu

PopMenu is an LNbits WebAssembly extension for QR menus, Lightning or manual
checkout, and a small merchant order queue. Customers can order without an
LNbits account; merchants manage menus, availability, payment state, and
fulfilment from the authenticated extension page.

After payment is confirmed, the customer and merchant see the same stable
six-digit payment PIN formatted `XXX-XXX`, making counter handoff quick while
the merchant's paid state remains authoritative.

## Extension details

- ID/version: `popmenu` / `0.2.0`
- Admin route: `/ext/popmenu`
- Public routes: `/ext/popmenu/menu/{menu_id}` and `/ext/popmenu/order/{order_id}`
- Component: `wasm/module.wasm`
- Permissions: owner-scoped storage read/write, wallet listing, public invoice
  creation from `menus.wallet_id`, and basic currency/invoice helpers.

## Development

Run from this directory:

```bash
rustup target add wasm32-wasip2
make check
make build
make package
```

`make build` compiles the Rust guest for `wasm32-wasip2` and writes the WebAssembly
Component with the pinned local `jco` tool. `make package` rebuilds the module,
creates `dist/popmenu-0.2.0.zip`, and verifies that the archive has one
top-level `popmenu/` directory, contains the rebuilt component, and excludes
development files and dependencies.

The archive is the install artifact. A source-only tree is not considered
installable until `wasm/module.wasm` has been rebuilt and loaded by the target
LNbits runtime.
