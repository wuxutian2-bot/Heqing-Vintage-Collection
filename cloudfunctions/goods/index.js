const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ok = (data = {}) => ({ success: true, ...data });
const fail = (errMsg) => ({ success: false, errMsg });

const getOpenId = () => cloud.getWXContext().OPENID;
const formatDisplayName = (user) => {
  const aliasNo = Number(user && user.aliasNo || 0);
  if (Number.isInteger(aliasNo) && aliasNo > 0) return `鹏宇用户${String(aliasNo).padStart(4, "0")}`;
  const legacy = String(user && user.displayName || "").match(/用户(\d+)$/);
  return legacy ? `鹏宇用户${legacy[1].padStart(4, "0")}` : "鹏宇用户";
};
const GOODS_CATEGORIES = ["零食", "饮料", "数码", "教材", "学习用品", "生活用品", "服饰鞋包", "运动健身", "美妆护理", "票券卡类", "求购", "其他"];
const LEGACY_CATEGORY_MAP = { 生活: "生活用品", 服饰: "服饰鞋包", 运动: "运动健身" };
const hasActiveRecovery = (goods) => Boolean(goods && goods.recoveryOrderId)
  && goods.recoveryStatus !== "closed";
// C2C 订单由专用云函数和支付回调推进。这里必须拒绝旧客户端直接“标记已售”
// 或删除，否则可以绕过付款、争议和待结算记录。
const hasActiveC2CTrade = (goods) => Boolean(goods && goods.c2cOrderId)
  && !["cancelled", "expired"].includes(String(goods.c2cTradeStatus || ""));

const requireUser = async () => {
  const openid = getOpenId();
  if (!openid) throw new Error("请先登录");
  const res = await db.collection("users").where({ _openid: openid }).limit(1).get();
  if (!res.data[0]) throw new Error("请先登录");
  return { ...res.data[0], openid };
};

const publicAuthor = (user, item = {}) => {
  const snapshot = item.author && typeof item.author === "object" ? item.author : {};
  const fallback = {
    _id: item.authorId || item.userId || snapshot.userId || "",
    aliasNo: Number(item.authorAliasNo || snapshot.aliasNo || 0),
    displayName: item.authorDisplayName || snapshot.displayName || "",
    avatarKey: Number(item.authorAvatarKey || snapshot.avatarKey || 1),
    avatarUrl: item.authorAvatarUrl || snapshot.avatarUrl || "",
  };
  const source = user || fallback;
  return {
    userId: source._id || fallback._id || "",
    displayName: formatDisplayName(source),
    avatarUrl: source.avatarUrl || fallback.avatarUrl || `/images/avatars/avatar-${Number(source.avatarKey || 1)}.svg`,
  };
};

const publicGoods = (item, author) => ({
  _id: item._id,
  title: item.title,
  price: item.price,
  desc: item.desc,
  category: LEGACY_CATEGORY_MAP[item.category] || item.category || "其他",
  images: validImageList(item.images),
  status: item.status,
  viewCount: Number(item.viewCount || 0),
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  // 平台完成实物验收并收购后才会写入这些字段。前端据此显示微信支付入口；
  // 价格和库存仍会在 market / 支付云函数中重新校验，不能仅依赖前端展示值。
  platformOwned: item.platformOwned === true,
  inventoryId: item.platformOwned === true ? String(item.inventoryId || "") : "",
  platformSalePriceFen: item.platformOwned === true
    ? Number(item.platformSalePriceFen || 0)
    : 0,
  author: publicAuthor(author, item),
});

const validImageList = (images) => (Array.isArray(images) ? images : [])
  .filter((image) => typeof image === "string")
  .map((image) => image.trim())
  .filter((image) => image.indexOf("cloud://") === 0 || /^https?:\/\//.test(image))
  .slice(0, 9);

const attachAuthors = async (items) => {
  const openids = [...new Set(items.map((item) => item._openid).filter(Boolean))];
  const userIds = [...new Set(items.map((item) => item.authorId || item.userId).filter(Boolean))];
  const [usersByOpenIdRes, usersByIdRes] = await Promise.all([
    openids.length
      ? db.collection("users").where({ _openid: _.in(openids) }).limit(100).get()
      : Promise.resolve({ data: [] }),
    userIds.length
      ? db.collection("users").where({ _id: _.in(userIds) }).limit(100).get()
      : Promise.resolve({ data: [] }),
  ]);
  const users = [...usersByOpenIdRes.data, ...usersByIdRes.data];
  const usersByOpenId = new Map(users.map((user) => [user._openid, user]));
  const usersById = new Map(users.map((user) => [user._id, user]));
  return items.map((item) => publicGoods(
    item,
    usersById.get(item.authorId || item.userId) || usersByOpenId.get(item._openid)
  ));
};

const resolveGoodsImages = async (items) => {
  const fileList = [...new Set(items
    .flatMap((item) => validImageList(item.images))
    .filter((image) => image.indexOf("cloud://") === 0))];
  if (!fileList.length) return items;

  try {
    const result = await cloud.getTempFileURL({ fileList });
    const urlByFileId = new Map((result.fileList || [])
      .filter((file) => file.fileID && file.tempFileURL)
      .map((file) => [file.fileID, file.tempFileURL]));
    return items.map((item) => ({
      ...item,
      images: validImageList(item.images).map((image) => urlByFileId.get(image) || image),
    }));
  } catch (error) {
    console.error("[goods] failed to resolve cloud image URLs", error);
    return items;
  }
};

const MSG_RISK_TIP = "发布内容含违规信息";

const checkTextSecurity = async (openid, content, scene = 2) => {
  const text = String(content || "").trim();
  if (!text) return;

  try {
    const res = await cloud.openapi.security.msgSecCheck({
      content: text.slice(0, 2500),
      version: 2,
      openid,
      scene,
    });
    if (res && res.errCode === 87014) {
      console.warn("[security] msgSecCheck blocked", { scene });
      throw new Error(MSG_RISK_TIP);
    }
    const suggest = res && res.result && res.result.suggest;
    if (suggest && suggest !== "pass") {
      console.warn("[security] msgSecCheck blocked", { scene, suggest });
      throw new Error(MSG_RISK_TIP);
    }
    console.log("[security] msgSecCheck passed", { scene });
  } catch (error) {
    if (error.message === MSG_RISK_TIP || error.errCode === 87014) {
      throw new Error(MSG_RISK_TIP);
    }
    throw new Error("内容安全检测失败，请稍后重试");
  }
};

const checkImagesSecurity = async (openid, images, scene = 2) => {
  if (!Array.isArray(images) || images.length === 0) return;

  const fileList = images.filter((image) => typeof image === "string" && image.indexOf("cloud://") === 0);
  const urlList = images.filter((image) => typeof image === "string" && /^https?:\/\//.test(image));

  if (fileList.length) {
    const tempRes = await cloud.getTempFileURL({ fileList });
    (tempRes.fileList || []).forEach((file) => {
      if (file.tempFileURL) {
        urlList.push(file.tempFileURL);
      }
    });
  }

  try {
    await Promise.all(
      urlList.map((mediaUrl) =>
        cloud.openapi.security.mediaCheckAsync({
          mediaUrl,
          mediaType: 2,
          version: 2,
          openid,
          scene,
        })
      )
    );
  } catch (error) {
    if (error.errCode === 87014) {
      console.warn("[security] mediaCheckAsync blocked", { scene });
      throw new Error(MSG_RISK_TIP);
    }
    throw new Error("内容安全检测失败，请稍后重试");
  }
};

const addGoods = async (event) => {
  const user = await requireUser();
  const openid = user.openid;
  if (!event.title || !event.desc) return fail("请完善商品信息");
  const price = Number(event.price);
  if (Number.isNaN(price) || price < 0) return fail("价格必须是数字");
  const images = validImageList(event.images);
  if (!images.length) return fail("请至少上传1张商品图片");
  await checkTextSecurity(
    openid,
    [event.title, event.desc, event.category].filter(Boolean).join("\n"),
    2
  );
  await checkImagesSecurity(openid, images, 2);

  const data = {
    _openid: openid,
    authorId: user._id,
    authorAliasNo: Number(user.aliasNo || 0),
    authorDisplayName: formatDisplayName(user),
    authorAvatarKey: Number(user.avatarKey || 1),
    authorAvatarUrl: user.avatarUrl || "",
    title: String(event.title).slice(0, 60),
    price,
    desc: String(event.desc).slice(0, 1000),
    category: GOODS_CATEGORIES.includes(event.category) ? event.category : "其他",
    images,
    status: "on_sale",
    viewCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const res = await db.collection("goods").add({ data });
  return ok({ id: res._id });
};

const listGoods = async (event) => {
  const page = Math.max(Number(event.page || 1), 1);
  const pageSize = Math.min(Math.max(Number(event.pageSize || 10), 1), 50);
  const where = {};

  if (event.mine) {
    where._openid = getOpenId();
  } else {
    where.status = "on_sale";
  }
  if (event.category && GOODS_CATEGORIES.includes(event.category)) {
    const legacy = Object.keys(LEGACY_CATEGORY_MAP).filter((key) => LEGACY_CATEGORY_MAP[key] === event.category);
    where.category = legacy.length ? _.in([event.category, ...legacy]) : event.category;
  }
  if (event.keyword) {
    where.title = db.RegExp({
      regexp: String(event.keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      options: "i",
    });
  }

  const sort = {
    hot: ["viewCount", "desc"],
    price_asc: ["price", "asc"],
    price_desc: ["price", "desc"],
  }[event.sort] || ["createdAt", "desc"];
  const res = await db
    .collection("goods")
    .where(where)
    .orderBy(sort[0], sort[1])
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();
  const data = await attachAuthors(res.data);
  return ok({ data: await resolveGoodsImages(data) });
};

const detailGoods = async (event) => {
  if (!event.id) return fail("缺少商品 ID");
  await db
    .collection("goods")
    .doc(event.id)
    .update({
      data: {
        viewCount: _.inc(1),
      },
    });
  const res = await db.collection("goods").doc(event.id).get();
  const data = await attachAuthors([res.data]);
  const resolved = await resolveGoodsImages(data);
  return ok({ data: resolved[0] });
};

const updateStatus = async (event) => {
  const user = await requireUser();
  const openid = user.openid;
  const status = event.status;
  if (!event.id) return fail("缺少商品 ID");
  if (!["on_sale", "sold", "removed"].includes(status)) return fail("状态不合法");
  return db.runTransaction(async (transaction) => {
    const goodsRef = transaction.collection("goods").doc(event.id);
    const goodsRes = await goodsRef.get();
    const goods = goodsRes.data;
    if (!goods) return fail("商品不存在");
    const isOwner = goods._openid === openid || goods.authorId === user._id;
    if (goods.platformOwned) return fail("平台商品只能在市场库存管理中上下架");
    if (hasActiveRecovery(goods)) return fail("商品正在回收流程中，请先完成取消或退回流程");
    if (hasActiveC2CTrade(goods)) return fail("商品正在担保交易流程中，请在交易订单内处理");
    if (!isOwner && user.role !== "admin") return fail("无权修改该商品");
    if (!isOwner && user.role === "admin" && status !== "removed") return fail("管理员只能执行下架操作");
    const res = await goodsRef.update({
      data: {
        status,
        moderatedBy: !isOwner && user.role === "admin" ? user._id : goods.moderatedBy || "",
        moderatedAt: !isOwner && user.role === "admin" ? new Date() : goods.moderatedAt || null,
        updatedAt: new Date(),
      },
    });
    return ok({ updated: res.stats.updated, status });
  });
};

const deleteGoods = async (event) => {
  const user = await requireUser();
  const openid = user.openid;
  if (!event.id) return fail("缺少商品 ID");

  const result = await db.runTransaction(async (transaction) => {
    const goodsRef = transaction.collection("goods").doc(event.id);
    const currentRes = await goodsRef.get();
    const current = currentRes.data;
    if (!current || current._openid !== openid) return ok({ removed: 0 });
    if (current.platformOwned) return fail("平台已收购商品不能删除");
    if (hasActiveRecovery(current)) return fail("商品正在回收流程中，请先完成取消或退回流程");
    if (hasActiveC2CTrade(current)) return fail("商品正在担保交易流程中，请在交易订单内处理");
    const goodsRes = await goodsRef.remove();
    return ok({ removed: goodsRes.stats.removed });
  });

  if (result.success && result.removed > 0) {
    await db
      .collection("favorites")
      .where({
        targetType: "goods",
        targetId: event.id,
      })
      .remove()
      .catch(() => {});
  }

  return result;
};

exports.main = async (event) => {
  try {
    switch (event.type) {
      case "add":
        return await addGoods(event);
      case "list":
        return await listGoods(event);
      case "detail":
        return await detailGoods(event);
      case "updateStatus":
        return await updateStatus(event);
      case "delete":
        return await deleteGoods(event);
      default:
        return fail("未知操作");
    }
  } catch (error) {
    return fail(error.message || "商品服务异常");
  }
};
