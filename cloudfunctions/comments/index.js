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
  const legacy = String(user && (user.displayName || user.nickName) || "").match(/用户(\d+)$/);
  return legacy ? `鹏宇用户${legacy[1].padStart(4, "0")}` : "鹏宇用户";
};
const formatAvatarUrl = (user) => (
  user && user.avatarUrl || `/images/avatars/avatar-${Number(user && user.avatarKey || 1)}.svg`
);

const requireUser = async () => {
  const openid = getOpenId();
  if (!openid) throw new Error("请先登录");
  const res = await db.collection("users").where({ _openid: openid }).limit(1).get();
  if (!res.data[0]) throw new Error("请先登录");
  return { ...res.data[0], openid };
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

const addComment = async (event) => {
  const user = await requireUser();
  const openid = user.openid;
  if (!event.targetId || !event.targetType) return fail("缺少评论对象");
  if (!["post", "goods"].includes(event.targetType)) return fail("评论对象不合法");
  if (!event.content || !String(event.content).trim()) return fail("评论不能为空");
  await checkTextSecurity(openid, event.content, event.targetType === "post" ? 3 : 2);

  let replyTarget = null;
  const replyToCommentId = String(event.replyToCommentId || "").trim();
  if (replyToCommentId) {
    const replyRes = await db.collection("comments").doc(replyToCommentId).get();
    replyTarget = replyRes.data;
    if (
      !replyTarget
      || replyTarget.targetType !== event.targetType
      || replyTarget.targetId !== event.targetId
    ) return fail("回复的评论不存在");
  }

  const data = {
    _openid: openid,
    targetType: event.targetType,
    targetId: event.targetId,
    content: String(event.content).trim().slice(0, 500),
    userId: user._id,
    aliasNo: Number(user.aliasNo || 0),
    displayName: formatDisplayName(user),
    avatarKey: Number(user.avatarKey || 1),
    avatarId: Number(user.avatarId || 0),
    avatarUrl: formatAvatarUrl(user),
    parentId: replyTarget ? String(replyTarget.parentId || replyTarget._id) : "",
    replyToCommentId: replyTarget ? replyTarget._id : "",
    replyToUserId: replyTarget ? String(replyTarget.userId || "") : "",
    replyToAliasNo: replyTarget ? Number(replyTarget.aliasNo || 0) : 0,
    replyToDisplayName: replyTarget ? formatDisplayName(replyTarget) : "",
    likeCount: 0,
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
  const userIds = [...new Set(res.data.flatMap((item) => [item.userId, item.replyToUserId]).filter(Boolean))];
  const openids = [...new Set(res.data.map((item) => item._openid).filter(Boolean))];
  const [usersByIdRes, usersByOpenIdRes] = await Promise.all([
    userIds.length
      ? db.collection("users").where({ _id: _.in(userIds) }).limit(100).get()
      : Promise.resolve({ data: [] }),
    openids.length
      ? db.collection("users").where({ _openid: _.in(openids) }).limit(100).get()
      : Promise.resolve({ data: [] }),
  ]);
  const users = [...usersByIdRes.data, ...usersByOpenIdRes.data];
  const usersById = new Map(users.map((user) => [user._id, user]));
  const usersByOpenId = new Map(users.map((user) => [user._openid, user]));
  const openid = getOpenId();
  const commentIds = res.data.map((item) => item._id);
  let likedCommentIds = new Set();
  if (openid && commentIds.length) {
    const likes = await db
      .collection("comment_likes")
      .where({
        _openid: openid,
        commentId: _.in(commentIds),
      })
      .limit(100)
      .get()
      .then((likeRes) => likeRes.data)
      .catch(() => []);
    likedCommentIds = new Set(likes.map((item) => item.commentId));
  }
  return ok({
    data: res.data.map((item) => {
      const author = usersById.get(item.userId) || usersByOpenId.get(item._openid) || item;
      return {
        _id: item._id,
        targetType: item.targetType,
        targetId: item.targetId,
        content: item.content,
        userId: author._id || item.userId || "",
        displayName: formatDisplayName(author),
        avatarUrl: formatAvatarUrl(author),
        parentId: String(item.parentId || ""),
        replyToCommentId: String(item.replyToCommentId || ""),
        replyToUserId: String(item.replyToUserId || ""),
        replyToDisplayName: item.replyToUserId
          ? formatDisplayName(usersById.get(item.replyToUserId) || {
            aliasNo: item.replyToAliasNo,
            displayName: item.replyToDisplayName,
          })
          : "",
        likeCount: Math.max(0, Number(item.likeCount || 0)),
        liked: likedCommentIds.has(item._id),
        createdAt: item.createdAt,
      };
    }),
  });
};

const toggleCommentLike = async (event) => {
  const user = await requireUser();
  const commentId = String(event.commentId || "").trim();
  if (!commentId) return fail("缺少评论 ID");

  const commentRes = await db.collection("comments").doc(commentId).get();
  if (!commentRes.data) return fail("评论不存在");

  const existing = await db
    .collection("comment_likes")
    .where({ _openid: user.openid, commentId })
    .limit(1)
    .get();

  let liked = false;
  if (existing.data[0]) {
    const removeRes = await db.collection("comment_likes").doc(existing.data[0]._id).remove();
    if (removeRes.stats.removed > 0) {
      await db.collection("comments").doc(commentId).update({
        data: { likeCount: _.inc(-1) },
      });
    }
  } else {
    await db.collection("comment_likes").add({
      data: {
        _openid: user.openid,
        commentId,
        targetType: commentRes.data.targetType,
        targetId: commentRes.data.targetId,
        createdAt: new Date(),
      },
    });
    await db.collection("comments").doc(commentId).update({
      data: { likeCount: _.inc(1) },
    });
    liked = true;
  }

  const updated = await db.collection("comments").doc(commentId).get();
  let likeCount = Math.max(0, Number(updated.data.likeCount || 0));
  if (Number(updated.data.likeCount || 0) < 0) {
    await db.collection("comments").doc(commentId).update({ data: { likeCount: 0 } });
    likeCount = 0;
  }
  return ok({ commentId, liked, likeCount });
};

const deleteComment = async (event) => {
  const user = await requireUser();
  const commentId = String(event.commentId || "").trim();
  if (!commentId) return fail("缺少评论 ID");
  const commentRes = await db.collection("comments").doc(commentId).get();
  const comment = commentRes.data;
  if (!comment) return fail("评论不存在");
  const isOwner = comment._openid === user.openid || comment.userId === user._id;
  if (!isOwner && user.role !== "admin") return fail("无权删除该评论");

  const removedIds = [commentId];
  if (!comment.parentId) {
    const replies = await db.collection("comments").where({ parentId: commentId }).limit(100).get();
    replies.data.forEach((reply) => removedIds.push(reply._id));
    await db.collection("comments").where({ parentId: commentId }).remove();
  }
  await db.collection("comments").doc(commentId).remove();
  for (let index = 0; index < removedIds.length; index += 20) {
    const batch = removedIds.slice(index, index + 20);
    await db.collection("comment_likes").where({ commentId: _.in(batch) }).remove().catch(() => {});
  }

  if (comment.targetType === "post") {
    const remaining = await db.collection("comments").where({
      targetType: "post",
      targetId: comment.targetId,
    }).count().catch(() => ({ total: 0 }));
    await db.collection("posts").doc(comment.targetId).update({
      data: {
        commentCount: Math.max(0, Number(remaining.total || 0)),
        updatedAt: new Date(),
      },
    }).catch(() => {});
  }

  return ok({ removedIds });
};

exports.main = async (event) => {
  try {
    switch (event.type) {
      case "add":
        return await addComment(event);
      case "list":
        return await listComments(event);
      case "toggleLike":
        return await toggleCommentLike(event);
      case "delete":
        return await deleteComment(event);
      default:
        return fail("未知操作");
    }
  } catch (error) {
    return fail(error.message || "评论服务异常");
  }
};
