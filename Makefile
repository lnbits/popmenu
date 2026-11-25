.PHONY: build check component-smoke contract-check syntax test package package-check

check: contract-check syntax test

contract-check:
	node dev/scripts/contract-check.mjs

syntax:
	cargo fmt --manifest-path dev/Cargo.toml --check
	cargo test --manifest-path dev/Cargo.toml --lib --locked
	node --check static/lnbits-extension-sdk.js
	node --check static/admin.js
	node --check static/public.js

test: build
	cd dev && npm test

build:
	cd dev && npm run build

package: build
	node dev/scripts/package.mjs
	node dev/scripts/package-check.mjs

package-check:
	node dev/scripts/package-check.mjs

component-smoke: build
	node dev/scripts/component-smoke.mjs
