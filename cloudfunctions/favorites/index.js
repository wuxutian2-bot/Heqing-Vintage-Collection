const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ok = (data = {}) => ({ success: true, ...data });
const fail = (errMsg) => ({ success: false, errMsg });
const getOpenId = () => cloud.getWXContext().OPENID;

const checkFavorite = async (event) => {
  const openid = getOpenId();
  if (!event.targetId || !event.targetType) return fail("缺少收藏对象");
  const res = await db
    .collection("favorites")
    .where({
      _openid: openid,
      targetType: event.targetType,
      targetId: event.targetId,
    })
    .limit(1)
    .get();
  return ok({ favorite: res.data.length > 0 });
};

const toggleFavorite = async (event) => {
  const openid = getOpenId();
  if (!event.targetId || !event.targetType) return fail("缺少收藏对象");
  const query = {
    _openid: openid,
    targetType: event.targetType,
    targetId: event.targetId,
  };
  const res = await db.collection("favorites").where(query).limit(1).get();
  if (res.data.length) {
    await db.collection("favorites").doc(res.data[0]._id).remove();
    return ok({ favorite: false });
  }
  await db.collection("favorites").add({
    data: {
      ...query,
      createdAt: new Date(),
    },
  });
  return ok({ favorite: true });
};

const listFavorites = async (event) => {
  const openid = getOpenId();
  const targetType = event.targetType || "goods";
  const favRes = await db
    .collection("favorites")
    .where({
      _openid: openid,
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
  const data = dataRes.data.sort((a, b) => orderMap[a._id] - orderMap[b._id]);
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
