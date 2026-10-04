const fs = require("fs");
const path = require("path");
const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const DEFAULT_SCHOOL_ID = "default-school";
const AVATAR_COUNT = 214;
const LEGACY_AVATAR_COUNT = 8;
const AVATAR_PAGE_SIZE = 24;
const AVATAR_ASSET_VERSION = "v1";
const USER_ROLES = ["user", "outlet_admin", "admin"];
let requiredCollectionsReady = false;

const formatDisplayName = (aliasNo) => `鹏宇用户${String(aliasNo).padStart(4, "0")}`;
const avatarFileName = (avatarId) => `avatar_${String(avatarId).padStart(3, "0")}.png`;
const normalizeAvatarId = (value) => {
  const avatarId = Number(value);
  return Number.isInteger(avatarId) && avatarId >= 1 && avatarId <= AVATAR_COUNT ? avatarId : 0;
};
const fallbackAvatarUrl = (user) => {
  const key = Number(user && user.avatarKey || 1);
  const avatarKey = Number.isInteger(key) && key >= 1 && key <= LEGACY_AVATAR_COUNT ? key : 1;
  return `/images/avatars/avatar-${avatarKey}.svg`;
};
const normalizeRole = (value) => USER_ROLES.includes(value) ? value : "user";

const toPublicUser = (user) => ({
  _id: user._id,
  displayName: formatDisplayName(user.aliasNo),
  aliasNo: user.aliasNo,
  avatarKey: user.avatarKey,
  avatarId: normalizeAvatarId(user.avatarId),
  avatarUrl: user.avatarUrl || fallbackAvatarUrl(user),
  role: normalizeRole(user.role),
  schoolId: user.schoolId || DEFAULT_SCHOOL_ID,
  selectedOutletId: user.selectedOutletId || "",
  managedOutletId: String(user.managedOutletId || "").slice(0, 64),
  defaultAddress: user.defaultAddress || null,
});

const toInteger = (value) => {
  const number = Number(value);
  return Number.isInteger(number) ? number : 0;
};

const isCollectionMissing = (error) => {
  const message = String(error && (error.errMsg || error.message) || error).toLowerCase();
  return message.includes("collection") && (
    message.includes("not exist")
    || message.includes("not_exist")
    || message.includes("does not exist")
  );
};

const getErrorMessage = (error) => String(
  (error && (error.errMsg || error.message)) || error || ""
);

const isCollectionAlreadyExists = (error) => {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("already exists")
    || message.includes("already_exist")
    || message.includes("collection exists")
    || message.includes("resourceinuse");
};

const isNotFound = (error) => {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("not exist")
    || message.includes("not_exist")
    || message.includes("does not exist");
};

const ensureCollection = async (name) => {
  try {
    await db.collection(name).limit(1).get();
    return;
  } catch (error) {
    if (!isCollectionMissing(error)) throw error;
  }

  try {
    await db.createCollection(name);
  } catch (error) {
    if (isCollectionAlreadyExists(error)) return;
    const setupError = new Error(`无法自动创建 ${name} 集合：${getErrorMessage(error)}`);
    setupError.code = `${name.toUpperCase()}_COLLECTION_SETUP_FAILED`;
    throw setupError;
  }
};

const ensureAliasCounter = async () => {
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
};

const ensureRequiredCollections = async () => {
  if (requiredCollectionsReady) return;
  await ensureCollection("users");
  await ensureCollection("counters");
  await ensureCollection("avatar_assets");
  await ensureAliasCounter();
  requiredCollectionsReady = true;
};

const getAvatarAsset = async (avatarId) => {
  const normalizedId = normalizeAvatarId(avatarId);
  if (!normalizedId) throw new Error("头像编号无效");
  const fileName = avatarFileName(normalizedId);
  const documentId = `avatar_${String(normalizedId).padStart(3, "0")}`;
  const assetRef = db.collection("avatar_assets").doc(documentId);

  try {
    const current = (await assetRef.get()).data;
    if (current && current.fileID) {
      return { id: normalizedId, avatarUrl: current.fileID };
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  const localPath = path.join(__dirname, "avatar-assets", fileName);
  if (!fs.existsSync(localPath)) throw new Error(`头像资源缺失：${fileName}`);
  const uploaded = await cloud.uploadFile({
    cloudPath: `system-avatars/${AVATAR_ASSET_VERSION}/${fileName}`,
    fileContent: fs.createReadStream(localPath),
  });
  const data = {
    avatarId: normalizedId,
    fileName,
    fileID: uploaded.fileID,
    version: AVATAR_ASSET_VERSION,
    updatedAt: new Date(),
  };
  await assetRef.set({ data });
  return { id: normalizedId, avatarUrl: uploaded.fileID };
};

const attachAvatarAsset = async (user) => {
  const avatarId = normalizeAvatarId(user.avatarId) || Math.floor(Math.random() * AVATAR_COUNT) + 1;
  const asset = await getAvatarAsset(avatarId);
  if (user.avatarId !== avatarId || user.avatarUrl !== asset.avatarUrl) {
    await db.collection("users").doc(user._id).update({
      data: {
        avatarId,
        avatarUrl: asset.avatarUrl,
        updatedAt: new Date(),
      },
    });
  }
  return { ...user, avatarId, avatarUrl: asset.avatarUrl };
};

const listAvatarAssets = async (event) => {
  const page = Math.max(toInteger(event.page), 1);
  const pageSize = Math.min(Math.max(toInteger(event.pageSize) || AVATAR_PAGE_SIZE, 1), AVATAR_PAGE_SIZE);
  const start = (page - 1) * pageSize + 1;
  if (start > AVATAR_COUNT) return { data: [], page, hasMore: false, total: AVATAR_COUNT };
  const ids = Array.from(
    { length: Math.min(pageSize, AVATAR_COUNT - start + 1) },
    (_, index) => start + index
  );
  const data = [];
  const concurrency = 6;
  for (let index = 0; index < ids.length; index += concurrency) {
    const batch = await Promise.all(ids.slice(index, index + concurrency).map(getAvatarAsset));
    data.push(...batch);
  }
  return { data, page, hasMore: start + ids.length - 1 < AVATAR_COUNT, total: AVATAR_COUNT };
};

const updateAvatar = async (event, user) => {
  const avatarId = normalizeAvatarId(event.avatarId);
  if (!avatarId) throw new Error("请选择有效头像");
  const asset = await getAvatarAsset(avatarId);
  await db.collection("users").doc(user._id).update({
    data: {
      avatarId,
      avatarUrl: asset.avatarUrl,
      updatedAt: new Date(),
    },
  });
  return toPublicUser({ ...user, avatarId, avatarUrl: asset.avatarUrl });
};

const getLoginErrorResult = (error) => {
  const message = getErrorMessage(error).toLowerCase();
  if (error && error.code === "COUNTERS_COLLECTION_SETUP_FAILED") {
    return {
      success: false,
      errCode: "COUNTERS_COLLECTION_MISSING",
      errMsg: "无法自动初始化 counters 集合，请在云数据库中手动创建",
    };
  }
  if (error && error.code === "USERS_COLLECTION_SETUP_FAILED") {
    return {
      success: false,
      errCode: "USERS_COLLECTION_MISSING",
      errMsg: "无法自动初始化 users 集合，请在云数据库中手动创建",
    };
  }
  if (isCollectionMissing(error) && message.includes("counters")) {
    return {
      success: false,
      errCode: "COUNTERS_COLLECTION_MISSING",
      errMsg: "登录初始化未完成：请先在云数据库创建 counters 集合",
    };
  }
  if (isCollectionMissing(error) && message.includes("users")) {
    return {
      success: false,
      errCode: "USERS_COLLECTION_MISSING",
      errMsg: "登录初始化未完成：请先在云数据库创建 users 集合",
    };
  }
  return {
    success: false,
    errCode: "LOGIN_SERVICE_ERROR",
    errMsg: "登录服务异常，请检查 login 云函数日志",
  };
};

const saveDefaultAddress = async (event, openid) => {
  const buildingNo = toInteger(event.buildingNo);
  const floorNo = toInteger(event.floorNo);
  const roomIndex = toInteger(event.roomIndex);
  if (buildingNo < 1 || buildingNo > 16) throw new Error("楼栋必须为1-16号楼");
  if (floorNo < 1 || floorNo > 6) throw new Error("楼层必须为1-6层");
  if (roomIndex < 1 || roomIndex > 39) throw new Error("房间序号必须为1-39");

  const userRes = await db.collection("users").where({ _openid: openid }).limit(1).get();
  const user = userRes.data[0];
  if (!user) throw new Error("请先登录");

  const roomNo = floorNo * 100 + roomIndex;
  const defaultAddress = {
    buildingNo,
    floorNo,
    roomIndex,
    roomNo,
    displayText: `${buildingNo}号楼 ${roomNo}宿舍`,
  };
  let selectedOutletId = user.selectedOutletId || "";
  try {
    const outletRes = await db.collection("outlets").where({
      schoolId: user.schoolId || DEFAULT_SCHOOL_ID,
      buildingNo,
      isActive: true,
    }).limit(1).get();
    selectedOutletId = outletRes.data[0] ? outletRes.data[0]._id : "";
  } catch (error) {
    if (!isCollectionMissing(error)) throw error;
  }

  await db.collection("users").doc(user._id).update({
    data: {
      defaultAddress,
      selectedOutletId,
      updatedAt: new Date(),
    },
  });
  return toPublicUser({ ...user, defaultAddress, selectedOutletId });
};

const nextAliasNo = async (transaction, now) => {
  const counterRef = transaction.collection("counters").doc("user_alias");
  let counterRes;
  try {
    counterRes = await counterRef.get();
  } catch (error) {
    if (!isNotFound(error)) throw error;
    await counterRef.set({ data: { value: 1, createdAt: now, updatedAt: now } });
    return 1;
  }
  const value = Math.max(Number(counterRes.data.value || 0), 0) + 1;
  await counterRef.update({ data: { value, updatedAt: now } });
  return value;
};

const ensureIdentity = async (openid, now = new Date()) => db.runTransaction(async (transaction) => {
    const userRes = await transaction
      .collection("users")
      .where({ _openid: openid })
      .limit(1)
      .get();
    const current = userRes.data[0] || null;
    const aliasNo = current && current.aliasNo ? Number(current.aliasNo) : await nextAliasNo(transaction, now);
    const avatarId = normalizeAvatarId(current && current.avatarId)
      || Math.floor(Math.random() * AVATAR_COUNT) + 1;
    const avatarKey = current && current.avatarKey
      ? Number(current.avatarKey)
      : ((avatarId - 1) % LEGACY_AVATAR_COUNT) + 1;
    const identity = {
      aliasNo,
      displayName: formatDisplayName(aliasNo),
      avatarKey,
      avatarId,
      role: normalizeRole(current && current.role),
      schoolId: (current && current.schoolId) || DEFAULT_SCHOOL_ID,
      selectedOutletId: (current && current.selectedOutletId) || "",
      managedOutletId: String(current && current.managedOutletId || "").slice(0, 64),
      updatedAt: now,
    };

    if (current) {
      await transaction.collection("users").doc(current._id).update({ data: identity });
      return { ...current, ...identity };
    }

    const data = {
      _openid: openid,
      ...identity,
      createdAt: now,
    };
    const addRes = await transaction.collection("users").add({ data });
    return { _id: addRes._id, ...data };
  });

exports.main = async (event = {}) => {
  try {
    const openid = cloud.getWXContext().OPENID;
    if (!openid) throw new Error("无法识别当前用户");
    await ensureRequiredCollections();
    if (event.type === "listAvatars") {
      return { success: true, ...(await listAvatarAssets(event)) };
    }

    const identity = await ensureIdentity(openid);
    if (event.type === "saveAddress") {
      return saveDefaultAddress(event, openid);
    }
    if (event.type === "updateAvatar") {
      return { success: true, user: await updateAvatar(event, identity) };
    }

    const user = await attachAvatarAsset(identity);
    return toPublicUser(user);
  } catch (error) {
    console.error("[login]", {
      type: event.type || "login",
      message: getErrorMessage(error),
      stack: error && error.stack,
    });
    return getLoginErrorResult(error);
  }
};
