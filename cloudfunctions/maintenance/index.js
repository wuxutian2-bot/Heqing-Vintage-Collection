const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const DEFAULT_SCHOOL_ID = "default-school";
const LEGACY_AVATAR_COUNT = 8;
const AVATAR_COUNT = 214;
const PAGE_SIZE_MAX = 50;
const COLLECTIONS = ["users", "goods", "posts", "comments"];
const LEGACY_CATEGORY_MAP = {
  生活: "生活用品",
  服饰: "服饰鞋包",
  运动: "运动健身",
};

const ok = (data = {}) => ({ success: true, ...data });
const fail = (errMsg) => ({ success: false, errMsg });
const getOpenId = () => cloud.getWXContext().OPENID;
const formatDisplayName = (aliasNo) => `鹏宇用户${String(aliasNo).padStart(4, "0")}`;

const requireAdmin = async () => {
  const openid = getOpenId();
  if (!openid) throw new Error("请先登录");
  const res = await db.collection("users").where({ _openid: openid }).limit(1).get();
  if (!res.data[0] || res.data[0].role !== "admin") {
    throw new Error("无管理员权限");
  }
  return res.data[0];
};

const isNotFound = (error) => {
  const message = String(error && (error.errMsg || error.message) || error).toLowerCase();
  return message.includes("not exist") || message.includes("not_exist") || message.includes("does not exist");
};

const findDocumentAuthor = async (document) => {
  const userId = String(document.authorId || document.userId || "");
  if (userId) {
    try {
      const res = await db.collection("users").doc(userId).get();
      if (res.data) return res.data;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  if (!document._openid) return null;
  const res = await db.collection("users").where({ _openid: document._openid }).limit(1).get();
  return res.data[0] || null;
};

const authorSnapshot = (user) => user ? {
  authorId: user._id,
  authorAliasNo: Number(user.aliasNo || 0),
  authorDisplayName: formatDisplayName(Number(user.aliasNo || 0)),
  authorAvatarKey: Number(user.avatarKey || 1),
  authorAvatarUrl: user.avatarUrl || "",
} : {};

const initializeAliasCounter = async () => {
  const maxRes = await db
    .collection("users")
    .where({ aliasNo: _.exists(true) })
    .orderBy("aliasNo", "desc")
    .limit(1)
    .get();
  const maxAliasNo = Math.max(Number(maxRes.data[0] && maxRes.data[0].aliasNo || 0), 0);
  const now = new Date();

  await db.runTransaction(async (transaction) => {
    const counterRef = transaction.collection("counters").doc("user_alias");
    let counter;
    try {
      counter = (await counterRef.get()).data;
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await counterRef.set({
        data: { value: maxAliasNo, createdAt: now, updatedAt: now },
      });
      return;
    }
    if (Number(counter.value || 0) < maxAliasNo) {
      await counterRef.update({ data: { value: maxAliasNo, updatedAt: now } });
    }
  });

  return maxAliasNo;
};

const migrateUser = async (userId) => db.runTransaction(async (transaction) => {
  const userRef = transaction.collection("users").doc(userId);
  const current = (await userRef.get()).data;
  if (!current) return false;

  const now = new Date();
  let aliasNo = Math.max(Number(current.aliasNo || 0), 0);
  if (!aliasNo) {
    const counterRef = transaction.collection("counters").doc("user_alias");
    const counter = (await counterRef.get()).data;
    aliasNo = Math.max(Number(counter.value || 0), 0) + 1;
    await counterRef.update({ data: { value: aliasNo, updatedAt: now } });
  }

  const avatarKey = Number(current.avatarKey || 0) >= 1 && Number(current.avatarKey || 0) <= LEGACY_AVATAR_COUNT
    ? Number(current.avatarKey)
    : Math.floor(Math.random() * LEGACY_AVATAR_COUNT) + 1;
  const avatarId = Number(current.avatarId || 0) >= 1 && Number(current.avatarId || 0) <= AVATAR_COUNT
    ? Number(current.avatarId)
    : Math.floor(Math.random() * AVATAR_COUNT) + 1;
  await userRef.update({
    data: {
      aliasNo,
      displayName: formatDisplayName(aliasNo),
      avatarKey,
      avatarId,
      role: current.role || "user",
      schoolId: current.schoolId || DEFAULT_SCHOOL_ID,
      selectedOutletId: current.selectedOutletId || "",
      managedOutletId: String(current.managedOutletId || "").slice(0, 64),
      nickName: _.remove(),
      updatedAt: now,
    },
  });
  return true;
});

const migrateDocument = async (collection, document) => {
  const now = new Date();
  if (collection === "users") return migrateUser(document._id);
  if (collection === "goods") {
    const author = await findDocumentAuthor(document);
    await db.collection("goods").doc(document._id).update({
      data: {
        ...authorSnapshot(author),
        category: LEGACY_CATEGORY_MAP[document.category] || document.category || "其他",
        viewCount: Math.max(Number(document.viewCount || 0), 0),
        status: document.status || "on_sale",
        contact: _.remove(),
        updatedAt: document.updatedAt || now,
      },
    });
    return true;
  }
  if (collection === "posts") {
    const author = await findDocumentAuthor(document);
    await db.collection("posts").doc(document._id).update({
      data: {
        ...authorSnapshot(author),
        category: document.category || "校园动态",
        likeCount: Math.max(Number(document.likeCount || 0), 0),
        commentCount: Math.max(Number(document.commentCount || 0), 0),
        viewCount: Math.max(Number(document.viewCount || 0), 0),
        isPinned: document.isPinned === true,
        pinnedAt: document.isPinned === true ? document.pinnedAt || now : null,
        pinnedBy: document.isPinned === true ? document.pinnedBy || "" : "",
        updatedAt: document.updatedAt || now,
      },
    });
    return true;
  }
  if (collection === "comments") {
    const author = await findDocumentAuthor(document);
    const snapshot = authorSnapshot(author);
    await db.collection("comments").doc(document._id).update({
      data: {
        ...(author ? {
          userId: snapshot.authorId,
          aliasNo: snapshot.authorAliasNo,
          displayName: snapshot.authorDisplayName,
          avatarKey: snapshot.authorAvatarKey,
          avatarUrl: snapshot.authorAvatarUrl,
        } : {}),
        parentId: String(document.parentId || ""),
        replyToCommentId: String(document.replyToCommentId || ""),
        likeCount: Math.max(Number(document.likeCount || 0), 0),
      },
    });
    return true;
  }
  return false;
};

const migrate = async (event) => {
  const collection = String(event.collection || "");
  if (!COLLECTIONS.includes(collection)) return fail("不支持该集合");
  const cursor = String(event.cursor || "");
  const pageSize = Math.min(Math.max(Number(event.pageSize || 20), 1), PAGE_SIZE_MAX);

  if (collection === "users") await initializeAliasCounter();

  let query = db.collection(collection).orderBy("_id", "asc");
  if (cursor) query = db.collection(collection).where({ _id: _.gt(cursor) }).orderBy("_id", "asc");
  const res = await query.limit(pageSize).get();
  let migrated = 0;
  for (const document of res.data) {
    if (await migrateDocument(collection, document)) migrated += 1;
  }
  const nextCursor = res.data.length ? res.data[res.data.length - 1]._id : cursor;
  return ok({
    collection,
    migrated,
    nextCursor,
    hasMore: res.data.length === pageSize,
  });
};

exports.main = async (event = {}) => {
  try {
    await requireAdmin();
    switch (event.type) {
      case "initializeAliasCounter":
        return ok({ maxAliasNo: await initializeAliasCounter() });
      case "migrate":
        return await migrate(event);
      default:
        return fail("未知操作");
    }
  } catch (error) {
    return fail(error.message || "维护服务异常");
  }
};
