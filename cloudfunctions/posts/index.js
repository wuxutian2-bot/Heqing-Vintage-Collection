const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const POST_CATEGORIES = ["校园动态", "求助问答", "拼单搭子", "失物招领", "新生指南", "吐槽闲聊"];
const WEEK_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

const ok = (data = {}) => ({ success: true, ...data });
const fail = (errMsg) => ({ success: false, errMsg });
const getOpenId = () => cloud.getWXContext().OPENID;
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

const normalizeCategory = (value) => (
  POST_CATEGORIES.includes(String(value || "")) ? String(value) : "校园动态"
);

const publicPost = (item, author) => ({
  _id: item._id,
  title: item.title,
  content: item.content,
  category: normalizeCategory(item.category),
  images: Array.isArray(item.images) ? item.images : [],
  likeCount: Number(item.likeCount || 0),
  commentCount: Number(item.commentCount || 0),
  viewCount: Number(item.viewCount || 0),
  isPinned: item.isPinned === true,
  pinnedAt: item.pinnedAt || null,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  author: publicAuthor(author, item),
});

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
  return items.map((item) => publicPost(
    item,
    usersById.get(item.authorId || item.userId) || usersByOpenId.get(item._openid)
  ));
};

const MSG_RISK_TIP = "发布内容含违规信息";

const checkTextSecurity = async (openid, content, scene = 3) => {
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

const checkImagesSecurity = async (openid, images, scene = 3) => {
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

const addPost = async (event) => {
  const user = await requireUser();
  const openid = user.openid;
  if (!event.title || !event.content) return fail("请填写帖子内容");
  const images = Array.isArray(event.images) ? event.images : [];
  await checkTextSecurity(openid, [event.title, event.content].join("\n"), 3);
  await checkImagesSecurity(openid, images, 3);
  const data = {
    _openid: openid,
    authorId: user._id,
    authorAliasNo: Number(user.aliasNo || 0),
    authorDisplayName: formatDisplayName(user),
    authorAvatarKey: Number(user.avatarKey || 1),
    authorAvatarUrl: user.avatarUrl || "",
    title: String(event.title).slice(0, 80),
    content: String(event.content).slice(0, 2000),
    category: normalizeCategory(event.category),
    images,
    likeCount: 0,
    commentCount: 0,
    viewCount: 0,
    isPinned: false,
    pinnedAt: null,
    pinnedBy: "",
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
  if (POST_CATEGORIES.includes(String(event.category || ""))) {
    where.category = String(event.category);
  }
  // 先取最近内容，再在内存中把置顶项提升到首位，避免为“分类 + 置顶 + 时间”
  // 强制创建新的组合索引。校园 MVP 当前最多处理最近 100 条动态。
  const res = await db.collection("posts")
    .where(where)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  const sorted = res.data.sort((a, b) => {
    const pinDifference = Number(b.isPinned === true) - Number(a.isPinned === true);
    if (pinDifference) return pinDifference;
    if (a.isPinned === true && b.isPinned === true) {
      const pinnedDifference = new Date(b.pinnedAt || 0).getTime() - new Date(a.pinnedAt || 0).getTime();
      if (pinnedDifference) return pinnedDifference;
    }
    if (event.sort === "hot") {
      const viewDifference = Number(b.viewCount || 0) - Number(a.viewCount || 0);
      if (viewDifference) return viewDifference;
    }
    return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
  });
  const start = (page - 1) * pageSize;
  const pageItems = sorted.slice(start, start + pageSize);
  return ok({
    data: await attachAuthors(pageItems),
    page,
    hasMore: start + pageItems.length < sorted.length,
  });
};

const weeklyHotScore = (item) => (
  Number(item.viewCount || 0)
  + Number(item.commentCount || 0) * 5
  + Number(item.likeCount || 0) * 3
);

const listWeeklyHotPosts = async () => {
  const cutoff = Date.now() - WEEK_MILLISECONDS;
  const res = await db.collection("posts")
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();
  const recent = res.data
    .filter((item) => {
      const createdAt = new Date(item.createdAt || 0).getTime();
      return Number.isFinite(createdAt) && createdAt >= cutoff;
    })
    .sort((a, b) => {
      const scoreDifference = weeklyHotScore(b) - weeklyHotScore(a);
      if (scoreDifference) return scoreDifference;
      return new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime();
    })
    .slice(0, 10);
  return ok({
    data: await attachAuthors(recent),
    rangeDays: 7,
  });
};

const detailPost = async (event) => {
  if (!event.id) return fail("缺少帖子 ID");
  let item;
  if (event.countView !== false) {
    item = await db.runTransaction(async (transaction) => {
      const postRef = transaction.collection("posts").doc(event.id);
      const current = (await postRef.get()).data;
      if (!current) throw new Error("帖子不存在");
      const viewCount = Math.max(0, Number(current.viewCount || 0)) + 1;
      await postRef.update({ data: { viewCount } });
      return { ...current, viewCount };
    });
  } else {
    const res = await db.collection("posts").doc(event.id).get();
    item = res.data;
  }
  const data = await attachAuthors([item]);
  return ok({ data: data[0] });
};

const likePost = async (event) => {
  await requireUser();
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

const setPinned = async (event) => {
  const user = await requireUser();
  if (user.role !== "admin") return fail("无管理员权限");
  if (!event.id) return fail("缺少帖子 ID");
  const postRes = await db.collection("posts").doc(event.id).get();
  if (!postRes.data) return fail("帖子不存在");
  const isPinned = event.isPinned === true;
  const pinnedAt = isPinned ? new Date() : null;
  await db.collection("posts").doc(event.id).update({
    data: {
      isPinned,
      pinnedAt,
      pinnedBy: isPinned ? user._id : "",
      updatedAt: new Date(),
    },
  });
  return ok({ id: event.id, isPinned, pinnedAt });
};

const deletePost = async (event) => {
  const user = await requireUser();
  const openid = user.openid;
  if (!event.id) return fail("缺少帖子 ID");
  const postDoc = await db.collection("posts").doc(event.id).get();
  const post = postDoc.data;
  if (!post) return fail("帖子不存在");
  const isOwner = post._openid === openid || post.authorId === user._id;
  if (!isOwner && user.role !== "admin") return fail("无权删除该帖子");

  const comments = await db.collection("comments").where({
    targetType: "post",
    targetId: event.id,
  }).limit(100).get().catch(() => ({ data: [] }));
  const commentIds = comments.data.map((item) => item._id);
  await db.collection("posts").doc(event.id).remove();
  await db.collection("comments").where({
    targetType: "post",
    targetId: event.id,
  }).remove().catch(() => {});
  if (commentIds.length) {
    await db.collection("comment_likes").where({ commentId: _.in(commentIds) }).remove().catch(() => {});
  }

  return ok({ removed: 1 });
};

exports.main = async (event) => {
  try {
    switch (event.type) {
      case "add":
        return await addPost(event);
      case "list":
        return await listPosts(event);
      case "weeklyHot":
        return await listWeeklyHotPosts();
      case "detail":
        return await detailPost(event);
      case "like":
        return await likePost(event);
      case "setPinned":
        return await setPinned(event);
      case "delete":
        return await deletePost(event);
      default:
        return fail("未知操作");
    }
  } catch (error) {
    return fail(error.message || "帖子服务异常");
  }
};
