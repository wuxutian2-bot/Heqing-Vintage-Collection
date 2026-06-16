const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ok = (data = {}) => ({ success: true, ...data });
const fail = (errMsg) => ({ success: false, errMsg });
const getOpenId = () => cloud.getWXContext().OPENID;

const addPost = async (event) => {
  const openid = getOpenId();
  if (!event.title || !event.content) return fail("请填写帖子内容");
  const data = {
    _openid: openid,
    title: String(event.title).slice(0, 80),
    content: String(event.content).slice(0, 2000),
    images: Array.isArray(event.images) ? event.images : [],
    likeCount: 0,
    commentCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const res = await db.collection("posts").add({ data });
  return ok({ id: res._id });
};

const listPosts = async (event) => {
  const page = Math.max(Number(event.page || 1), 1);
  const pageSize = Math.min(Math.max(Number(event.pageSize || 10), 1), 50);
  const where = {};
  if (event.mine) {
    where._openid = getOpenId();
  }
  const res = await db
    .collection("posts")
    .where(where)
    .orderBy("createdAt", "desc")
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    .get();
  return ok({ data: res.data });
};

const detailPost = async (event) => {
  if (!event.id) return fail("缺少帖子 ID");
  const res = await db.collection("posts").doc(event.id).get();
  return ok({ data: res.data });
};

const likePost = async (event) => {
  if (!event.id) return fail("缺少帖子 ID");
  await db.collection("posts").doc(event.id).update({
    data: {
      likeCount: _.inc(1),
      updatedAt: new Date(),
    },
  });
  const res = await db.collection("posts").doc(event.id).get();
  return ok({ likeCount: res.data.likeCount || 0 });
};

exports.main = async (event) => {
  try {
    switch (event.type) {
      case "add":
        return await addPost(event);
      case "list":
        return await listPosts(event);
      case "detail":
        return await detailPost(event);
      case "like":
        return await likePost(event);
      default:
        return fail("未知操作");
    }
  } catch (error) {
    return fail(error.message || "帖子服务异常");
  }
};
