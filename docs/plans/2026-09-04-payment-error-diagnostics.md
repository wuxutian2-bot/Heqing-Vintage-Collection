# Payment Error Diagnostics Implementation Plan

> Execute locally, one task at a time. Preserve the existing uncommitted work; do not create a clean checkout that drops the current payment implementation. No live charges, refunds, credential changes, cloud deployment, or release publication.

**Goal:** Fix missing payment failure details without implying that client code can restore a platform-disabled payment permission.

**Architecture:** Keep the existing prepare-order → HTTP unified order → native requestPayment → server query flow. Normalize errors at each boundary, distinguish explicit WeChat restrictions from cancellation and ordinary errors, and retain authoritative backend payment status. The screenshot establishes a restriction symptom, not its specific policy cause.

**Tech Stack:** Native WeChat mini-program JavaScript, CommonJS, Node built-in test runner and isolated VM mocks.

## Evidence and design

- The 2026-09-03 screenshot explicitly says the mini-program payment feature is unavailable due to a violation.
- `miniprogram/pages/order-detail/index.js` tests `errMsg` for cancellation but displays only `message`; native `{ errMsg, errno }` failures therefore lose their useful details.
- `miniprogram/utils/payment.js` replaces HTTP error bodies with only their status and does not distinguish wrapped upstream failures from missing payment parameters.
- A successful native payment followed by a failed query currently appears as a payment failure. Return a pending confirmation result in this case; do not tell customers to pay again.
- Shipping integration is currently manual, as documented in the deployment guide. Missing shipping setup is a priority check, not a confirmed cause. The actual restriction notice and online logs are not available locally.

Approaches: changing only the modal is the smallest patch but leaves upstream error loss; changing credentials/rebuilding payment cannot remedy a confirmed platform restriction. Use a bounded error-normalization patch plus the official account-side checklist. Do not introduce a global shutdown switch or automatic shipment claims.

## Task 1: Reproduce failures with isolated tests

**Create:** `tests/payment.test.js`.

1. Mock `wx.requestPayment`, `wx.cloud.callHTTPFunction`, and `orders.preparePayment`; never make a network call.
2. Reproduce native `errMsg` loss, wrapped upstream rejection, HTTP error-body loss and query failure after native success.
3. Cover explicit restrictions, unknown errno (do not infer restrictions from errno alone), cancellations, incomplete signatures, normal success and pending query results.
4. Run `node --test tests/payment.test.js` before production edits and record expected failures.

## Task 2: Minimal frontend patch

**Modify:** `miniprogram/utils/payment.js`, `miniprogram/pages/order-detail/index.js`.

1. Normalize `errMsg/message/msg`, preserve scalar error codes and stage, and parse response bodies safely.
2. Inspect both HTTP errors and the payment function's nested SDK `status/data` envelope.
3. Validate required native payment parameters before opening the cashier.
4. Share cancellation/restriction display logic with the order-detail page. Log only stage and scalar codes, not payer data, signatures, payment response objects, or tokens.
5. Return confirmation-pending on post-payment query failure. Never locally mark an order paid or release stock based on a client error.

## Task 3: Regression and operational handoff

**Create:** `docs/payment-restriction-troubleshooting.md`.

1. Run `node --test tests/*.test.js cloudfunctions/pengyu-pay-fj7pei2f-demo-scfweb/tests/*.test.js` and JavaScript syntax checks.
2. Document official restriction handling, manual shipping evidence, source-stage diagnostics and separation of local fixes from live release.
3. Ask the administrator for the mini-program notification/restriction detail. Do not promise restoration before official confirmation.
4. Manual acceptance after account restrictions are cleared: publish only after an approved test release verifies the intended error modal, cancel behavior, one successful authorized payment and the backend callback status.

Official sources checked on 2026-09-04:
- https://pay.wechatpay.cn/doc/v3/merchant/4012791910
- https://pay.wechatpay.cn/doc/v3/merchant/4015459512

## Execution result

- Before patch: 25 focused tests, 17 failed and 8 passed, reproducing error-loss and misleading failure behavior.
- After patch: 25/25 focused tests passed; full suite 141/141 passed. JavaScript syntax checks passed.
- Local fix complete. Online restriction cause, manual shipping compliance and live-version acceptance require administrator/backend evidence; no deployment or real transaction was performed.
