const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const Module = require("node:module");

const clone = (value) => JSON.parse(JSON.stringify(value));

const setup = (goods) => {
  const state = {
    openid: "openid-owner",
    users: [
      { _id: "owner-1", _openid: "openid-owner", role: "user" },
      { _id: "admin-1", _openid: "openid-admin", role: "admin" },
    ],
    goods: [clone(goods)],
    favorites: [],
  };
  const database = {
    command: {},
    collection(name) {
      return {
        doc(documentId) {
          return {
            async get() {
              return { data: clone(state[name].find((row) => row._id === documentId) || null) };
            },
            async update({ data }) {
              const row = state[name].find((item) => item._id === documentId);
              if (!row) throw new Error("document not exist");
              Object.assign(row, clone(data));
              return { stats: { updated: 1 } };
            },
          };
        },
        where(conditions) {
          let maximum = Infinity;
          const selected = () => state[name]
            .filter((row) => Object.entries(conditions).every(([key, value]) => row[key] === value));
          const query = {
            limit(value) { maximum = value; return query; },
            async get() { return { data: clone(selected().slice(0, maximum)) }; },
            async remove() {
              const matched = new Set(selected());
              const before = state[name].length;
              state[name] = state[name].filter((row) => !matched.has(row));
              return { stats: { removed: before - state[name].length } };
            },
          };
          return query;
        },
      };
    },
  };
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: "test",
    init() {},
    database: () => database,
    getWXContext: () => ({ OPENID: state.openid }),
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
    state,
    callAs(openid, event) {
      state.openid = openid;
      return main(event);
    },
  };
};

test("进行中的回收单阻止原商品改状态和删除", async () => {
  const context = setup({
    _id: "goods-1", _openid: "openid-owner", authorId: "owner-1",
    title: "二手教材", status: "on_sale", recoveryOrderId: "recovery-1", recoveryStatus: "quote_accepted",
  });

  const statusResult = await context.callAs("openid-owner", {
    type: "updateStatus", id: "goods-1", status: "removed",
  });
  const deleteResult = await context.callAs("openid-owner", { type: "delete", id: "goods-1" });

  assert.equal(statusResult.success, false);
  assert.match(statusResult.errMsg, /回收流程/);
  assert.equal(deleteResult.success, false);
  assert.match(deleteResult.errMsg, /回收流程/);
  assert.equal(context.state.goods.length, 1);
  assert.equal(context.state.goods[0].status, "on_sale");
});

test("平台商品即使由管理员操作也不能绕过 market 库存事务", async () => {
  const context = setup({
    _id: "goods-1", _openid: "openid-owner", authorId: "owner-1",
    title: "平台二手教材", status: "on_sale", platformOwned: true, inventoryId: "inventory-1",
  });

  const adminResult = await context.callAs("openid-admin", {
    type: "updateStatus", id: "goods-1", status: "removed",
  });
  const ownerDelete = await context.callAs("openid-owner", { type: "delete", id: "goods-1" });

  assert.equal(adminResult.success, false);
  assert.match(adminResult.errMsg, /市场库存管理/);
  assert.equal(ownerDelete.success, false);
  assert.match(ownerDelete.errMsg, /平台已收购商品/);
  assert.equal(context.state.goods[0].status, "on_sale");
});
