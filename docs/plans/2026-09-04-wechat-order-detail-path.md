# WeChat Order Detail Path Compatibility Implementation Plan

**Goal:** Support the official order-detail path template with `out_trade_no` while retaining legacy mini-program links, ownership validation and existing payment controls.

**Architecture:** Keep `pages/order-detail/index?id=...`. Resolve the ID exactly as a database `_id` first, then as `outTradeNo`; never treat the displayed `orderNo` as the payment identifier. Apply this resolver to customer detail, prepare-payment and cancellation so the current published client can continue sending the original route value. Return the canonical database ID and let the updated client use it thereafter.

**Tech Stack:** WeChat native mini-program, wx-server-sdk cloud database, Node test runner with isolated VM mocks.

## Evidence and approach

The user's order-information-entry screenshot explicitly requires `${商品订单号}` and says WeChat substitutes the payment `out_trade_no`. The form is empty in the supplied screenshot. This establishes a concrete unfilled integration field, not proof that it is the only cause of payment restriction.

Options: (1) add a new external route/parameter and release a new client first; (2) support the existing `id` route in the backend and canonicalize it in updated clients. Use option 2 for compatibility with the currently published client. Do not modify the database order numbering scheme or migrate existing records.

Existing uncommitted changes are preserved in the current workspace. No live release, cloud deployment, order modification, charge, refund or shipment submission is performed.

## Task 1: Reproduce and lock down resolution

**Create:** `tests/order-detail-route.test.js`.

1. Mock users, orders and stock plus minimal transactions. Mock all mini-program APIs; do not access live services.
2. Prove an owned `outTradeNo` supplied as `id` opens the corresponding detail, prepares the server amount and cancels using its canonical `_id`.
3. Prove existing `_id` links still work; foreign users and anonymous users cannot access/mutate orders. Administrators can still read details but cannot pay/cancel for other buyers.
4. Reject operator objects, overlong references, duplicate `outTradeNo` matches and ambiguous ID collisions safely. Keep paid/expired state guards.
5. Run `node --test tests/order-detail-route.test.js` before production changes.

## Task 2: Implement bounded compatibility

**Modify:** `cloudfunctions/orders/index.js`, `miniprogram/pages/order-detail/index.js`.

1. Add one string-only, length-checked lookup helper. Match `_id` first; a successful ID match never falls through to another order based on permissions. If no ID matches, query exact `outTradeNo` and require exactly one result. Do not swallow database faults.
2. Reuse the helper only in customer detail, prepare-payment and cancel. Preserve all existing user and state checks; pass canonical `_id` into the stock-release transaction.
3. Updated client stores the canonical `_id` returned by detail. Retain the reference while navigating to login, using the existing login-and-navigate-back flow.

## Task 3: Verify and document rollout

**Modify:** `docs/payment-restriction-troubleshooting.md`, `鹏宇优选部署与验收.md`.

1. Run full tests: `node --test tests/*.test.js cloudfunctions/pengyu-pay-fj7pei2f-demo-scfweb/tests/*.test.js` and syntax checks for changed files.
2. Document template `pages/order-detail/index?id=${商品订单号}` literally, without substituting a sample order.
3. Rollout prerequisite: deploy the `orders` cloud function to the same environment used by the published mini-program; verify an owned real order can be opened by its payment order number. Then record the template in the official backend. Updating the mini-program client also delivers the prior error-display fix, but isn't required for backend lookup compatibility.
4. Ensure the existing recommended unique `orders.outTradeNo` index is present. Never mark this payment restriction resolved until official/backend and real-device validation succeed.

## Verification result

- Initial focused tests reproduced the missing trade-number compatibility: 11 of 27 failed on the old implementation.
- Final focused tests: 28/28 passed, including database-failure propagation and existing-login flow.
- Full project tests: 169/169 passed. JavaScript syntax checks passed.
- Local implementation and rollout documentation complete. Cloud deployment, official path recording/approval, real-device validation and payment restoration remain unperformed.
