.PHONY: build bundle check component-smoke contract-check syntax test package package-check

check: contract-check syntax test

contract-check:
	node dev/scripts/contract-check.mjs

syntax:
	node --check dev/src/domain.js
	node --check dev/src/host.js
	node --check dev/src/index.js
	node --check static/lnbits-extension-sdk.js
	node --check static/admin.js
	node --check static/public.js

test:
	cd dev && npm test

bundle:
	cd dev && npm run bundle

build:
	cd dev && npm run build

package: build
	node dev/scripts/package.mjs
	node dev/scripts/package-check.mjs

package-check:
	node dev/scripts/package-check.mjs

component-smoke: build
	node dev/scripts/component-smoke.mjs
