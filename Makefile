.PHONY: contract test lint typecheck build verify audit-verifier-surface

contract:
	node scripts/check-verifier-contract.mjs

test:
	node scripts/test.mjs

lint:
	pnpm run lint

typecheck:
	pnpm run typecheck

build:
	pnpm run build

verify:
	node scripts/verify.mjs

audit-verifier-surface:
	node scripts/audit-verifier-surface.mjs
