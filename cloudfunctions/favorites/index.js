const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ok = (data = {}) => ({ success: true, ...data });
const fail = (errMsg) => ({ success: false, errMsg });
const getOpenId = () => cloud.getWXContext().OPENID;
const TARGET_TYPES = ["goods", "post"];
const formatDisplayName = (user) => {
  const aliasNo = Number(user && user.aliasNo || 0);
  if (Number.isInteger(aliasNo) && aliasNo > 0) return `鹏宇用户${String(aliasNo).padStart(4, "0")}`;
  const legacy = String(user && user.displayName || "").match(/用户(\d+)$/);
  return legacy ? `鹏宇用户${legacy[1].padStart(4, "0")}` : "鹏宇用户";
};

const requireUser = async () => {
  const openid = getOpenId();
  if (!openid) throw new Error("请先登录");
  const res = await db.collection("users").where({ _openid: openid }).limit(1).get();
  if (!res.data[0]) throw new Error("请先登录");
  return { ...res.data[0], openid };
};

const publicAuthor = (user) => ({
  userId: user && user._id || "",
  displayName: formatDisplayName(user),
  avatarUrl: user && user.avatarUrl || `/images/avatars/avatar-${Number(user && user.avatarKey || 1)}.svg`,
});

const publicGoods = (item, author) => ({
  _id: item._id,
  title: item.title,
  price: Number(item.price || 0),
  desc: item.desc || "",
  category: item.category || "其他",
  images: Array.isArray(item.images) ? item.images : [],
  status: item.status,
  viewCount: Number(item.viewCount || 0),
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  author: publicAuthor(author),
});

const publicPost = (item, author) => ({
  _id: item._id,
  title: item.title,
  content: item.content || "",
  images: Array.isArray(item.images) ? item.images : [],
  likeCount: Number(item.likeCount || 0),
  commentCount: Number(item.commentCount || 0),
  viewCount: Number(item.viewCount || 0),
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  author: publicAuthor(author),
});

const validateTarget = (targetType, targetId) => {
  if (!TARGET_TYPES.includes(targetType) || !targetId) {
    throw new Error("收藏对象不合法");
  }
};

const checkFavorite = async (event) => {
  const user = await requireUser();
  validateTarget(event.targetType, event.targetId);
  const res = await db
    .collection("favorites")
    .where({
      _openid: user.openid,
      targetType: event.targetType,
      targetId: event.targetId,
    })
    .limit(1)
    .get();
  return ok({ favorite: res.data.length > 0 });
};

const toggleFavorite = async (event) => {
  const user = await requireUser();
  validateTarget(event.targetType, event.targetId);
  const query = {
    _openid: user.openid,
    targetType: event.targetType,
    targetId: event.targetId,
  };
  const res = await db.collection("favorites").where(query).limit(1).get();
  if (res.data.length) {
    await db.collection("favorites").doc(res.data[0]._id).remove();
    return ok({ favorite: false });
  }
  const targetCollection = event.targetType === "post" ? "posts" : "goods";
  const targetRes = await db.collection(targetCollection).doc(event.targetId).get();
  if (!targetRes.data) return fail("收藏对象不存在");
  await db.collection("favorites").add({
    data: {
      ...query,
      createdAt: new Date(),
    },
  });
  return ok({ favorite: true });
};

const listFavorites = async (event) => {
  const user = await requireUser();
  const targetType = event.targetType || "goods";
  validateTarget(targetType, "list");
  const favRes = await db
    .collection("favorites")
    .where({
      _openid: user.openid,
      targetType,
    })
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();

  const ids = favRes.data.map((item) => item.targetId);
  if (!ids.length) return ok({ data: [] });

  const collectionName = targetType === "post" ? "posts" : "goods";
  const dataRes = await db
    .collection(collectionName)
    .where({
      _id: _.in(ids),
    })
    .limit(100)
    .get();

  const orderMap = favRes.data.reduce((map, item, index) => {
    map[item.targetId] = index;
    return map;
  }, {});
  const openids = [...new Set(dataRes.data.map((item) => item._openid).filter(Boolean))];
  let users = [];
  if (openids.length) {
    const userRes = await db.collection("users").where({ _openid: _.in(openids) }).limit(100).get();
    users = userRes.data;
  }
  const usersByOpenId = new Map(users.map((item) => [item._openid, item]));
  const data = dataRes.data
    .sort((a, b) => orderMap[a._id] - orderMap[b._id])
    .map((item) => targetType === "post"
      ? publicPost(item, usersByOpenId.get(item._openid))
      : publicGoods(item, usersByOpenId.get(item._openid)));
  return ok({ data });
};

exports.main = async (event) => {
  try {
    switch (event.type) {
      case "check":
        return await checkFavorite(event);
      case "toggle":
        return await toggleFavorite(event);
      case "list":
        return await listFavorites(event);
      default:
        return fail("未知操作");
    }
  } catch (error) {
    return fail(error.message || "收藏服务异常");
  }
};
