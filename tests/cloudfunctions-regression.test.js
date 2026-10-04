const assert = require("node:assert/strict");
const fs = require("node:fs");
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

const command = {
  all: (values) => ({ __op: "all", values }),
  in: (values) => ({ __op: "in", values }),
  inc: (value) => ({ __op: "inc", value }),
};

const matches = (document, where = {}) => Object.entries(where).every(([key, expected]) => {
  const actual = document[key];
  if (expected && expected.__op === "in") return expected.values.includes(actual);
  if (expected && expected.__op === "all") {
    return Array.isArray(actual) && expected.values.every((value) => actual.includes(value));
  }
  return actual === expected;
});

const applyUpdate = (document, data) => {
  Object.entries(data || {}).forEach(([key, value]) => {
    if (value && value.__op === "inc") {
      document[key] = Number(document[key] || 0) + Number(value.value || 0);
    } else {
      document[key] = clone(value);
    }
  });
};

class FakeDocumentReference {
  constructor(database, name, id) {
    this.database = database;
    this.name = name;
    this.id = id;
  }

  async get() {
    const document = this.database.find(this.name, this.id);
    return { data: document ? clone(document) : null };
  }

  async update({ data }) {
    const document = this.database.find(this.name, this.id);
    if (!document) return { stats: { updated: 0 } };
    applyUpdate(document, data);
    return { stats: { updated: 1 } };
  }

  async set({ data }) {
    const documents = this.database.documents(this.name);
    const index = documents.findIndex((item) => item._id === this.id);
    const next = { _id: this.id, ...clone(data) };
    if (index >= 0) documents[index] = next;
    else documents.push(next);
    return { _id: this.id, stats: { created: index < 0 ? 1 : 0, updated: index >= 0 ? 1 : 0 } };
  }

  async remove() {
    const documents = this.database.documents(this.name);
    const before = documents.length;
    this.database.state.collections[this.name] = documents.filter((item) => item._id !== this.id);
    return { stats: { removed: before - this.database.state.collections[this.name].length } };
  }
}

class FakeCollectionReference {
  constructor(database, name) {
    this.database = database;
    this.name = name;
    this.filters = {};
    this.offset = 0;
    this.maximum = Infinity;
    this.sort = null;
  }

  where(filters) {
    this.filters = filters || {};
    return this;
  }

  orderBy(field, direction) {
    this.sort = { field, direction };
    return this;
  }

  skip(value) {
    this.offset = Number(value || 0);
    return this;
  }

  limit(value) {
    this.maximum = Number(value || 0);
    return this;
  }

  doc(id) {
    return new FakeDocumentReference(this.database, this.name, id);
  }

  selected() {
    let documents = this.database.documents(this.name).filter((item) => matches(item, this.filters));
    if (this.sort) {
      const factor = this.sort.direction === "desc" ? -1 : 1;
      documents = documents.slice().sort((left, right) => {
        const a = left[this.sort.field] instanceof Date ? left[this.sort.field].getTime() : left[this.sort.field];
        const b = right[this.sort.field] instanceof Date ? right[this.sort.field].getTime() : right[this.sort.field];
        return a === b ? 0 : (a > b ? factor : -factor);
      });
    }
    return documents.slice(this.offset, this.offset + this.maximum);
  }

  async get() {
    return { data: clone(this.selected()) };
  }

  async add({ data }) {
    const id = `${this.name}-${++this.database.state.sequence}`;
    this.database.documents(this.name).push({ _id: id, ...clone(data) });
    return { _id: id };
  }

  async update({ data }) {
    const documents = this.selected();
    documents.forEach((document) => applyUpdate(document, data));
    return { stats: { updated: documents.length } };
  }

  async remove() {
    const selectedIds = new Set(this.selected().map((item) => item._id));
    const documents = this.database.documents(this.name);
    this.database.state.collections[this.name] = documents.filter((item) => !selectedIds.has(item._id));
    return { stats: { removed: selectedIds.size } };
  }

  async count() {
    return { total: this.selected().length };
  }
}

class FakeDatabase {
  constructor(state) {
    this.state = state;
    this.command = command;
  }

  documents(name) {
    if (!this.state.collections[name]) this.state.collections[name] = [];
    return this.state.collections[name];
  }

  find(name, id) {
    return this.documents(name).find((item) => item._id === id) || null;
  }

  collection(name) {
    return new FakeCollectionReference(this, name);
  }

  async createCollection(name) {
    this.documents(name);
    return { requestId: `create-${name}` };
  }

  async runTransaction(callback) {
    return callback(this);
  }
}

const makeState = (collections, openid) => ({
  collections: clone(collections),
  context: { openid },
  sequence: 100,
});

const loadCloudFunction = (name, state) => {
  const database = new FakeDatabase(state);
  const cloudMock = {
    DYNAMIC_CURRENT_ENV: "test",
    database: () => database,
    getTempFileURL: async ({ fileList }) => ({
      fileList: (fileList || []).map((fileID) => ({
        fileID,
        tempFileURL: `https://temp.example/${encodeURIComponent(fileID)}`,
      })),
    }),
    getWXContext: () => ({ OPENID: state.context.openid }),
    init: () => {},
    openapi: {
      security: {
        mediaCheckAsync: async () => ({ errCode: 0 }),
        msgSecCheck: async () => ({ errCode: 0, result: { suggest: "pass" } }),
      },
    },
  };
  const filename = path.join(__dirname, "..", "cloudfunctions", name, "index.js");
  const resolved = require.resolve(filename);
  delete require.cache[resolved];
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "wx-server-sdk") return cloudMock;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { main: require(resolved).main, database };
  } finally {
    Module._load = originalLoad;
  }
};

test("帖子详情返回递增后的浏览量并回填旧帖作者", async () => {
  const state = makeState({
    users: [{ _id: "user-2", _openid: "openid-2", aliasNo: 12, avatarUrl: "cloud://avatar-12" }],
    posts: [{ _id: "post-1", _openid: "openid-2", title: "旧帖子", category: "校园动态", viewCount: 0, createdAt: new Date() }],
  }, "visitor");
  const { main } = loadCloudFunction("posts", state);

  const first = await main({ type: "detail", id: "post-1" });
  assert.equal(first.success, true);
  assert.equal(first.data.viewCount, 1);
  assert.equal(first.data.author.userId, "user-2");
  assert.equal(first.data.author.displayName, "鹏宇用户0012");
  assert.equal(first.data.author.avatarUrl, "cloud://avatar-12");

  const refresh = await main({ type: "detail", id: "post-1", countView: false });
  assert.equal(refresh.data.viewCount, 1);
});

test("本周热议只取近7天并按浏览评论点赞综合返回前十", async () => {
  const now = Date.now();
  const recentPosts = Array.from({ length: 12 }, (_, index) => ({
    _id: `post-${index + 1}`,
    _openid: `openid-${(index % 3) + 1}`,
    title: `本周话题${index + 1}`,
    viewCount: index === 8 ? 10 : index,
    commentCount: index === 8 ? 10 : 0,
    likeCount: index === 8 ? 10 : 0,
    createdAt: new Date(now - index * 60 * 60 * 1000),
  }));
  recentPosts.push({
    _id: "post-old",
    _openid: "openid-1",
    title: "上周话题",
    viewCount: 9999,
    createdAt: new Date(now - 8 * 24 * 60 * 60 * 1000),
  });
  const state = makeState({
    users: [
      { _id: "user-1", _openid: "openid-1", aliasNo: 1 },
      { _id: "user-2", _openid: "openid-2", aliasNo: 2 },
      { _id: "user-3", _openid: "openid-3", aliasNo: 3 },
    ],
    posts: recentPosts,
  }, "openid-1");
  const { main } = loadCloudFunction("posts", state);

  const result = await main({ type: "weeklyHot" });
  assert.equal(result.success, true);
  assert.equal(result.rangeDays, 7);
  assert.equal(result.data.length, 10);
  assert.equal(result.data.some((item) => item._id === "post-old"), false);
  assert.equal(result.data[0]._id, "post-9");
});

test("帖子置顶和删除只接受云端管理员或内容作者", async () => {
  const state = makeState({
    users: [
      { _id: "user-1", _openid: "openid-1", role: "user" },
      { _id: "user-2", _openid: "openid-2", role: "user" },
      { _id: "admin-1", _openid: "openid-admin", role: "admin" },
    ],
    posts: [{ _id: "post-1", _openid: "openid-2", authorId: "user-2", title: "内容", createdAt: new Date() }],
    comments: [{ _id: "comment-1", targetType: "post", targetId: "post-1" }],
    comment_likes: [{ _id: "like-1", commentId: "comment-1" }],
  }, "openid-1");
  const { main } = loadCloudFunction("posts", state);

  assert.equal((await main({ type: "setPinned", id: "post-1", isPinned: true })).success, false);
  assert.equal((await main({ type: "delete", id: "post-1" })).success, false);

  state.context.openid = "openid-admin";
  const pinned = await main({ type: "setPinned", id: "post-1", isPinned: true });
  assert.equal(pinned.success, true);
  assert.equal(state.collections.posts[0].isPinned, true);

  assert.equal((await main({ type: "delete", id: "post-1" })).success, true);
  assert.equal(state.collections.posts.length, 0);
  assert.equal(state.collections.comments.length, 0);
  assert.equal(state.collections.comment_likes.length, 0);
});

test("管理员只能下架他人的市场商品，不能伪造其他状态", async () => {
  const state = makeState({
    users: [
      { _id: "user-1", _openid: "openid-1", role: "user" },
      { _id: "admin-1", _openid: "openid-admin", role: "admin" },
    ],
    goods: [{ _id: "goods-1", _openid: "openid-owner", authorId: "owner-1", status: "on_sale" }],
  }, "openid-1");
  const { main } = loadCloudFunction("goods", state);

  assert.equal((await main({ type: "updateStatus", id: "goods-1", status: "removed" })).success, false);
  state.context.openid = "openid-admin";
  assert.equal((await main({ type: "updateStatus", id: "goods-1", status: "sold" })).success, false);
  assert.equal((await main({ type: "updateStatus", id: "goods-1", status: "removed" })).success, true);
  assert.equal(state.collections.goods[0].status, "removed");
  assert.equal(state.collections.goods[0].moderatedBy, "admin-1");
});

test("管理员删除主评论时级联回复并重算帖子评论数", async () => {
  const state = makeState({
    users: [
      { _id: "user-1", _openid: "openid-1", role: "user" },
      { _id: "admin-1", _openid: "openid-admin", role: "admin" },
    ],
    posts: [{ _id: "post-1", commentCount: 2 }],
    comments: [
      { _id: "comment-1", _openid: "openid-owner", userId: "owner-1", targetType: "post", targetId: "post-1", parentId: "" },
      { _id: "reply-1", _openid: "openid-other", userId: "other-1", targetType: "post", targetId: "post-1", parentId: "comment-1" },
    ],
    comment_likes: [{ _id: "like-1", commentId: "reply-1" }],
  }, "openid-1");
  const { main } = loadCloudFunction("comments", state);

  assert.equal((await main({ type: "delete", commentId: "comment-1" })).success, false);
  state.context.openid = "openid-admin";
  const removed = await main({ type: "delete", commentId: "comment-1" });
  assert.equal(removed.success, true);
  assert.deepEqual(new Set(removed.removedIds), new Set(["comment-1", "reply-1"]));
  assert.equal(state.collections.comments.length, 0);
  assert.equal(state.collections.comment_likes.length, 0);
  assert.equal(state.collections.posts[0].commentCount, 0);
});

test("私信云函数对新旧客户端统一返回功能已关闭", async () => {
  const { main } = loadCloudFunction("chat", makeState({}, "openid-1"));
  const operations = ["start", "listConversations", "detail", "sendText", "markRead"];

  for (const type of operations) {
    const result = await main({ type });
    assert.deepEqual(result, {
      success: false,
      errMsg: "私信功能已关闭",
      errorCode: "FEATURE_DISABLED",
    });
  }
});

test("帖子详情在窄屏保持管理区可读并明确自有帖子状态", () => {
  const pageRoot = path.join(__dirname, "..", "miniprogram", "pages", "post-detail");
  const wxml = fs.readFileSync(path.join(pageRoot, "index.wxml"), "utf8");
  const wxss = fs.readFileSync(path.join(pageRoot, "index.wxss"), "utf8");

  assert.doesNotMatch(wxml, /contactAuthor|chat-author-btn|私聊作者/);
  assert.match(wxml, /这是你的帖子/);
  assert.match(wxml, /class="moderation-actions"/);
  assert.match(wxss, /\.moderation-panel\s*\{[^}]*flex-direction:\s*column;/s);
  assert.match(wxss, /\.moderation-actions\s*\{[^}]*width:\s*100%;/s);
  assert.match(wxss, /\.moderation-btn\s*\{[^}]*flex:\s*1;/s);
});

test("小程序页面不再暴露一对一私信入口或调用聊天云函数", () => {
  const miniProgramRoot = path.join(__dirname, "..", "miniprogram");
  const appJson = JSON.parse(fs.readFileSync(path.join(miniProgramRoot, "app.json"), "utf8"));
  const sourceFiles = [
    path.join(miniProgramRoot, "pages", "goods-detail", "index.js"),
    path.join(miniProgramRoot, "pages", "goods-detail", "index.wxml"),
    path.join(miniProgramRoot, "pages", "post-detail", "index.js"),
    path.join(miniProgramRoot, "pages", "post-detail", "index.wxml"),
    path.join(miniProgramRoot, "pages", "profile", "index.js"),
    path.join(miniProgramRoot, "pages", "profile", "index.wxml"),
  ].map((file) => fs.readFileSync(file, "utf8")).join("\n");

  assert.ok(!appJson.pages.includes("pages/messages/index"));
  assert.ok(!appJson.pages.includes("pages/chat/index"));
  assert.doesNotMatch(sourceFiles, /callCloud\(["']chat["']/);
  assert.doesNotMatch(sourceFiles, /pages\/(?:chat|messages)\/index/);
  assert.doesNotMatch(sourceFiles, /私聊|我的消息|联系卖家/);
});

test("帖子评论发送按钮固定为参考图的小比例且输入框占据剩余空间", () => {
  const wxss = fs.readFileSync(path.join(__dirname, "..", "miniprogram", "pages", "post-detail", "index.wxss"), "utf8");

  assert.match(wxss, /\.comment-input\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;[^}]*width:\s*0;/s);
  assert.match(wxss, /\.comment-btn\s*\{[^}]*flex:\s*0 0 126rpx;[^}]*max-width:\s*126rpx;[^}]*min-width:\s*126rpx;/s);
});

test("校园闲置发布必须携带图片且列表和详情返回可显示地址", async () => {
  const cloudFile = "cloud://test-env/goods/item.jpg";
  const expectedUrl = `https://temp.example/${encodeURIComponent(cloudFile)}`;
  const state = makeState({
    users: [{ _id: "user-1", _openid: "openid-1", aliasNo: 1 }],
    goods: [{
      _id: "goods-1",
      _openid: "openid-1",
      authorId: "user-1",
      title: "带图闲置",
      price: 21,
      desc: "商品描述",
      category: "教材",
      images: [cloudFile],
      status: "on_sale",
      viewCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    }],
  }, "openid-1");
  const { main } = loadCloudFunction("goods", state);

  const rejected = await main({
    type: "add",
    title: "没有图片",
    price: 10,
    desc: "不应被发布",
    category: "其他",
    images: [],
  });
  assert.equal(rejected.success, false);
  assert.equal(rejected.errMsg, "请至少上传1张商品图片");

  const list = await main({ type: "list", page: 1, pageSize: 10 });
  assert.equal(list.success, true);
  assert.equal(list.data[0].images[0], expectedUrl);

  const detail = await main({ type: "detail", id: "goods-1" });
  assert.equal(detail.success, true);
  assert.equal(detail.data.images[0], expectedUrl);
});

test("校园闲置发布页在上传前提示图片必填", () => {
  const root = path.join(__dirname, "..", "miniprogram", "pages", "publish-goods");
  const homeJs = fs.readFileSync(path.join(__dirname, "..", "miniprogram", "pages", "home", "index.js"), "utf8");
  const js = fs.readFileSync(path.join(root, "index.js"), "utf8");
  const wxml = fs.readFileSync(path.join(root, "index.wxml"), "utf8");

  assert.match(js, /images\.length === 0\) return "请至少上传1张商品图片"/);
  assert.match(js, /if \(!res \|\| !res\.fileID\) throw new Error\("商品图片上传失败，请重试"\)/);
  assert.match(wxml, /class="image-required">必填 · 至少1张/);
  assert.match(homeJs, /onShow\(\)\s*\{\s*if \(!this\.data\.loading\) \{\s*this\.fetchGoods\(true\);/s);
});

test("普通代售点管理员只能管理绑定代售点的库存与上下架", async () => {
  const state = makeState({
    users: [{
      _id: "manager-1",
      _openid: "openid-manager",
      role: "outlet_admin",
      schoolId: "default-school",
      managedOutletId: "outlet-1",
    }],
    outlets: [
      { _id: "outlet-1", schoolId: "default-school", buildingNo: 1, buildingName: "1号楼", name: "一号代售点", isActive: true },
      { _id: "outlet-2", schoolId: "default-school", buildingNo: 2, buildingName: "2号楼", name: "二号代售点", isActive: true },
    ],
    store_products: [
      { _id: "product-1", outletId: "outlet-1", title: "本点商品", category: "膨化食品类", priceFen: 500, stock: 1, status: "on_sale" },
      { _id: "product-2", outletId: "outlet-2", title: "他点商品", category: "膨化食品类", priceFen: 600, stock: 2, status: "on_sale" },
    ],
  }, "openid-manager");
  const { main } = loadCloudFunction("store", state);

  const outlets = await main({ type: "adminListOutlets" });
  assert.equal(outlets.success, true);
  assert.deepEqual(outlets.data.map((item) => item._id), ["outlet-1"]);
  assert.equal(outlets.scope.isSuperAdmin, false);

  assert.equal((await main({ type: "adminListProducts", outletId: "outlet-2" })).success, false);
  assert.equal((await main({ type: "updateProductStock", id: "product-2", stock: 99 })).success, false);
  assert.equal((await main({ type: "updateProductStatus", id: "product-2", status: "off_shelf" })).success, false);
  assert.equal(state.collections.store_products[1].stock, 2);
  assert.equal(state.collections.store_products[1].status, "on_sale");

  const stock = await main({ type: "updateProductStock", id: "product-1", stock: 9 });
  assert.equal(stock.success, true);
  assert.equal(state.collections.store_products[0].stock, 9);

  const status = await main({ type: "updateProductStatus", id: "product-1", status: "off_shelf" });
  assert.equal(status.success, true);
  assert.equal(state.collections.store_products[0].status, "off_shelf");

  assert.equal((await main({ type: "saveOutlet", name: "越权新增", buildingNo: 3 })).success, false);
  assert.equal((await main({
    type: "saveProduct",
    outletId: "outlet-1",
    title: "越权新增商品",
    priceFen: 100,
    stock: 1,
  })).success, false);
});

test("普通代售点管理员初始化时忽略伪造楼栋且不影响其他代售点", async () => {
  const state = makeState({
    users: [{
      _id: "manager-1",
      _openid: "openid-manager",
      role: "outlet_admin",
      schoolId: "default-school",
      managedOutletId: "outlet-1",
    }],
    outlets: [
      { _id: "outlet-1", schoolId: "default-school", buildingNo: 1, buildingName: "1号楼", name: "一号代售点", isActive: true },
      { _id: "outlet-2", schoolId: "default-school", buildingNo: 2, buildingName: "2号楼", name: "二号代售点", isActive: true },
    ],
    store_products: [],
  }, "openid-manager");
  const { main } = loadCloudFunction("store", state);

  const result = await main({ type: "bootstrapCatalog", buildingNo: 16, outletId: "outlet-2" });
  assert.equal(result.success, true);
  assert.equal(result.buildingNo, 1);
  assert.equal(result.outletId, "outlet-1");
  assert.ok(result.createdProducts > 0);
  assert.ok(state.collections.store_products.every((item) => item.outletId === "outlet-1"));
});

test("标准商品为缺少云存储图片的商品回退到内置实拍图", async () => {
  const imageRoot = path.join(__dirname, "..", "miniprogram", "images", "store");
  const images = {
    "可比克薯片（番茄/青瓜/原滋味）": "copico-potato-chips.jpg",
    "稻口香薄脆饼干烤馍": "rice-fragrant-crisp-biscuits.jpg",
    "美思缘辣条": "meisiyuan-spicy-strips.jpg",
    "劲仔深海小鱼": "jinzi-deep-sea-fish.jpg",
    "卫龙魔芋爽": "weilong-konjac-snack.jpg",
    "手撕烤脖": "hand-torn-roast-neck.jpg",
    "泡翅": "pickled-chicken-wings.jpg",
    "泡椒鸡爪": "pickled-chicken-feet.jpg",
    "多味鸡爪": "assorted-chicken-feet.jpg",
    "鸭翅根": "duck-wing-root.jpg",
    "圣茗香茶叶蛋": "tea-egg.jpg",
    "八爪烧": "octopus-snack.jpg",
    "虾仔面": "shrimp-noodles.jpg",
    "牛羊配": "beef-mutton-snack.jpg",
    "咪咪虾条": "mimi-shrimp-sticks.jpg",
  };
  Object.values(images).forEach((fileName) => assert.equal(fs.existsSync(path.join(imageRoot, fileName)), true));

  const state = makeState({
    store_products: [{
      _id: "product-002",
      outletId: "outlet-1",
      sku: "002",
      title: "虾仔面",
      category: "速食泡面类",
      priceFen: 200,
      stock: 3,
      image: "",
      status: "on_sale",
    }],
  });
  const { main } = loadCloudFunction("store", state);
  const result = await main({ type: "listProducts", outletId: "outlet-1" });

  assert.equal(result.success, true);
  assert.equal(result.data[0].image, "/images/store/shrimp-noodles.jpg");
  const detail = await main({ type: "detailProduct", id: "product-002" });
  assert.equal(detail.success, true);
  assert.equal(detail.data.image, "/images/store/shrimp-noodles.jpg");

  const catalog = fs.readFileSync(path.join(__dirname, "..", "cloudfunctions", "store", "catalog.js"), "utf8");
  Object.entries(images).forEach(([title, fileName]) => {
    assert.match(catalog, new RegExp(`"${title}": "\\/images\\/store\\/${fileName}"`));
  });
});

test("代售点总管理员保留全部代售点和商品管理权限", async () => {
  const state = makeState({
    users: [{ _id: "admin-1", _openid: "openid-admin", role: "admin", schoolId: "default-school" }],
    outlets: [{ _id: "outlet-1", schoolId: "default-school", buildingNo: 1, buildingName: "1号楼", name: "一号代售点", isActive: true }],
    store_products: [{ _id: "product-1", outletId: "outlet-1", title: "商品", category: "膨化食品类", priceFen: 500, stock: 1, status: "on_sale" }],
  }, "openid-admin");
  const { main } = loadCloudFunction("store", state);

  const createdOutlet = await main({
    type: "saveOutlet",
    buildingNo: 2,
    name: "二号代售点",
    deliveryFeeFen: 0,
    minimumOrderFen: 0,
    sort: 2,
  });
  assert.equal(createdOutlet.success, true);

  const createdProduct = await main({
    type: "saveProduct",
    outletId: "outlet-1",
    title: "新增商品",
    category: "膨化食品类",
    priceFen: 700,
    stock: 3,
  });
  assert.equal(createdProduct.success, true);
  assert.equal((await main({ type: "updateProductStock", id: "product-1", stock: 8 })).success, true);
  assert.equal((await main({ type: "updateProductStatus", id: "product-1", status: "off_shelf" })).success, true);
});

test("商品库支持关键字商品的默认价与既有默认图片", async () => {
  const state = makeState({
    users: [{ _id: "admin-1", _openid: "openid-admin", role: "admin", schoolId: "default-school" }],
    outlets: [{ _id: "outlet-1", schoolId: "default-school", buildingNo: 1, buildingName: "1号楼", name: "一号代售点" }],
    store_products: [{
      _id: "building_01_product_009",
      outletId: "outlet-1",
      sku: "009",
      title: "南京板鸭",
      category: "膨化食品类",
      priceFen: 100,
      stock: 1,
      image: "cloud://catalog/nanjing-duck.jpg",
      status: "on_sale",
    }],
  }, "openid-admin");
  const { main } = loadCloudFunction("store", state);

  const result = await main({ type: "adminListCatalog" });
  assert.equal(result.success, true);
  const matches = result.data.filter((item) => item.title.includes("南京"));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].title, "南京板鸭");
  assert.equal(matches[0].category, "膨化食品类");
  assert.equal(matches[0].priceFen, 100);
  assert.equal(matches[0].image, "cloud://catalog/nanjing-duck.jpg");
  assert.equal(matches[0].hasDefaultImage, true);
});

test("商品库跨越100条库存记录后仍能找到已配置的默认图片", async () => {
  const fillerProducts = Array.from({ length: 100 }, (_, index) => ({
    _id: `filler-${index}`,
    outletId: `outlet-${index % 16}`,
    sku: "001",
    title: "杨掌柜粉面菜蛋",
    image: "cloud://catalog/noodles.jpg",
    status: "on_sale",
  }));
  const state = makeState({
    users: [{ _id: "admin-1", _openid: "openid-admin", role: "admin", schoolId: "default-school" }],
    store_products: [
      ...fillerProducts,
      {
        _id: "late-product-004",
        outletId: "outlet-1",
        sku: "004",
        title: "海螺丝",
        image: "cloud://catalog/sea-snack.jpg",
        status: "on_sale",
      },
    ],
  }, "openid-admin");
  const { main } = loadCloudFunction("store", state);

  const result = await main({ type: "adminListCatalog" });
  assert.equal(result.success, true);
  const product = result.data.find((item) => item.sku === "004");
  assert.equal(product.image, "cloud://catalog/sea-snack.jpg");
  assert.equal(product.hasDefaultImage, true);
});

test("已配置云图片优先于内置图片且补库存时不会被本地路径覆盖", async () => {
  const cloudImage = "cloud://catalog/shrimp-noodles.jpg";
  const state = makeState({
    users: [{ _id: "admin-1", _openid: "openid-admin", role: "admin", schoolId: "default-school" }],
    outlets: [
      { _id: "outlet-1", schoolId: "default-school", buildingNo: 1, buildingName: "1号楼", name: "一号代售点" },
      { _id: "outlet-5", schoolId: "default-school", buildingNo: 5, buildingName: "5号楼", name: "五号代售点" },
    ],
    store_products: [
      {
        _id: "building_01_product_002",
        outletId: "outlet-1",
        sku: "002",
        title: "虾仔面",
        category: "速食泡面类",
        priceFen: 200,
        stock: 1,
        image: cloudImage,
        status: "on_sale",
      },
      {
        _id: "building_05_product_002",
        outletId: "outlet-5",
        sku: "002",
        title: "虾仔面",
        category: "速食泡面类",
        priceFen: 200,
        stock: 1,
        image: "/images/store/shrimp-noodles.jpg",
        status: "on_sale",
      },
    ],
  }, "openid-admin");
  const { main } = loadCloudFunction("store", state);

  const catalogResult = await main({ type: "adminListCatalog" });
  const catalogItem = catalogResult.data.find((item) => item.sku === "002");
  assert.equal(catalogItem.image, cloudImage);

  const saveResult = await main({
    type: "saveCatalogProductBatch",
    outletIds: ["outlet-5"],
    sku: "002",
    stock: 10,
    image: "/images/store/shrimp-noodles.jpg",
  });
  assert.equal(saveResult.success, true);

  const saved = state.collections.store_products.find((item) => item._id === "building_05_product_002");
  assert.equal(saved.stock, 10);
  assert.equal(saved.image, cloudImage);

  const storefrontResult = await main({ type: "listProducts", outletId: "outlet-5" });
  assert.equal(storefrontResult.data[0].image, cloudImage);
});

test("总代售点管理员可按SKU把标准商品批量上架到多个代售点", async () => {
  const state = makeState({
    users: [{ _id: "admin-1", _openid: "openid-admin", role: "admin", schoolId: "default-school" }],
    outlets: [
      { _id: "outlet-1", schoolId: "default-school", buildingNo: 1, buildingName: "1号楼", name: "一号代售点" },
      { _id: "outlet-2", schoolId: "default-school", buildingNo: 2, buildingName: "2号楼", name: "二号代售点" },
    ],
    store_products: [],
  }, "openid-admin");
  const { main } = loadCloudFunction("store", state);

  const result = await main({
    type: "saveCatalogProductBatch",
    outletIds: ["outlet-1", "outlet-2"],
    sku: "009",
    title: "伪造名称",
    category: "香肠类",
    stock: 3,
  });
  assert.equal(result.success, true);
  assert.equal(result.createdCount, 2);
  const products = state.collections.store_products.filter((item) => item.sku === "009");
  assert.equal(products.length, 2);
  assert.ok(products.every((item) => item.title === "南京板鸭"));
  assert.ok(products.every((item) => item.category === "膨化食品类"));
  assert.ok(products.every((item) => item.priceFen === 100));
  assert.deepEqual(products.map((item) => item.outletId).sort(), ["outlet-1", "outlet-2"]);
});

test("总代售点管理员可创建同组自定义商品并指定适用代售点", async () => {
  const state = makeState({
    users: [{ _id: "admin-1", _openid: "openid-admin", role: "admin", schoolId: "default-school" }],
    outlets: [
      { _id: "outlet-1", schoolId: "default-school", buildingNo: 1, name: "一号代售点" },
      { _id: "outlet-2", schoolId: "default-school", buildingNo: 2, name: "二号代售点" },
    ],
    store_products: [],
  }, "openid-admin");
  const { main } = loadCloudFunction("store", state);

  const result = await main({
    type: "saveCustomProductBatch",
    outletIds: ["outlet-1", "outlet-2"],
    title: "校园限定饮品",
    category: "速食泡面类",
    priceFen: 650,
    stock: 8,
    image: "cloud://custom/drink.jpg",
  });
  assert.equal(result.success, true);
  assert.equal(result.createdCount, 2);
  assert.ok(result.productGroupId);
  assert.ok(state.collections.store_products.every((item) => item.sourceType === "custom"));
  assert.ok(state.collections.store_products.every((item) => item.productGroupId === result.productGroupId));
  assert.ok(state.collections.store_products.every((item) => item.image === "cloud://custom/drink.jpg"));
});

test("总代售点管理员可按SKU统一更换当前学校所有代售点的商品图片", async () => {
  const state = makeState({
    users: [{ _id: "admin-1", _openid: "openid-admin", role: "admin", schoolId: "default-school" }],
    outlets: [
      { _id: "outlet-1", schoolId: "default-school", buildingNo: 1, name: "一号代售点" },
      { _id: "outlet-2", schoolId: "default-school", buildingNo: 2, name: "二号代售点" },
      { _id: "outlet-other", schoolId: "other-school", buildingNo: 1, name: "其他学校代售点" },
    ],
    store_products: [
      { _id: "product-1", outletId: "outlet-1", sku: "015", sourceType: "catalog", title: "泡椒鸡爪", priceFen: 200, stock: 2, image: "cloud://old/1.jpg", status: "on_sale" },
      { _id: "product-2", outletId: "outlet-2", sku: "015", sourceType: "catalog", title: "泡椒鸡爪", priceFen: 250, stock: 8, image: "cloud://old/2.jpg", status: "off_shelf" },
      { _id: "product-3", outletId: "outlet-other", sku: "015", sourceType: "catalog", title: "泡椒鸡爪", priceFen: 300, stock: 5, image: "cloud://old/3.jpg", status: "on_sale" },
      { _id: "product-4", outletId: "outlet-1", sku: "016", sourceType: "catalog", title: "其他商品", priceFen: 100, stock: 1, image: "cloud://old/4.jpg", status: "on_sale" },
    ],
  }, "openid-admin");
  const { main } = loadCloudFunction("store", state);

  const preview = await main({ type: "previewProductGroupImageUpdate", id: "product-1" });
  assert.equal(preview.success, true);
  assert.equal(preview.affectedCount, 2);
  assert.equal(preview.groupType, "catalog");
  assert.equal(preview.groupKey, "015");

  const result = await main({
    type: "updateProductGroupImage",
    id: "product-1",
    image: "cloud://store-products/new.jpg",
    expectedCount: preview.affectedCount,
  });
  assert.equal(result.success, true);
  assert.equal(result.updatedCount, 2);
  assert.equal(state.collections.store_products[0].image, "cloud://store-products/new.jpg");
  assert.equal(state.collections.store_products[1].image, "cloud://store-products/new.jpg");
  assert.equal(state.collections.store_products[2].image, "cloud://old/3.jpg");
  assert.equal(state.collections.store_products[3].image, "cloud://old/4.jpg");
  assert.equal(state.collections.store_products[0].stock, 2);
  assert.equal(state.collections.store_products[1].priceFen, 250);
  assert.equal(state.collections.store_products[1].status, "off_shelf");
});

test("自定义商品按productGroupId统一图片且拒绝越权或范围变化", async () => {
  const collections = {
    outlets: [
      { _id: "outlet-1", schoolId: "default-school", buildingNo: 1, name: "一号代售点" },
      { _id: "outlet-2", schoolId: "default-school", buildingNo: 2, name: "二号代售点" },
    ],
    store_products: [
      { _id: "custom-1", outletId: "outlet-1", sku: "", sourceType: "custom", productGroupId: "group-a", title: "校园饮品", image: "cloud://old/1.jpg" },
      { _id: "custom-2", outletId: "outlet-2", sku: "", sourceType: "custom", productGroupId: "group-a", title: "校园饮品", image: "cloud://old/2.jpg" },
      { _id: "custom-3", outletId: "outlet-2", sku: "", sourceType: "custom", productGroupId: "group-b", title: "校园饮品", image: "cloud://old/3.jpg" },
    ],
  };
  const adminState = makeState({
    ...collections,
    users: [{ _id: "admin-1", _openid: "openid-admin", role: "admin", schoolId: "default-school" }],
  }, "openid-admin");
  const { main: adminMain } = loadCloudFunction("store", adminState);

  const preview = await adminMain({ type: "previewProductGroupImageUpdate", id: "custom-1" });
  assert.equal(preview.success, true);
  assert.equal(preview.groupType, "custom");
  assert.equal(preview.affectedCount, 2);
  assert.equal((await adminMain({
    type: "updateProductGroupImage",
    id: "custom-1",
    image: "cloud://store-products/new.jpg",
    expectedCount: 1,
  })).success, false);
  assert.equal((await adminMain({
    type: "updateProductGroupImage",
    id: "custom-1",
    image: "/images/store/local.jpg",
    expectedCount: 2,
  })).success, false);
  assert.ok(adminState.collections.store_products.every((item) => item.image.startsWith("cloud://old/")));

  const outletAdminState = makeState({
    ...collections,
    users: [{ _id: "manager-1", _openid: "openid-manager", role: "outlet_admin", schoolId: "default-school", managedOutletId: "outlet-1" }],
  }, "openid-manager");
  const { main: outletAdminMain } = loadCloudFunction("store", outletAdminState);
  assert.equal((await outletAdminMain({ type: "previewProductGroupImageUpdate", id: "custom-1" })).success, false);
  assert.equal((await outletAdminMain({ type: "updateProductGroupImage", id: "custom-1", image: "cloud://new.jpg", expectedCount: 2 })).success, false);
});

test("普通代售点管理员不能查询商品库或批量新增商品", async () => {
  const state = makeState({
    users: [{ _id: "manager-1", _openid: "openid-manager", role: "outlet_admin", schoolId: "default-school", managedOutletId: "outlet-1" }],
    outlets: [{ _id: "outlet-1", schoolId: "default-school", buildingNo: 1, name: "一号代售点" }],
    store_products: [],
  }, "openid-manager");
  const { main } = loadCloudFunction("store", state);

  assert.equal((await main({ type: "adminListCatalog" })).success, false);
  assert.equal((await main({ type: "saveCatalogProductBatch", outletIds: ["outlet-1"], sku: "009", stock: 1 })).success, false);
  assert.equal((await main({ type: "saveCustomProductBatch", outletIds: ["outlet-1"], title: "越权商品", category: "蛋类", priceFen: 100, stock: 1 })).success, false);
  assert.equal(state.collections.store_products.length, 0);
});

test("商品管理表单先选分类再搜索名称并支持多代售点", () => {
  const root = path.join(__dirname, "..", "miniprogram", "pages", "admin-store");
  const js = fs.readFileSync(path.join(root, "index.js"), "utf8");
  const wxml = fs.readFileSync(path.join(root, "index.wxml"), "utf8");
  const categoryIndex = wxml.indexOf("商品分类");
  const nameIndex = wxml.indexOf("商品名称", categoryIndex);

  assert.ok(categoryIndex >= 0 && nameIndex > categoryIndex);
  assert.match(wxml, /输入“南京”查找南京板鸭/);
  assert.match(wxml, /class="catalog-results" scroll-y/);
  assert.match(wxml, /适用代售点/);
  assert.match(wxml, /商品图片（选填）/);
  assert.match(js, /keyword\s*\?\s*this\.data\.catalogItems/);
  assert.match(js, /item\.title\.toLowerCase\(\)\.includes\(keyword\)/);
  assert.match(js, /saveCatalogProductBatch/);
  assert.match(js, /saveCustomProductBatch/);
  assert.match(js, /previewProductGroupImageUpdate/);
  assert.match(js, /updateProductGroupImage/);
  assert.match(wxml, /统一更换全部代售点图片/);
  assert.match(wxml, /只同步商品图片/);
});

test("代售点管理页面按角色隐藏超出权限的操作", () => {
  const adminRoot = path.join(__dirname, "..", "miniprogram", "pages", "admin-store");
  const profileRoot = path.join(__dirname, "..", "miniprogram", "pages", "profile");
  const storeRoot = path.join(__dirname, "..", "miniprogram", "pages", "store");
  const adminWxml = fs.readFileSync(path.join(adminRoot, "index.wxml"), "utf8");
  const profileWxml = fs.readFileSync(path.join(profileRoot, "index.wxml"), "utf8");
  const storeWxml = fs.readFileSync(path.join(storeRoot, "index.wxml"), "utf8");

  assert.match(adminWxml, /wx:if="\{\{isSuperAdmin\}\}" class="admin-tabs"/);
  assert.match(adminWxml, /wx:if="\{\{isSuperAdmin && mode === 'outlets'\}\}"/);
  assert.match(adminWxml, /只能调整本代售点商品库存和上下架状态/);
  assert.match(profileWxml, /wx:if="\{\{isStoreManager\}\}" class="management-panel"/);
  assert.match(profileWxml, /wx:if="\{\{isSuperAdmin\}\}" class="management-item" bindtap="goAdminOrders"/);
  assert.match(storeWxml, /wx:if="\{\{canManageStore\}\}" class="admin-fab"/);
});

test("代售点首页按截图调整搜索、加号和底部操作栏比例", () => {
  const storeRoot = path.join(__dirname, "..", "miniprogram", "pages", "store");
  const wxml = fs.readFileSync(path.join(storeRoot, "index.wxml"), "utf8");
  const wxss = fs.readFileSync(path.join(storeRoot, "index.wxss"), "utf8");

  assert.match(wxml, /class="search-input"/);
  assert.match(wxml, /class="search-btn"/);
  assert.match(wxml, /class="add-btn/);
  assert.match(wxml, /class="store-fab-row"[\s\S]*src="\/images\/icons\/cart\.svg"[\s\S]*class="store-fab-divider"[\s\S]*src="\/images\/icons\/manage\.svg"/);
  assert.match(wxss, /\.search-input\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-width:\s*0;[^}]*width:\s*0;/s);
  assert.match(wxss, /\.search-btn\s*\{[^}]*flex:\s*0 0 30%;[^}]*max-width:\s*30%;[^}]*width:\s*30%;/s);
  assert.match(wxss, /\.add-btn\s*\{[^}]*flex:\s*0 0 54rpx;[^}]*font-size:\s*28rpx;[^}]*max-width:\s*54rpx;[^}]*min-width:\s*54rpx;/s);
  assert.match(wxss, /\.store-fab-row\s*\{[^}]*background:\s*#fff;[^}]*border-radius:\s*22rpx;[^}]*bottom:\s*calc\(16rpx \+ env\(safe-area-inset-bottom\)\);[^}]*left:\s*16rpx;[^}]*right:\s*16rpx;/s);
  assert.match(wxss, /\.admin-fab,\s*\n\.cart-fab\s*\{[^}]*background:\s*transparent;[^}]*flex:\s*1 1 0;[^}]*max-width:\s*none;[^}]*min-width:\s*0;[^}]*width:\s*0;/s);
  assert.match(wxss, /\.store-fab-icon\s*\{[^}]*height:\s*42rpx;[^}]*width:\s*42rpx;/s);
  assert.match(wxss, /\.store-fab-divider\s*\{[^}]*height:\s*52rpx;[^}]*width:\s*1rpx;/s);
  assert.match(wxss, /\.product-scroll\s*\{[^}]*padding:\s*0 20rpx calc\(150rpx \+ env\(safe-area-inset-bottom\)\);/s);
});

test("市场六个快捷分类使用对应的自定义按钮贴图", () => {
  const homeRoot = path.join(__dirname, "..", "miniprogram", "pages", "home");
  const imageRoot = path.join(__dirname, "..", "miniprogram", "images", "market");
  const js = fs.readFileSync(path.join(homeRoot, "index.js"), "utf8");
  const wxml = fs.readFileSync(path.join(homeRoot, "index.wxml"), "utf8");
  const iconFiles = [
    "category-digital.png",
    "category-textbook.png",
    "category-life.png",
    "category-clothing.png",
    "category-sports.png",
    "category-wanted.png",
  ];

  iconFiles.forEach((fileName) => {
    assert.equal(fs.existsSync(path.join(imageRoot, fileName)), true);
    assert.match(js, new RegExp(`/images/market/${fileName.replace(".", "\\.")}`));
  });
  assert.match(wxml, /class="quick-icon" mode="aspectFit" src="\{\{item\.icon\}\}"/);
  assert.doesNotMatch(wxml, /item\.mark|item\.tone/);
});

test("校园圈第五个快捷入口可全屏预览本地校园地图", () => {
  const forumRoot = path.join(__dirname, "..", "miniprogram", "pages", "forum");
  const miniProgramRoot = path.join(__dirname, "..", "miniprogram");
  const imageRoot = path.join(miniProgramRoot, "images", "forum");
  const mapRoot = path.join(miniProgramRoot, "campus-map");
  const js = fs.readFileSync(path.join(forumRoot, "index.js"), "utf8");
  const wxml = fs.readFileSync(path.join(forumRoot, "index.wxml"), "utf8");
  const wxss = fs.readFileSync(path.join(forumRoot, "index.wxss"), "utf8");
  const mapPageJs = fs.readFileSync(path.join(mapRoot, "pages", "index.js"), "utf8");
  const appJson = JSON.parse(fs.readFileSync(path.join(miniProgramRoot, "app.json"), "utf8"));
  const mapPath = path.join(mapRoot, "images", "campus-map.jpg");
  const iconPath = path.join(imageRoot, "quick-campus-map.png");

  assert.equal(fs.existsSync(mapPath), true);
  assert.equal(fs.existsSync(iconPath), true);
  assert.ok(fs.statSync(mapPath).size > 100000);
  assert.ok(fs.statSync(mapPath).size < 1000000);
  assert.match(js, /action:\s*"campusMap",\s*title:\s*"校园地图"/);
  assert.match(js, /wx\.navigateTo\(\{\s*url:\s*"\/campus-map\/pages\/index"\s*\}\)/);
  assert.match(mapPageJs, /wx\.previewImage\(\{\s*current:\s*MAP_URL,\s*urls:\s*\[MAP_URL\]\s*\}\)/);
  assert.match(wxml, /data-action="\{\{item\.action\}\}" bindtap="tapQuickChannel"/);
  assert.match(wxss, /grid-template-columns:\s*repeat\(5,\s*1fr\)/);
  assert.ok(appJson.subpackages.some((item) => item.root === "campus-map" && item.pages.includes("pages/index")));
});

test("校园圈五个快捷按钮使用对应的3D贴图", () => {
  const forumRoot = path.join(__dirname, "..", "miniprogram", "pages", "forum");
  const imageRoot = path.join(__dirname, "..", "miniprogram", "images", "forum");
  const js = fs.readFileSync(path.join(forumRoot, "index.js"), "utf8");
  const wxml = fs.readFileSync(path.join(forumRoot, "index.wxml"), "utf8");
  const mappings = [
    ["求助", "quick-help.png"],
    ["找搭子", "quick-partner.png"],
    ["失物", "quick-lost.png"],
    ["新生", "quick-freshman.png"],
    ["校园地图", "quick-campus-map.png"],
  ];

  mappings.forEach(([title, fileName]) => {
    const filePath = path.join(imageRoot, fileName);
    assert.equal(fs.existsSync(filePath), true);
    assert.ok(fs.statSync(filePath).size < 30000);
    assert.match(js, new RegExp(`title: "${title}"[^\\n]+/images/forum/${fileName.replace(".", "\\.")}`));
  });
  assert.match(wxml, /class="quick-icon"><image mode="aspectFit" src="\{\{item\.icon\}\}"/);
  assert.doesNotMatch(wxml, /item\.tone/);
});

test("校园圈头图删除宣传文字并使用校园地图图片层", () => {
  const forumRoot = path.join(__dirname, "..", "miniprogram", "pages", "forum");
  const imageRoot = path.join(__dirname, "..", "miniprogram", "images", "forum");
  const wxml = fs.readFileSync(path.join(forumRoot, "index.wxml"), "utf8");
  const wxss = fs.readFileSync(path.join(forumRoot, "index.wxss"), "utf8");
  const heroMap = path.join(imageRoot, "campus-map-hero.jpg");

  assert.equal(fs.existsSync(heroMap), true);
  assert.ok(fs.statSync(heroMap).size < 150000);
  assert.doesNotMatch(wxml, /circle-brand|campus-tag|hero-title|hero-subtitle|hero-ring/);
  assert.doesNotMatch(wxml, /鹏宇校园圈|校园生活情报站|今天，校园里有什么新鲜事/);
  assert.match(wxml, /<image class="hero-map-image" mode="aspectFill" src="\/images\/forum\/campus-map-hero\.jpg"><\/image>/);
  assert.match(wxml, /<view class="hero-map-shade"><\/view>/);
  assert.doesNotMatch(wxss, /background-image:[^;]*campus-map-hero/);
  assert.match(wxss, /\.hero-map-image,\s*\.hero-map-shade\s*\{[^}]*position:\s*absolute;/s);
  assert.match(wxss, /\.hero-map-shade\s*\{[^}]*linear-gradient/s);
});

test("校园圈显示本周热议轮播并可打开前十榜单", () => {
  const forumRoot = path.join(__dirname, "..", "miniprogram", "pages", "forum");
  const wxml = fs.readFileSync(path.join(forumRoot, "index.wxml"), "utf8");
  const wxss = fs.readFileSync(path.join(forumRoot, "index.wxss"), "utf8");
  const js = fs.readFileSync(path.join(forumRoot, "index.js"), "utf8");
  const cloud = fs.readFileSync(path.join(__dirname, "..", "cloudfunctions", "posts", "index.js"), "utf8");

  assert.match(wxml, /本周热议/);
  assert.doesNotMatch(wxml, /今日热议/);
  assert.match(wxml, /<swiper class="weekly-hot-swiper"[^>]*vertical="true"[^>]*autoplay=/);
  assert.match(wxml, /bindtap="goWeeklyHotPost"/);
  assert.match(wxml, /class="weekly-ranking-link" catchtap="openWeeklyRanking"/);
  assert.match(wxml, /class="ranking-sheet"/);
  assert.match(wxml, /wx:for="\{\{weeklyHotPosts\}\}"/);
  assert.match(wxss, /\.weekly-hot-swiper\s*\{[^}]*height:\s*72rpx;/s);
  assert.match(wxss, /\.weekly-ranking-link\s*\{[^}]*flex:\s*0 0 74rpx;/s);
  assert.match(js, /async fetchWeeklyHotPosts\(\)/);
  assert.match(js, /type: "weeklyHot"/);
  assert.match(js, /openWeeklyRanking\(\)/);
  assert.match(cloud, /case "weeklyHot"/);
  assert.match(cloud, /Number\(item\.commentCount \|\| 0\) \* 5/);
});

test("底部导航四个入口使用对应的自定义贴图", () => {
  const miniProgramRoot = path.join(__dirname, "..", "miniprogram");
  const appJson = JSON.parse(fs.readFileSync(path.join(miniProgramRoot, "app.json"), "utf8"));
  const mappings = [
    ["pages/store/index", "首页", "tab-home.png"],
    ["pages/home/index", "市场", "tab-market.png"],
    ["pages/forum/index", "校园圈", "tab-forum.png"],
    ["pages/profile/index", "我的", "tab-profile.png"],
  ];

  assert.equal(appJson.tabBar.list.length, mappings.length);
  mappings.forEach(([pagePath, text, fileName], index) => {
    const item = appJson.tabBar.list[index];
    const relativePath = `images/icons/${fileName}`;
    const imagePath = path.join(miniProgramRoot, relativePath);
    const image = fs.readFileSync(imagePath);

    assert.deepEqual(
      [item.pagePath, item.text, item.iconPath, item.selectedIconPath],
      [pagePath, text, relativePath, relativePath]
    );
    assert.equal(image.subarray(1, 4).toString("ascii"), "PNG");
    assert.equal(image.readUInt32BE(16), 81);
    assert.equal(image.readUInt32BE(20), 81);
    assert.ok(image.length < 40000);
  });
});

test("小程序默认打开校园圈且登录兜底返回校园圈", () => {
  const miniProgramRoot = path.join(__dirname, "..", "miniprogram");
  const appJson = JSON.parse(fs.readFileSync(path.join(miniProgramRoot, "app.json"), "utf8"));
  const loginJs = fs.readFileSync(path.join(miniProgramRoot, "pages", "login", "index.js"), "utf8");

  assert.equal(appJson.pages[0], "pages/forum/index");
  assert.ok(appJson.tabBar.list.some((item) => item.pagePath === "pages/forum/index"));
  assert.match(loginJs, /wx\.reLaunch\(\{ url: "\/pages\/forum\/index" \}\)/);
  assert.doesNotMatch(loginJs, /wx\.reLaunch\(\{ url: "\/pages\/store\/index" \}\)/);
});

test("个人中心隐藏平台市场订单入口并保留担保交易入口", () => {
  const profileRoot = path.join(__dirname, "..", "miniprogram", "pages", "profile");
  const wxml = fs.readFileSync(path.join(profileRoot, "index.wxml"), "utf8");
  const js = fs.readFileSync(path.join(profileRoot, "index.js"), "utf8");

  assert.doesNotMatch(wxml, /市场订单|goMarketOrders/);
  assert.doesNotMatch(js, /goMarketOrders|market-order-list/);
  assert.match(wxml, /bindtap="goC2COrders"[\s\S]*?<view class="service-name">担保交易<\/view>/);
  assert.match(js, /goC2COrders\(\)\s*\{\s*wx\.navigateTo\(\{ url: "\/pages\/c2c-order-list\/index" \}\)/);
});

test("购物车按标注调整商品操作与七三结算预留区", () => {
  const cartRoot = path.join(__dirname, "..", "miniprogram", "pages", "cart");
  const wxml = fs.readFileSync(path.join(cartRoot, "index.wxml"), "utf8");
  const wxss = fs.readFileSync(path.join(cartRoot, "index.wxss"), "utf8");
  const quantityIndex = wxml.indexOf('class="quantity"');
  const removeIndex = wxml.indexOf('class="remove-btn"');

  assert.match(wxml, /class="clear-btn" bindtap="clearCart">清空/);
  assert.ok(quantityIndex >= 0 && removeIndex > quantityIndex);
  assert.match(wxml, /class="cart-actions"[\s\S]*class="primary-btn checkout-btn"[\s\S]*class="coupon-reserve"/);
  assert.match(wxss, /\.clear-btn\s*\{[^}]*background:\s*#e5484d;[^}]*color:\s*#fff;/s);
  assert.match(wxss, /\.remove-btn\s*\{[^}]*margin:\s*0 0 0 auto;/s);
  assert.match(wxss, /\.quantity\s*\{[^}]*margin:\s*0;/s);
  assert.match(wxss, /\.cart-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0, 7fr\) minmax\(0, 3fr\);/s);
  assert.match(wxss, /\.checkout-btn\s*\{[^}]*width:\s*100%;/s);
  assert.match(wxss, /\.coupon-reserve\s*\{[^}]*height:\s*88rpx;/s);
});

test("校园市场分享标题统一使用宿院集", () => {
  const homeJs = fs.readFileSync(
    path.join(__dirname, "..", "miniprogram", "pages", "home", "index.js"),
    "utf8"
  );

  assert.equal((homeJs.match(/title:\s*"宿院集"/g) || []).length, 2);
  assert.doesNotMatch(homeJs, /鹏宇优选校园市场/);
  assert.match(homeJs, /onShareAppMessage\(\)[\s\S]*path:\s*"\/pages\/home\/index"/);
  assert.match(homeJs, /onShareTimeline\(\)[\s\S]*query:\s*""/);
});
