const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const crypto = require("node:crypto");

const orderSeed = () => ({
  _id: "database-order-1", orderNo: "202609041234560001", outTradeNo: "PY202609041234560001",
  buyerUserId: "buyer-1", buyerOpenId: "openid-1", outletName: "测试代售点",
  status: "pending_payment", totalAmountFen: 50, itemAmountFen: 50, deliveryFeeFen: 0,
  stockReleased: false, expiresAt: new Date(Date.now() + 600000), createdAt: new Date(),
  delivery: { room: "测试宿舍", phone: "TEST_ONLY" },
  items: [{ productId: "product-1", quantity: 1, priceFen: 50 }],
});

const runModule = (filename, globals, dependencies) => {
  const output = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", filename), "utf8"), {
    exports: output, module: { exports: output }, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename });
  return output;
};

const setupBackend = ({ openid = "openid-1", orders = [orderSeed()], lookupError = false } = {}) => {
  const state = {
    users: [
      { _id: "buyer-1", _openid: "openid-1", role: "user" },
      { _id: "buyer-2", _openid: "openid-2", role: "user" },
      { _id: "admin-1", _openid: "openid-admin", role: "admin" },
    ],
    orders, store_products: [{ _id: "product-1", stock: 5 }],
  };
  const calls = { queries: [], docUpdates: [] };
  const db = {
    command: { lt: (value) => ({ __lt: value }) },
    collection(name) {
      const records = state[name];
      assert.ok(records, `Unexpected collection: ${name}`);
      let conditions = {};
      let count = Infinity;
      const query = {
        where(value) { conditions = value; calls.queries.push({ name, conditions }); return query; },
        limit(value) { count = value; return query; },
        async get() {
          if (lookupError && name === "orders" && Object.hasOwn(conditions, "_id")) {
            throw new Error("database temporarily unavailable");
          }
          return { data: records.filter((record) => Object.entries(conditions).every(([key, value]) => (
            value && typeof value === "object" && Object.hasOwn(value, "__lt")
              ? record[key] < value.__lt : record[key] === value
          ))).slice(0, count) };
        },
        doc(id) {
          return {
            async get() { return { data: records.find((record) => record._id === id) || null }; },
            async update({ data }) {
              const record = records.find((item) => item._id === id);
              assert.ok(record, `Unknown document: ${name}/${id}`);
              Object.assign(record, data);
              calls.docUpdates.push({ name, id });
            },
          };
        },
      };
      return query;
    },
    async runTransaction(callback) { return callback(db); },
  };
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: openid }) };
  const { main } = runModule("cloudfunctions/orders/index.js", {}, { "wx-server-sdk": cloud, crypto });
  return { main, state, calls };
};

for (const reference of ["database-order-1", "PY202609041234560001"]) {
  test(`owned detail works with ${reference}`, async () => {
    const { main } = setupBackend();
    const result = await main({ type: "detail", id: reference });
    assert.equal(result.success, true);
    assert.equal(result.data._id, "database-order-1");
    assert.equal(result.data.totalAmountFen, 50);
    assert.equal(result.data.buyerOpenId, undefined);
  });

  test(`prepare-payment uses stored amount with ${reference}`, async () => {
    const { main } = setupBackend();
    const result = await main({ type: "preparePayment", id: reference, totalAmountFen: 1 });
    assert.equal(result.success, true);
    assert.equal(result.data.outTradeNo, "PY202609041234560001");
    assert.equal(result.data.totalAmountFen, 50);
  });

  test(`cancel uses canonical document ID and releases stock once with ${reference}`, async () => {
    const { main, state, calls } = setupBackend();
    const result = await main({ type: "cancel", id: reference });
    assert.equal(result.success, true);
    assert.equal(result.id, "database-order-1");
    assert.equal(state.orders[0].status, "cancelled");
    assert.equal(state.store_products[0].stock, 6);
    assert.ok(calls.docUpdates.some((item) => item.name === "orders" && item.id === "database-order-1"));
    assert.equal((await main({ type: "cancel", id: reference })).success, false);
    assert.equal(state.store_products[0].stock, 6);
  });
}

for (const type of ["detail", "preparePayment", "cancel"]) {
  for (const openid of ["openid-2", ""]) {
    test(`${type} rejects foreign/anonymous caller (${openid || "anonymous"})`, async () => {
      const { main, state } = setupBackend({ openid });
      const result = await main({ type, id: "PY202609041234560001", buyerUserId: "buyer-1", role: "admin" });
      assert.equal(result.success, false);
      assert.equal(result.data, undefined);
      assert.equal(state.orders[0].status, "pending_payment");
      assert.equal(state.store_products[0].stock, 5);
    });
  }
}

test("admin retains read-only detail access but cannot pay/cancel for the buyer", async () => {
  const { main, state } = setupBackend({ openid: "openid-admin" });
  assert.equal((await main({ type: "detail", id: "PY202609041234560001" })).success, true);
  for (const type of ["preparePayment", "cancel"]) {
    assert.equal((await main({ type, id: "PY202609041234560001" })).success, false);
  }
  assert.equal(state.orders[0].status, "pending_payment");
});

for (const id of [undefined, "", "missing", "202609041234560001", { $ne: null }, ["database-order-1"], "database-order-1".padEnd(65, " ")]) {
  test(`invalid or unmatched reference fails closed: ${JSON.stringify(id)}`, async () => {
    const { main } = setupBackend();
    const result = await main({ type: "detail", id });
    assert.equal(result.success, false);
    assert.equal(result.data, undefined);
  });
}

test("an ID match never falls through to a different owned trade-number match", async () => {
  const other = { ...orderSeed(), _id: "PY202609041234560001", outTradeNo: "PY_OTHER", buyerUserId: "buyer-2" };
  const { main } = setupBackend({ orders: [other, orderSeed()] });
  const result = await main({ type: "detail", id: "PY202609041234560001" });
  assert.equal(result.success, false);
  assert.equal(result.data, undefined);
});

test("duplicate trade numbers are rejected rather than selecting an arbitrary order", async () => {
  const duplicate = { ...orderSeed(), _id: "database-order-duplicate" };
  const { main } = setupBackend({ orders: [orderSeed(), duplicate] });
  assert.equal((await main({ type: "detail", id: "PY202609041234560001" })).success, false);
});

test("database lookup failures are not swallowed or treated as a missing ID", async () => {
  const { main, calls } = setupBackend({ lookupError: true });
  const result = await main({ type: "detail", id: "PY202609041234560001" });
  assert.equal(result.success, false);
  assert.match(result.errMsg, /database temporarily unavailable/);
  assert.equal(calls.queries.some((item) => Object.hasOwn(item.conditions, "outTradeNo")), false);
});

for (const status of ["paid", "cancelled", "expired"]) {
  test(`trade-number routing retains ${status} state guards`, async () => {
    const { main, state } = setupBackend({ orders: [{ ...orderSeed(), status }] });
    assert.equal((await main({ type: "detail", id: "PY202609041234560001" })).success, true);
    assert.equal((await main({ type: "preparePayment", id: "PY202609041234560001" })).success, false);
    assert.equal((await main({ type: "cancel", id: "PY202609041234560001" })).success, false);
    assert.equal(state.orders[0].status, status);
    assert.equal(state.store_products[0].stock, 5);
  });
}

const setupPage = ({ loggedIn = true, loadError = false } = {}) => {
  const calls = { cloud: [], pay: [], modals: [], loginChecks: 0 };
  let loggedInNow = loggedIn;
  let page;
  const cloud = {
    async callCloud(name, data) {
      calls.cloud.push({ name, data: { ...data } });
      if (loadError) throw new Error("订单不存在");
      return { success: true, data: orderSeed() };
    },
    formatPrice: (value) => (Number(value || 0) / 100).toFixed(2),
    formatTime: () => "09-04 12:34",
    requireLogin: () => { calls.loginChecks += 1; return loggedInNow; },
  };
  runModule("miniprogram/pages/order-detail/index.js", {
    Page: (value) => { page = value; },
    getApp: () => ({ globalData: { paymentFunctionName: "test-only", paymentBusinessHookReady: true } }),
    setTimeout() {},
    wx: { showToast() {}, showModal(value) { calls.modals.push(value); } },
  }, {
    "../../utils/cloud": cloud,
    "../../utils/payment": {
      async startOrderPayment(id) { calls.pay.push(id); return { tradeState: "SUCCESS" }; },
      getPaymentErrorInfo: () => ({ cancelled: false, title: "测试错误", content: "测试" }),
      logPaymentError() {},
    },
  });
  page.setData = (value) => Object.assign(page.data, value);
  page.onLoad({ id: "PY202609041234560001" });
  return { page, calls, login: () => { loggedInNow = true; } };
};

test("client resolves external reference once then pays/cancels by canonical ID", async () => {
  const { page, calls } = setupPage();
  await page.loadOrder();
  assert.equal(calls.cloud[0].data.id, "PY202609041234560001");
  assert.equal(page.data.id, "database-order-1");
  assert.equal(page.data.order.totalAmountText, "0.50");
  await page.payOrder();
  assert.equal(calls.pay[0], "database-order-1");
  page.cancelOrder();
  await calls.modals[0].success({ confirm: true });
  assert.ok(calls.cloud.some((item) => item.data.type === "cancel" && item.data.id === "database-order-1"));
});

test("external reference is retained while login is required and used after returning", async () => {
  const { page, calls, login } = setupPage({ loggedIn: false });
  const loadOrder = page.loadOrder.bind(page);
  let loading;
  page.loadOrder = () => { loading = loadOrder(); return loading; };
  page.onShow();
  assert.equal(calls.cloud.length, 0);
  assert.equal(page.data.id, "PY202609041234560001");
  login();
  page.onShow();
  await loading;
  assert.equal(calls.cloud[0].data.id, "PY202609041234560001");
  assert.equal(page.data.id, "database-order-1");
});
