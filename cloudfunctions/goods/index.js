const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ok = (data = {}) => ({ success: true, ...data });
const fail = (errMsg) => ({ success: false, errMsg });

const getOpenId = () => cloud.getWXContext().OPENID;

const addGoods = async (event) => {
  const openid = getOpenId();
  if (!event.title || !event.desc || !event.contact) return fail("请完善商品信息");
  const price = Number(event.price);
  if (Number.isNaN(price) || price < 0) return fail("价格必须是数字");

  const data = {
    _openid: openid,
    title: String(event.title).slice(0, 60),
    price,
    desc: String(event.desc).slice(0, 1000),
    category: event.category || "其他",
    images: Array.isArray(event.images) ? event.images : [],
    status: "on_sale",
    contact: String(event.contact).slice(0, 80),
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
  if (event.category) {
    where.category = event.category;
  }
  if (event.keyword) {
    where.title = db.RegExp({
      regexp: String(event.keyword).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      options: "i",
    });
  }

  const res = await db
    .collection("goods")
    .where(where)
    .orderBy("createdAt", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();
  return ok({ data: res.data });
};

const detailGoods = async (event) => {
  if (!event.id) return fail("缺少商品 ID");
  const res = await db.collection("goods").doc(event.id).get();
  await db
    .collection("goods")
    .doc(event.id)
    .update({
      data: {
        viewCount: _.inc(1),
        updatedAt: new Date(),
      },
    })
    .catch(() => {});
  return ok({ data: res.data });
};

const updateStatus = async (event) => {
  const openid = getOpenId();
  const status = event.status;
  if (!["on_sale", "sold", "removed"].includes(status)) return fail("状态不合法");
  const res = await db
    .collection("goods")
    .where({
      _id: event.id,
      _openid: openid,
    })
    .update({
      data: {
        status,
        updatedAt: new Date(),
      },
    });
  return ok({ updated: res.stats.updated });
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
      default:
        return fail("未知操作");
    }
  } catch (error) {
    return fail(error.message || "商品服务异常");
  }
};
