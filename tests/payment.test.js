const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const paymentParams = {
  timeStamp: "1788480000", nonceStr: "test-nonce",
  package: "prepay_id=test-only", signType: "RSA", paySign: "test-signature-not-real",
};
const order = { outTradeNo: "PY_TEST_ONLY", description: "测试商品", totalAmountFen: 50 };
const response = (data, status = 200) => ({ statusCode: 200, data: { code: 0, data: { status, data } } });

const load = (filename, globals, dependencies) => {
  const sandbox = {
    module: { exports: {} }, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", filename), "utf8"), sandbox, { filename });
  return sandbox.module.exports;
};

const setup = (options = {}) => {
  const calls = { http: [], native: [], cloud: [], logs: [], modals: [], toasts: [], timers: [], reloads: 0 };
  const globalData = { env: "test-only", paymentFunctionName: "test-pay", paymentBusinessHookReady: true, ...options.config };
  const wx = {
    cloud: {
      callHTTPFunction(request) {
        calls.http.push(request);
        const isQuery = request.path.includes("query");
        if (isQuery && options.queryFail) return request.fail(options.queryFail);
        const result = isQuery
          ? (options.queryResponse || response({ trade_state: "SUCCESS" }))
          : (options.orderResponse || response(paymentParams));
        request.success(result);
      },
    },
    requestPayment(request) {
      calls.native.push(request);
      if (options.nativeThrow) throw options.nativeThrow;
      if (options.nativeFail) return request.fail(options.nativeFail);
      request.success({ errMsg: "requestPayment:ok" });
    },
    showModal(value) { calls.modals.push(value); },
    showToast(value) { calls.toasts.push(value); },
  };
  const cloud = {
    async callCloud(name, data) {
      calls.cloud.push({ name, data });
      if (options.prepareError) throw options.prepareError;
      return { success: true, data: order };
    },
  };
  const globals = {
    wx, getApp: () => ({ globalData }),
    console: { warn: (...args) => calls.logs.push(args), error: (...args) => calls.logs.push(args) },
  };
  const payment = load("miniprogram/utils/payment.js", globals, { "./cloud": cloud });
  let page;
  load("miniprogram/pages/order-detail/index.js", {
    ...globals,
    Page: (value) => { page = value; },
    setTimeout: (callback) => { calls.timers.push(callback); },
  }, { "../../utils/cloud": cloud, "../../utils/payment": payment });
  page.data = { id: "test-order", paying: false, paymentReady: true };
  page.setData = (value) => Object.assign(page.data, value);
  page.loadOrder = async () => { calls.reloads += 1; };
  return { payment, page, calls, wx };
};

test("native restriction retains errMsg, errno and stage", async () => {
  const { payment, calls } = setup({ nativeFail: { errMsg: "requestPayment:fail banned", errno: 102 } });
  await assert.rejects(payment.startOrderPayment("test-order"), (error) => {
    assert.match(error.message, /banned/);
    assert.equal(error.errno, 102);
    assert.equal(error.stage, "requestPayment");
    return true;
  });
  assert.equal(calls.http.length, 1);
});

for (const message of [
  "requestPayment:fail banned", "requestPayment:fail access denied; appId=test-app",
  "requestPayment:fail no permission; appId=test-app", "由于小程序违规，支付功能暂时无法使用",
]) {
  test(`restriction modal is actionable: ${message}`, async () => {
    const { page, calls } = setup({ nativeFail: { errMsg: message, errno: 102 } });
    await page.payOrder();
    assert.equal(calls.modals[0].title, "微信支付受限");
    assert.match(calls.modals[0].content, /联系商家/);
    assert.match(calls.modals[0].content, /102/);
    assert.equal(calls.modals[0].showCancel, false);
    assert.equal(page.data.paying, false);
    assert.equal(calls.cloud.length, 1, "a client failure must not cancel or mutate the order");
  });
}

test("unknown native error retains useful details; errno alone does not imply a violation", async () => {
  const { page, calls } = setup({ nativeFail: { errMsg: "requestPayment:fail 系统繁忙", errno: 102 } });
  await page.payOrder();
  assert.equal(calls.modals[0].title, "暂时无法支付");
  assert.match(calls.modals[0].content, /系统繁忙/);
  assert.match(calls.modals[0].content, /102/);
});

for (const error of [{ errMsg: "requestPayment:fail cancel" }, new Error("requestPayment:fail cancel")]) {
  test(`user cancellation stays silent (${Object.keys(error).join() || "Error"})`, async () => {
    const { page, calls } = setup({ nativeFail: error });
    await page.payOrder();
    assert.equal(calls.modals.length, 0);
    assert.equal(calls.toasts.length, 0);
    assert.equal(calls.http.length, 1);
    assert.equal(page.data.paying, false);
  });
}

test("server error containing cancelled is not mistaken for user cancellation", async () => {
  const { page, calls } = setup({ prepareError: new Error("order cancelled by merchant") });
  await page.payOrder();
  assert.equal(calls.modals.length, 1);
  assert.match(calls.modals[0].content, /order cancelled by merchant/);
  assert.equal(calls.native.length, 0);
});

test("HTTP business failure preserves response message and code", async () => {
  const { payment, calls } = setup({ orderResponse: {
    statusCode: 400, data: { code: -1, msg: "业务订单已超时", data: null },
  } });
  await assert.rejects(payment.startOrderPayment("test-order"), (error) => {
    assert.equal(error.message, "业务订单已超时");
    assert.equal(error.statusCode, 400);
    assert.equal(error.code, -1);
    assert.equal(error.stage, "wxpay_order");
    return true;
  });
  assert.equal(calls.native.length, 0);
});

test("wrapped SDK failure is reported instead of missing payment parameters", async () => {
  const { payment, calls } = setup({ orderResponse: response({ code: "APPID_MCHID_NOT_MATCH", message: "appid和商户号不匹配" }, 403) });
  await assert.rejects(payment.startOrderPayment("test-order"), (error) => {
    assert.equal(error.message, "appid和商户号不匹配");
    assert.equal(error.code, "APPID_MCHID_NOT_MATCH");
    assert.equal(error.statusCode, 403);
    return true;
  });
  assert.equal(calls.native.length, 0);
});

test("server HTTP authorization failure is not labeled a mini-program violation", async () => {
  const { page, calls } = setup({ orderResponse: { statusCode: 403, data: { code: -1, msg: "access denied" } } });
  await page.payOrder();
  assert.equal(calls.modals[0].title, "暂时无法支付");
  assert.match(calls.modals[0].content, /access denied/);
});

test("JSON string response bodies are accepted", async () => {
  const { payment, calls } = setup({ orderResponse: { statusCode: 200, data: JSON.stringify(response(paymentParams).data) } });
  assert.equal((await payment.startOrderPayment("test-order")).tradeState, "SUCCESS");
  assert.equal(calls.native.length, 1);
});

test("non-JSON HTTP error page uses a safe service error", async () => {
  const { page, calls } = setup({ orderResponse: { statusCode: 502, data: "<html>private upstream info</html>" } });
  await page.payOrder();
  assert.match(calls.modals[0].content, /502/);
  assert.doesNotMatch(calls.modals[0].content, /<html>|private upstream/);
  assert.equal(calls.native.length, 0);
});

for (const field of ["timeStamp", "nonceStr", "package", "paySign"]) {
  test(`missing ${field} never opens native payment`, async () => {
    const params = { ...paymentParams };
    delete params[field];
    const { payment, calls } = setup({ orderResponse: response(params) });
    await assert.rejects(payment.startOrderPayment("test-order"), /支付参数不完整/);
    assert.equal(calls.native.length, 0);
  });
}

test("native synchronous errors are normalized too", async () => {
  const { payment } = setup({ nativeThrow: { errMsg: "requestPayment:fail 系统异常", errCode: -1 } });
  await assert.rejects(payment.startOrderPayment("test-order"), (error) => {
    assert.match(error.message, /系统异常/);
    assert.equal(error.errCode, -1);
    assert.equal(error.stage, "requestPayment");
    return true;
  });
});

for (const options of [
  { queryFail: { errMsg: "cloud.callHTTPFunction:fail timeout", errno: 600001 } },
  { queryResponse: response({ code: "SYSTEM_ERROR", message: "查单繁忙" }, 500) },
]) {
  test(`query failure after native success shows pending, never payment failure (${Object.keys(options)[0]})`, async () => {
    const { page, calls } = setup(options);
    await page.payOrder();
    assert.equal(calls.modals.length, 0);
    assert.equal(calls.toasts[0].title, "支付结果确认中");
    assert.equal(calls.native.length, 1);
    assert.equal(calls.http.length, 2);
    assert.equal(calls.cloud.length, 1);
    assert.equal(calls.timers.length, 1);
    await calls.timers[0]();
    assert.equal(calls.reloads, 1);
  });
}

test("success preserves trusted preparation data and queries exactly once", async () => {
  const { page, calls } = setup();
  await page.payOrder();
  assert.equal(calls.modals.length, 0);
  assert.equal(calls.toasts[0].title, "支付成功");
  assert.equal(calls.native.length, 1);
  assert.equal(calls.http.length, 2);
  assert.equal(calls.http[0].data.amount.total, 50);
  assert.equal(calls.http[0].data.out_trade_no, order.outTradeNo);
  assert.equal(calls.http[1].data.out_trade_no, order.outTradeNo);
  assert.equal(calls.native[0].timeStamp, paymentParams.timeStamp);
  assert.equal(page.data.paying, false);
});

test("pending query result is not treated as paid", async () => {
  const { page, calls } = setup({ queryResponse: response({ trade_state: "USERPAYING" }) });
  await page.payOrder();
  assert.equal(calls.toasts[0].title, "支付结果确认中");
  assert.equal(calls.modals.length, 0);
});

test("duplicate tap while paying never submits another request", async () => {
  const { page, calls } = setup();
  page.data.paying = true;
  await page.payOrder();
  assert.equal(calls.cloud.length, 0);
  assert.equal(calls.native.length, 0);
});

test("diagnostics never log signatures, payer data or complete error objects", async () => {
  const { page, calls } = setup({ nativeFail: {
    errMsg: "requestPayment:fail banned", errno: 102,
    paySign: "DO_NOT_LOG_SIGNATURE", payer: { openid: "DO_NOT_LOG_PAYER" }, token: "DO_NOT_LOG_TOKEN",
  } });
  await page.payOrder();
  const logs = JSON.stringify(calls.logs);
  assert.match(logs, /requestPayment/);
  assert.match(logs, /102/);
  assert.doesNotMatch(logs, /DO_NOT_LOG|paySign|openid|token/);
});
