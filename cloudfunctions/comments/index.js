const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const ok = (data = {}) => ({ success: true, ...data });
const fail = (errMsg) => ({ success: false, errMsg });
const getOpenId = () => cloud.getWXContext().OPENID;

const addComment = async (event) => {
  const openid = getOpenId();
  if (!event.targetId || !event.targetType) return fail("缺少评论对象");
  if (!["post", "goods"].includes(event.targetType)) return fail("评论对象不合法");
  if (!event.content || !String(event.content).trim()) return fail("评论不能为空");

  let nickName = "同学";
  const userRes = await db.collection("users").where({ _openid: openid }).limit(1).get();
  if (userRes.data.length) {
    nickName = userRes.data[0].nickName || nickName;
  }

  const data = {
    _openid: openid,
    targetType: event.targetType,
    targetId: event.targetId,
    content: String(event.content).trim().slice(0, 500),
    nickName,
    createdAt: new Date(),
  };
  const res = await db.collection("comments").add({ data });

  if (event.targetType === "post") {
    await db
      .collection("posts")
      .doc(event.targetId)
      .update({
        data: {
          commentCount: _.inc(1),
          updatedAt: new Date(),
        },
      })
      .catch(() => {});
  }

  return ok({ id: res._id });
};

const listComments = async (event) => {
  if (!event.targetId || !event.targetType) return fail("缺少评论对象");
  const res = await db
    .collection("comments")
    .where({
      targetType: event.targetType,
      targetId: event.targetId,
    })
    .orderBy("createdAt", "asc")
    .limit(100)
    .get();
  return ok({ data: res.data });
};

exports.main = async (event) => {
  try {
    switch (event.type) {
      case "add":
        return await addComment(event);
      case "list":
        return await listComments(event);
      default:
        return fail("未知操作");
    }
  } catch (error) {
    return fail(error.message || "评论服务异常");
  }
};
