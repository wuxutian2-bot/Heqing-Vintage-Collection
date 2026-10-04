const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");

const clone = (value) => {
  if (value instanceof Date) return new Date(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
};

class FakeDatabase {
  constructor(collections, context) {
    this.collections = clone(collections);
    this.context = context;
    this.command = { lt: (value) => ({ operator: "lt", value }) };
    this.transactionTail = Promise.resolve();
  }

  rows(name) {
    if (!this.collections[name]) this.collections[name] = [];
    return this.collections[name];
  }

  collection(name) {
    const database = this;
    return {
      doc(documentId) {
        return {
          async get() {
            const row = database.rows(name).find((item) => item._id === documentId);
            return { data: row ? clone(row) : null };
          },
          async set({ data }) {
            const rows = database.rows(name);
            const index = rows.findIndex((item) => item._id === documentId);
            const record = { ...clone(data), _id: documentId };
            if (index >= 0) rows[index] = record;
            else rows.push(record);
            return { _id: documentId };
          },
          async update({ data }) {
            const row = database.rows(name).find((item) => item._id === documentId);
            if (!row) throw new Error(`document not exist: ${name}/${documentId}`);
            Object.assign(row, clone(data));
            return { stats: { updated: 1 } };
          },
        };
      },
      where(conditions) {
        let maximum = Infinity;
        const query = {
          limit(value) { maximum = value; return query; },
          async get() {
            const data = database.rows(name)
              .filter((row) => Object.entries(conditions).every(([key, value]) => row[key] === value))
              .slice(0, maximum)
              .map(clone);
            return { data };
          },
        };
        return query;
      },
    };
  }

  async runTransaction(callback) {
    const previous = this.transactionTail;
    let release;
    this.transactionTail = new Promise((resolve) => { release = resolve; });
    await previous;
    const snapshot = clone(this.collections);
    try {
      return await callback(this);
    } catch (error) {
      this.collections = snapshot;
      throw error;
    } finally {
      release();
    }
  }
}

const setup = (extraCollections = {}) => {
  const context = { openid: "openid-admin" };
  const database = new FakeDatabase({
    users: [
      { _id: "admin-1", _openid: "openid-admin", role: "admin" },
      { _id: "owner-1", _openid: "openid-owner", role: "user", aliasNo: 1 },
    ],
    goods: [],
    market_inventory: [],
    ...extraCollections,
  }, context);
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database: () => database,
    getWXContext: () => ({ OPENID: context.openid }),
  };
  const filename = path.join(__dirname, "..", "index.js");
  delete require.cache[require.resolve(filename)];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloudMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  let main;
  try {
    main = require(filename).main;
  } finally {
    Module._load = originalLoad;
  }
  return {
    database,
    callAs(openid, event) {
      context.openid = openid;
      return main(event);
    },
  };
};

test("确认收购同时建立 inventory.goodsId/sourceGoodsId 与平台商品价格契约", async () => {
  const context = setup({
    users: [
      { _id: "admin-1", _openid: "openid-admin", role: "admin" },
      { _id: "owner-1", _openid: "openid-owner", role: "user", aliasNo: 1 },
    ],
    goods: [{
      _id: "goods-1", _openid: "openid-owner", authorId: "owner-1",
      title: "二手教材", desc: "少量笔记", category: "教材", images: ["cloud://goods/1.jpg"],
      condition: "八成新", price: 30, status: "on_sale",
    }],
  });

  const submitted = await context.callAs("openid-owner", {
    type: "recoverySubmit", goodsId: "goods-1", requestId: "submit-contract-1",
  });
  const recoveryId = submitted.data.recovery._id;
  await context.callAs("openid-admin", {
    type: "adminQuote", recoveryId, grossAmountFen: 3000, feeAmountFen: 0,
    platformSalePriceFen: 4500, expectedVersion: 1, requestId: "quote-contract-1",
  });
  await context.callAs("openid-owner", {
    type: "quoteAccept", recoveryId, quoteVersion: 1, requestId: "accept-contract-1",
  });
  await context.callAs("openid-admin", {
    type: "adminInspect", recoveryId, result: "passed", condition: "验货八成新",
    expectedVersion: 3, requestId: "inspect-contract-1",
  });
  const acquired = await context.callAs("openid-admin", {
    type: "adminConfirmAcquisition", recoveryId, quoteVersion: 1,
    expectedVersion: 4, requestId: "acquire-contract-1",
  });

  assert.equal(acquired.success, true, JSON.stringify(acquired));
  const inventory = context.database.rows("market_inventory")[0];
  const goods = context.database.rows("goods")[0];
  assert.equal(inventory.goodsId, "goods-1");
  assert.equal(inventory.sourceGoodsId, "goods-1");
  assert.equal(goods.inventoryId, inventory._id);
  assert.equal(goods.platformOwned, true);
  assert.equal(goods.platformSalePriceFen, 4500);
  assert.equal(goods.price, 45);
});

test("管理员上下架在一个事务中同步库存与 goods，并为旧库存补齐 goodsId", async () => {
  const context = setup({
    goods: [{
      _id: "goods-1", status: "on_sale", platformOwned: true,
      inventoryId: "inventory-1", platformSalePriceFen: 5000, price: 1,
    }],
    market_inventory: [{
      _id: "inventory-1", sourceGoodsId: "goods-1", status: "on_sale",
      saleOrderId: "", lockExpiresAt: null, platformSalePriceFen: 5000, version: 1,
    }],
  });

  const result = await context.callAs("openid-admin", {
    type: "admin_market_stock", inventoryId: "inventory-1", status: "off_sale",
    expectedVersion: 1, requestId: "stock-off-0001",
  });

  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.data.changed, true);
  const inventory = context.database.rows("market_inventory")[0];
  const goods = context.database.rows("goods")[0];
  assert.equal(inventory.status, "off_sale");
  assert.equal(inventory.goodsId, "goods-1");
  assert.equal(inventory.version, 2);
  assert.equal(goods.status, "removed");
  assert.equal(goods.price, 50);
});

test("普通用户不能管理库存，锁定库存也不能被管理员直接下架", async () => {
  const seed = {
    goods: [{
      _id: "goods-1", status: "on_sale", platformOwned: true,
      inventoryId: "inventory-1", platformSalePriceFen: 5000,
    }],
    market_inventory: [{
      _id: "inventory-1", goodsId: "goods-1", sourceGoodsId: "goods-1", status: "locked",
      saleOrderId: "sale-1", lockExpiresAt: new Date(Date.now() + 60000),
      platformSalePriceFen: 5000, version: 1,
    }],
  };
  const context = setup(seed);
  const forbidden = await context.callAs("openid-owner", {
    type: "adminStock", inventoryId: "inventory-1", status: "off_sale",
    expectedVersion: 1, requestId: "stock-user-0001",
  });
  assert.equal(forbidden.success, false);
  assert.equal(forbidden.errorCode, "FORBIDDEN");

  const locked = await context.callAs("openid-admin", {
    type: "adminStock", inventoryId: "inventory-1", status: "off_sale",
    expectedVersion: 1, requestId: "stock-lock-0001",
  });
  assert.equal(locked.success, false);
  assert.equal(locked.errorCode, "INVALID_STATE");
  assert.equal(context.database.rows("goods")[0].status, "on_sale");
});
