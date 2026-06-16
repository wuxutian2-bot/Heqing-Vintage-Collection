const cloud = require("wx-server-sdk");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

exports.main = async (event) => {
  const wxContext = cloud.getWXContext();
  const openid = wxContext.OPENID;
  const now = new Date();

  const userRes = await db.collection("users").where({ _openid: openid }).get();

  if (userRes.data.length === 0) {
    const user = {
      _openid: openid,
      nickName: event.nickName || "微信用户",
      avatarUrl: event.avatarUrl || "",
      phone: "",
      createdAt: now,
      updatedAt: now,
    };
    const addRes = await db.collection("users").add({ data: user });
    return {
      _id: addRes._id,
      ...user,
    };
  }

  const current = userRes.data[0];
  const updates = {
    nickName: event.nickName || current.nickName || "微信用户",
    avatarUrl: event.avatarUrl || current.avatarUrl || "",
    updatedAt: now,
  };
  await db.collection("users").doc(current._id).update({ data: updates });

  return {
    ...current,
    ...updates,
  };
};
