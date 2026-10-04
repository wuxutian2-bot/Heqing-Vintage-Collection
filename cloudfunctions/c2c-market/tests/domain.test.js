const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");

const clone = (value) => {
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
};

const containsReservedId = (value) => {
  if (value instanceof Date || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsReservedId);
  return Object.entries(value).some(([key, item]) => key === "_id" || containsReservedId(item));
};

class FakeDatabase {
  constructor(collections, { throwOnMissingDocumentGet = false } = {}) {
    this.collections = clone(collections);
    this.command = { lte: (value) => ({ operator: "lte", value }) };
    this.tail = Promise.resolve();
    this.throwOnMissingDocumentGet = throwOnMissingDocumentGet;
  }

  rows(name) { if (!this.collections[name]) this.collections[name] = []; return this.collections[name]; }

  collection(name) {
    const database = this;
    return {
      doc(documentId) {
        return {
          async get() {
            const row = database.rows(name).find((item) => item._id === documentId);
            if (!row && database.throwOnMissingDocumentGet) {
              throw new Error(`document.get:fail document with _id ${documentId} does not exist`);
            }
            return { data: row ? clone(row) : null };
          },
          async set({ data }) {
            if (containsReservedId(data)) {
              throw new Error("document.set:fail -501007 invalid parameters, 不能更新_id的值");
            }
            const rows = database.rows(name); const index = rows.findIndex((item) => item._id === documentId);
            const record = { ...clone(data), _id: documentId };
            if (index >= 0) rows[index] = record; else rows.push(record);
            return { _id: documentId };
          },
          async update({ data }) {
            const row = database.rows(name).find((item) => item._id === documentId);
            if (!row) throw new Error(`document not exist: ${name}/${documentId}`);
            Object.assign(row, clone(data)); return { stats: { updated: 1 } };
          },
        };
      },
      where(conditions) {
        let maximum = Infinity; let skipped = 0; let orderField = ""; let direction = "desc";
        const matches = (row, value) => {
          if (value && value.operator === "lte") return new Date(row).getTime() <= new Date(value.value).getTime();
          return row === value;
        };
        const query = {
          limit(value) { maximum = value; return query; }, skip(value) { skipped = value; return query; },
          orderBy(field, value) { orderField = field; direction = value; return query; },
          async get() {
            const data = database.rows(name).filter((row) => Object.entries(conditions).every(([key, value]) => matches(row[key], value)));
            if (orderField) data.sort((a, b) => (new Date(a[orderField]).getTime() - new Date(b[orderField]).getTime()) * (direction === "asc" ? 1 : -1));
            return { data: data.slice(skipped, skipped + maximum).map(clone) };
          },
        };
        return query;
      },
    };
  }

  async runTransaction(callback) {
    const previous = this.tail; let release; this.tail = new Promise((resolve) => { release = resolve; });
    await previous; const snapshot = clone(this.collections);
    try { return await callback(this); } catch (error) { this.collections = snapshot; throw error; } finally { release(); }
  }
}

const setup = (options = {}) => {
  const context = { openid: "buyer-openid" };
  const database = new FakeDatabase({
    users: [
      { _id: "buyer-1", _openid: "buyer-openid", role: "user", aliasNo: 2 },
      { _id: "seller-1", _openid: "seller-openid", role: "user", aliasNo: 1 },
      { _id: "admin-1", _openid: "admin-openid", role: "admin", aliasNo: 99 },
    ],
    goods: [{ _id: "goods-1", _openid: "seller-openid", authorId: "seller-1", title: "高数教材", desc: "八成新", category: "教材", images: ["cloud://goods/1.jpg"], price: 30, status: "on_sale" }],
    market_c2c_config: [{ _id: "settlement", checkoutEnabled: true, payoutEnabled: false, feeRuleVersion: "test-v1", feeRateBps: 300, minFeeFen: 0, maxFeeFen: 0 }],
  }, options);
  const cloudMock = { DYNAMIC_CURRENT_ENV: "test", init() {}, database: () => database, getWXContext: () => ({ OPENID: context.openid }) };
  const filename = path.join(__dirname, "..", "index.js"); delete require.cache[require.resolve(filename)];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) { if (request === "wx-server-sdk") return cloudMock; return originalLoad.call(this, request, parent, isMain); };
  let main; try { main = require(filename).main; } finally { Module._load = originalLoad; }
  return { database, callAs(openid, event) { context.openid = openid; return main(event); } };
};

test("C2C 创建订单按服务器商品价格锁定商品，幂等请求不会重复锁定", async () => {
  const ctx = setup();
  const first = await ctx.callAs("buyer-openid", { type: "createOrder", goodsId: "goods-1", requestId: "create-order-0001" });
  const second = await ctx.callAs("buyer-openid", { type: "createOrder", goodsId: "goods-1", requestId: "create-order-0001" });
  assert.equal(first.success, true, JSON.stringify(first));
  assert.equal(second.success, true, JSON.stringify(second));
  assert.equal(first.data.order._id, second.data.order._id);
  assert.equal(first.data.order.totalAmountFen, 3000);
  assert.equal(first.data.order.feeAmountFen, 90);
  assert.equal(first.data.order.sellerAmountFen, 2910);
  assert.equal(ctx.database.rows("market_c2c_orders").length, 1);
  const goods = ctx.database.rows("goods")[0];
  assert.equal(goods.status, "locked");
  assert.equal(goods.c2cOrderId, first.data.order._id);
});

test("云开发以 does not exist 表示首次读取幂等记录时，仍可创建订单", async () => {
  const ctx = setup({ throwOnMissingDocumentGet: true });
  const created = await ctx.callAs("buyer-openid", {
    type: "createOrder", goodsId: "goods-1", requestId: "create-order-throws-not-found",
  });
  assert.equal(created.success, true, JSON.stringify(created));
  assert.equal(ctx.database.rows("market_c2c_orders").length, 1);
});

test("卖家交付、买家确认后生成一次不可变待结算记录", async () => {
  const ctx = setup();
  const created = await ctx.callAs("buyer-openid", { type: "createOrder", goodsId: "goods-1", requestId: "create-order-0002" });
  const orderId = created.data.order._id;
  const order = ctx.database.rows("market_c2c_orders")[0];
  Object.assign(order, { status: "paid", paymentStatus: "paid", paidAt: new Date() });
  Object.assign(ctx.database.rows("goods")[0], { status: "trading", c2cTradeStatus: "paid", c2cLockExpiresAt: null });

  const delivered = await ctx.callAs("seller-openid", { type: "sellerDeliver", id: orderId, deliveryNote: "图书馆门口交付", requestId: "deliver-order-0002" });
  assert.equal(delivered.success, true, JSON.stringify(delivered));
  const confirmed = await ctx.callAs("buyer-openid", { type: "buyerConfirm", id: orderId, requestId: "confirm-order-0002" });
  assert.equal(confirmed.success, true, JSON.stringify(confirmed));
  assert.equal(ctx.database.rows("market_c2c_orders")[0].status, "settlement_available");
  assert.equal(ctx.database.rows("goods")[0].status, "sold");
  const ledger = ctx.database.rows("market_c2c_ledger");
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].amountFen, 2910);
  assert.equal(ledger[0].immutable, true);
});

test("争议冻结已付款订单，默认配置不能把待结算记录伪造为已转账", async () => {
  const ctx = setup();
  const created = await ctx.callAs("buyer-openid", { type: "createOrder", goodsId: "goods-1", requestId: "create-order-0003" });
  const orderId = created.data.order._id;
  Object.assign(ctx.database.rows("market_c2c_orders")[0], { status: "paid", paymentStatus: "paid" });
  Object.assign(ctx.database.rows("goods")[0], { status: "trading", c2cTradeStatus: "paid" });
  const disputed = await ctx.callAs("buyer-openid", { type: "openDispute", id: orderId, reason: "商品与描述不符", requestId: "dispute-order-0003" });
  assert.equal(disputed.success, true, JSON.stringify(disputed));
  assert.equal(ctx.database.rows("market_c2c_orders")[0].settlementStatus, "frozen");

  const payout = await ctx.callAs("seller-openid", { type: "requestPayout", id: orderId });
  assert.equal(payout.success, false);
  assert.equal(payout.errorCode, "INVALID_STATE");
  assert.equal(ctx.database.rows("market_c2c_payouts").length, 0);
});
