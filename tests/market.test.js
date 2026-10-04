const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");

const clone = (value) => {
  if (value instanceof Date) return new Date(value);
  if (value instanceof RegExp) return new RegExp(value.source, value.flags);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
};

const command = {
  lt: (value) => ({ __op: "lt", value }),
  lte: (value) => ({ __op: "lte", value }),
  gt: (value) => ({ __op: "gt", value }),
  gte: (value) => ({ __op: "gte", value }),
  in: (values) => ({ __op: "in", values }),
  inc: (value) => ({ __op: "inc", value }),
};

const matches = (row, conditions = {}) => Object.entries(conditions).every(([key, expected]) => {
  const actual = row[key];
  if (expected instanceof RegExp) return expected.test(String(actual || ""));
  if (expected && expected.__op === "lt") return actual < expected.value;
  if (expected && expected.__op === "lte") return actual <= expected.value;
  if (expected && expected.__op === "gt") return actual > expected.value;
  if (expected && expected.__op === "gte") return actual >= expected.value;
  if (expected && expected.__op === "in") return expected.values.includes(actual);
  return actual === expected;
});

const applyUpdate = (row, data = {}) => {
  Object.entries(data).forEach(([key, value]) => {
    if (value && value.__op === "inc") row[key] = Number(row[key] || 0) + Number(value.value || 0);
    else row[key] = clone(value);
  });
};

class FakeDocumentReference {
  constructor(database, collectionName, documentId) {
    this.database = database;
    this.collectionName = collectionName;
    this.documentId = documentId;
  }

  async get() {
    const row = this.database.find(this.collectionName, this.documentId);
    return { data: row ? clone(row) : null };
  }

  async set({ data }) {
    const rows = this.database.rows(this.collectionName);
    const index = rows.findIndex((row) => row._id === this.documentId);
    const next = { ...clone(data), _id: this.documentId };
    if (index >= 0) rows[index] = next;
    else rows.push(next);
    return { _id: this.documentId };
  }

  async update({ data }) {
    const row = this.database.find(this.collectionName, this.documentId);
    if (!row) throw new Error(`document not exist: ${this.collectionName}/${this.documentId}`);
    applyUpdate(row, data);
    return { stats: { updated: 1 } };
  }

  async remove() {
    const rows = this.database.rows(this.collectionName);
    const before = rows.length;
    this.database.state.collections[this.collectionName] = rows.filter((row) => row._id !== this.documentId);
    return { stats: { removed: before - this.database.state.collections[this.collectionName].length } };
  }
}

class FakeCollectionReference {
  constructor(database, name) {
    this.database = database;
    this.name = name;
    this.conditions = {};
    this.sort = null;
    this.offset = 0;
    this.maximum = Infinity;
  }

  doc(id) { return new FakeDocumentReference(this.database, this.name, id); }
  where(conditions) { this.conditions = conditions || {}; return this; }
  orderBy(field, direction) { this.sort = { field, direction }; return this; }
  skip(value) { this.offset = Number(value || 0); return this; }
  limit(value) { this.maximum = Number(value); return this; }

  selected() {
    let rows = this.database.rows(this.name).filter((row) => matches(row, this.conditions));
    if (this.sort) {
      const factor = this.sort.direction === "desc" ? -1 : 1;
      rows = rows.slice().sort((left, right) => {
        const a = left[this.sort.field] instanceof Date ? left[this.sort.field].getTime() : left[this.sort.field];
        const b = right[this.sort.field] instanceof Date ? right[this.sort.field].getTime() : right[this.sort.field];
        return a === b ? 0 : (a > b ? factor : -factor);
      });
    }
    return rows.slice(this.offset, this.offset + this.maximum);
  }

  async get() { return { data: this.selected().map(clone) }; }

  async add({ data }) {
    const documentId = `${this.name}-${++this.database.state.sequence}`;
    this.database.rows(this.name).push({ ...clone(data), _id: documentId });
    return { _id: documentId };
  }

  async count() { return { total: this.selected().length }; }
}

class FakeDatabase {
  constructor(state) {
    this.state = state;
    this.command = command;
    this.transactionTail = Promise.resolve();
  }

  rows(name) {
    if (!this.state.collections[name]) this.state.collections[name] = [];
    return this.state.collections[name];
  }

  find(name, id) { return this.rows(name).find((row) => row._id === id) || null; }
  collection(name) { return new FakeCollectionReference(this, name); }
  RegExp({ regexp, options }) { return new RegExp(regexp, options); }

  async runTransaction(callback) {
    const previous = this.transactionTail;
    let release;
    this.transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    const snapshot = clone(this.state.collections);
    try {
      return await callback(this);
    } catch (error) {
      this.state.collections = snapshot;
      throw error;
    } finally {
      release();
    }
  }
}

const baseCollections = () => ({
  users: [
    { _id: "owner-1", _openid: "openid-owner", role: "user", aliasNo: 1 },
    { _id: "buyer-1", _openid: "openid-buyer-1", role: "user", aliasNo: 2 },
    { _id: "buyer-2", _openid: "openid-buyer-2", role: "user", aliasNo: 3 },
    { _id: "admin-1", _openid: "openid-admin", role: "admin", aliasNo: 9 },
  ],
  goods: [
    {
      _id: "goods-1",
      _openid: "openid-owner",
      authorId: "owner-1",
      title: "二手高等数学教材",
      desc: "有少量笔记",
      category: "教材",
      condition: "八成新",
      images: ["cloud://test/goods-1.jpg"],
      price: 38,
      status: "on_sale",
    },
    {
      _id: "wanted-1",
      _openid: "openid-owner",
      authorId: "owner-1",
      title: "求购教材",
      desc: "预算价格",
      category: "求购",
      images: ["cloud://test/wanted-1.jpg"],
      price: 20,
      status: "on_sale",
    },
  ],
});

const setup = (collections = baseCollections()) => {
  const state = { collections: clone(collections), openid: "openid-owner", sequence: 100 };
  const database = new FakeDatabase(state);
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database: () => database,
    getWXContext: () => ({ OPENID: state.openid }),
  };
  const filename = path.join(__dirname, "..", "cloudfunctions", "market", "index.js");
  const resolved = require.resolve(filename);
  delete require.cache[resolved];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloudMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  let main;
  try {
    main = require(resolved).main;
  } finally {
    Module._load = originalLoad;
  }
  const callAs = (openid, event) => {
    state.openid = openid;
    return main(event);
  };
  return { state, database, main, callAs };
};

const completeAcquisition = async (context, amounts = {}) => {
  const grossAmountFen = amounts.grossAmountFen ?? 3000;
  const feeAmountFen = amounts.feeAmountFen ?? 0;
  const platformSalePriceFen = amounts.platformSalePriceFen ?? 4500;
  const submitted = await context.callAs("openid-owner", {
    type: "recoverySubmit", goodsId: "goods-1", requestId: "submit-0001",
  });
  assert.equal(submitted.success, true);
  const recoveryId = submitted.data.recovery._id;

  const quoted = await context.callAs("openid-admin", {
    type: "adminQuote",
    recoveryId,
    grossAmountFen,
    feeAmountFen,
    platformSalePriceFen,
    expectedVersion: 1,
    requestId: "quote-00001",
  });
  assert.equal(quoted.success, true, JSON.stringify(quoted));
  assert.equal(quoted.data.recovery.quote.version, 1);

  const accepted = await context.callAs("openid-owner", {
    type: "quoteAccept", recoveryId, quoteVersion: 1, requestId: "accept-0001",
  });
  assert.equal(accepted.success, true);

  const inspected = await context.callAs("openid-admin", {
    type: "adminInspect",
    recoveryId,
    result: "passed",
    condition: "验货八成新",
    evidenceImages: ["cloud://test/inspection.jpg"],
    expectedVersion: 3,
    requestId: "inspect-0001",
  });
  assert.equal(inspected.success, true);
  assert.equal(inspected.data.recovery.status, "inspected");

  const acquired = await context.callAs("openid-admin", {
    type: "adminConfirmAcquisition",
    recoveryId,
    quoteVersion: 1,
    expectedVersion: 4,
    requestId: "acquire-0001",
  });
  assert.equal(acquired.success, true);
  return { recoveryId, inventoryId: acquired.data.inventoryId };
};

test("回收申请只允许商品本人，且求购信息不能申请回收", async () => {
  const context = setup();

  const foreign = await context.callAs("openid-buyer-1", {
    type: "recoverySubmit", goodsId: "goods-1", requestId: "foreign-0001",
  });
  assert.equal(foreign.success, false);
  assert.equal(foreign.errorCode, "FORBIDDEN");

  const wanted = await context.callAs("openid-owner", {
    type: "recoverySubmit", goodsId: "wanted-1", requestId: "wanted-00001",
  });
  assert.equal(wanted.success, false);
  assert.equal(wanted.errorCode, "INVALID_GOODS");
  assert.equal((context.state.collections.market_recovery_orders || []).length, 0);
});

test("重复回收申请使用确定性回收单，幂等键不能换商品", async () => {
  const context = setup();
  const request = { type: "recoverySubmit", goodsId: "goods-1", requestId: "submit-repeat-1" };
  const first = await context.callAs("openid-owner", request);
  const second = await context.callAs("openid-owner", request);

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(first.data.recovery._id, second.data.recovery._id);
  assert.equal(context.state.collections.market_recovery_orders.length, 1);

  const conflict = await context.callAs("openid-owner", {
    ...request, goodsId: "wanted-1",
  });
  assert.equal(conflict.success, false);
  assert.equal(conflict.errorCode, "IDEMPOTENCY_CONFLICT");
});

test("用户只能接受当前报价版本，验货前必须完成报价确认", async () => {
  const context = setup();
  const submitted = await context.callAs("openid-owner", {
    type: "recoverySubmit", goodsId: "goods-1", requestId: "submit-quote-1",
  });
  const recoveryId = submitted.data.recovery._id;
  const quoted = await context.callAs("openid-admin", {
    type: "adminQuote",
    recoveryId,
    grossAmountFen: 2500,
    feeAmountFen: 0,
    platformSalePriceFen: 3600,
    expectedVersion: 1,
    requestId: "quote-version-1",
  });
  assert.equal(quoted.success, true, JSON.stringify(quoted));
  assert.equal(quoted.data.recovery.quote.netAmountFen, 2500);

  const stale = await context.callAs("openid-owner", {
    type: "quoteAccept", recoveryId, quoteVersion: 2, requestId: "accept-stale-1",
  });
  assert.equal(stale.success, false);
  assert.equal(stale.errorCode, "QUOTE_CHANGED");

  const accepted = await context.callAs("openid-owner", {
    type: "quoteAccept", recoveryId, quoteVersion: 1, requestId: "accept-current1",
  });
  assert.equal(accepted.success, true);
  assert.equal(accepted.data.recovery.status, "quote_accepted");
  assert.equal(accepted.data.recovery.acceptedQuoteVersion, 1);
});

test("验货确认收购在并发重试下只创建一份库存和一笔应付款", async () => {
  const context = setup();
  const submitted = await context.callAs("openid-owner", {
    type: "recoverySubmit", goodsId: "goods-1", requestId: "submit-race-01",
  });
  const recoveryId = submitted.data.recovery._id;
  await context.callAs("openid-admin", {
    type: "adminQuote", recoveryId, grossAmountFen: 3200, feeAmountFen: 0,
    platformSalePriceFen: 4800, expectedVersion: 1, requestId: "quote-race-001",
  });
  await context.callAs("openid-owner", {
    type: "quoteAccept", recoveryId, quoteVersion: 1, requestId: "accept-race-01",
  });
  await context.callAs("openid-admin", {
    type: "adminInspect", recoveryId, result: "passed", expectedVersion: 3,
    requestId: "inspect-race-1",
  });

  const firstPromise = context.callAs("openid-admin", {
    type: "adminConfirmAcquisition", recoveryId, quoteVersion: 1,
    expectedVersion: 4, requestId: "acquire-race-1",
  });
  const secondPromise = context.callAs("openid-admin", {
    type: "adminConfirmAcquisition", recoveryId, quoteVersion: 1,
    expectedVersion: 4, requestId: "acquire-race-2",
  });
  const results = await Promise.all([firstPromise, secondPromise]);

  assert.equal(results.every((result) => result.success), true);
  assert.deepEqual(results.map((result) => result.data.created).sort(), [false, true]);
  assert.equal(context.state.collections.market_inventory.length, 1);
  assert.equal(
    context.state.collections.market_finance_entries.filter((row) => row.type === "payable_confirmed").length,
    1
  );
  assert.equal(context.state.collections.market_recovery_orders[0].payableAmountFen, 3200);
});

test("平台商品并发下单只锁给一个买家，价格、归属和取消都由服务端控制", async () => {
  const context = setup();
  const { inventoryId } = await completeAcquisition(context, {
    grossAmountFen: 3000, platformSalePriceFen: 4999,
  });

  const buyerOne = context.callAs("openid-buyer-1", {
    type: "saleCreate", inventoryId, requestId: "sale-buyer-001",
    totalAmountFen: 1, priceFen: 1,
  });
  const buyerTwo = context.callAs("openid-buyer-2", {
    type: "saleCreate", inventoryId, requestId: "sale-buyer-002",
    totalAmountFen: 2, priceFen: 2,
  });
  const attempts = await Promise.all([buyerOne, buyerTwo]);
  const success = attempts.find((result) => result.success);
  const failure = attempts.find((result) => !result.success);

  assert.ok(success);
  assert.ok(failure);
  assert.equal(failure.errorCode, "INVENTORY_LOCKED");
  assert.equal(context.state.collections.market_sale_orders.length, 1);
  assert.equal(context.state.collections.market_inventory[0].status, "locked");
  assert.equal(success.data.order.totalAmountFen, 4999);

  const rawOrder = context.state.collections.market_sale_orders[0];
  const ownerOpenId = rawOrder.buyerUserId === "buyer-1" ? "openid-buyer-1" : "openid-buyer-2";
  const otherOpenId = ownerOpenId === "openid-buyer-1" ? "openid-buyer-2" : "openid-buyer-1";
  const foreign = await context.callAs(otherOpenId, {
    type: "salePreparePayment", orderId: rawOrder._id, totalAmountFen: 1,
  });
  assert.equal(foreign.success, false);
  assert.equal(foreign.errorCode, "SALE_NOT_FOUND");

  const prepared = await context.callAs(ownerOpenId, {
    type: "salePreparePayment", orderId: rawOrder._id, totalAmountFen: 1,
  });
  assert.equal(prepared.success, true);
  assert.equal(prepared.data.totalAmountFen, 4999);
  assert.equal(prepared.data.outTradeNo, rawOrder.outTradeNo);

  const cancelled = await context.callAs(ownerOpenId, {
    type: "saleCancel", orderId: rawOrder._id, requestId: "cancel-sale-001",
  });
  assert.equal(cancelled.success, true);
  assert.equal(context.state.collections.market_sale_orders[0].status, "cancelled");
  assert.equal(context.state.collections.market_inventory[0].status, "on_sale");

  const repeated = await context.callAs(ownerOpenId, {
    type: "saleCancel", orderId: rawOrder._id, requestId: "cancel-sale-002",
  });
  assert.equal(repeated.success, true);
  assert.equal(repeated.data.cancelled, false);
  assert.equal(context.state.collections.market_inventory[0].status, "on_sale");
});

test("领取申请拒绝客户端资金字段，使用服务端净回收款且不能重复领取", async () => {
  const context = setup();
  const { recoveryId } = await completeAcquisition(context, {
    grossAmountFen: 199999,
    feeAmountFen: 0,
    platformSalePriceFen: 220000,
  });

  const forged = await context.callAs("openid-owner", {
    type: "claimCreate",
    recoveryId,
    requestId: "claim-forged-1",
    transferAmountFen: 10,
    openid: "openid-attacker",
    out_bill_no: "FORGED001",
    sceneId: "1000",
  });
  assert.equal(forged.success, false);
  assert.equal(forged.errorCode, "FORBIDDEN_FIELD");
  assert.equal((context.state.collections.market_claims || []).length, 0);

  const first = await context.callAs("openid-owner", {
    type: "claimCreate", recoveryId, requestId: "claim-valid-001",
  });
  assert.equal(first.success, true);
  assert.equal(first.data.created, true);
  assert.equal(first.data.claim.transferAmountFen, 199999);
  const rawClaim = context.state.collections.market_claims[0];
  assert.equal(rawClaim.ownerOpenId, "openid-owner");
  assert.equal(rawClaim.transferAmountFen, 199999);
  assert.equal(rawClaim.sceneId, "1010");
  assert.deepEqual(rawClaim.transferSceneReportInfos, [{
    info_type: "回收商品名称",
    info_content: "二手高等数学教材",
  }]);
  assert.match(rawClaim.outBillNo, /^MR[A-F0-9]{30}$/);

  const sameRequest = await context.callAs("openid-owner", {
    type: "claimCreate", recoveryId, requestId: "claim-valid-001",
  });
  const anotherRequest = await context.callAs("openid-owner", {
    type: "claimCreate", recoveryId, requestId: "claim-valid-002",
  });
  assert.equal(sameRequest.success, true);
  assert.equal(anotherRequest.success, true);
  assert.equal(anotherRequest.data.created, false);
  assert.equal(context.state.collections.market_claims.length, 1);
  assert.equal(
    context.state.collections.market_finance_entries.filter((row) => row.type === "claim_reserved").length,
    1
  );

  const foreignRead = await context.callAs("openid-buyer-1", {
    type: "claimGet", claimId: rawClaim._id,
  });
  assert.equal(foreignRead.success, false);
  assert.equal(foreignRead.errorCode, "CLAIM_NOT_FOUND");
});

test("达到 200000 分的回收报价被拒绝，不能形成超出当前能力的领取单", async () => {
  const context = setup();
  const submitted = await context.callAs("openid-owner", {
    type: "recoverySubmit", goodsId: "goods-1", requestId: "submit-limit-1",
  });
  const rejected = await context.callAs("openid-admin", {
    type: "adminQuote",
    recoveryId: submitted.data.recovery._id,
    grossAmountFen: 200000,
    feeAmountFen: 0,
    platformSalePriceFen: 220000,
    expectedVersion: 1,
    requestId: "quote-limit-001",
  });
  assert.equal(rejected.success, false);
  assert.equal(rejected.errorCode, "INVALID_AMOUNT");
  assert.equal((context.state.collections.market_claims || []).length, 0);
});
