const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const PENDING_MINUTES = 15;
const ORDER_STATUS = ["pending_payment", "paid", "delivering", "completed", "cancelled", "expired", "refunding", "refunded", "payment_exception"];

const ok = (data = {}) => ({ success: true, ...data });
const fail = (errMsg) => ({ success: false, errMsg });
const text = (value, maxLength) => String(value || "").trim().slice(0, maxLength);
const getOpenId = () => cloud.getWXContext().OPENID;
const isCollectionMissing = (error) => String((error && (error.errMsg || error.message)) || error).includes("collection not exists");
const isExpiryTimer = (event) => Boolean(
  event &&
  (event.Type === "Timer" || event.type === "timer") &&
  event.TriggerName === "expire-pending-orders"
);

const publicOrder = (order) => ({
  _id: order._id,
  orderNo: order.orderNo,
  outletId: order.outletId,
  outletName: order.outletName,
  buildingName: order.buildingName,
  items: Array.isArray(order.items) ? order.items : [],
  itemAmountFen: order.itemAmountFen || 0,
  deliveryFeeFen: order.deliveryFeeFen || 0,
  totalAmountFen: order.totalAmountFen || 0,
  status: order.status,
  delivery: order.delivery || {},
  note: order.note || "",
  shippingSyncStatus: order.shippingSyncStatus || "",
  shippingRecordedAt: order.shippingRecordedAt || null,
  expiresAt: order.expiresAt,
  paidAt: order.paidAt || null,
  createdAt: order.createdAt,
  updatedAt: order.updatedAt,
});

const requireUser = async () => {
  const openid = getOpenId();
  if (!openid) throw new Error("请先登录");
  const res = await db.collection("users").where({ _openid: openid }).limit(1).get();
  if (!res.data[0]) throw new Error("请先登录");
  return { ...res.data[0], openid };
};

// 微信订单详情路径会把 ${商品订单号} 替换为支付 out_trade_no，
// 旧版小程序仍把它放在 id 参数里。先兼容数据库 ID，再精确匹配商户订单号。
// 此处只解析引用，调用方必须继续校验订单归属和状态。
const getOrderByReference = async (value) => {
  if (value === undefined || value === null || value === "") throw new Error("缺少订单 ID");
  if (typeof value !== "string" || value.length > 64) throw new Error("订单参数不正确");
  const reference = value.trim();
  if (!reference) throw new Error("缺少订单 ID");

  // where 查询在 ID 不存在时返回空列表，不需要吞掉 doc.get 的数据库异常。
  const byId = await db.collection("orders").where({ _id: reference }).limit(1).get();
  if (byId.data[0]) return byId.data[0];

  const byTradeNo = await db.collection("orders").where({ outTradeNo: reference }).limit(2).get();
  // 即使环境中漏建了唯一索引，也不能在重复单号中随意选择一笔。
  return byTradeNo.data.length === 1 ? byTradeNo.data[0] : null;
};

const releaseOrderStock = async (orderId, targetStatus) => db.runTransaction(async (transaction) => {
  const orderRef = transaction.collection("orders").doc(orderId);
  const orderRes = await orderRef.get();
  const order = orderRes.data;
  if (!order || order.stockReleased || order.status !== "pending_payment") return false;
  for (const item of order.items || []) {
    const productRef = transaction.collection("store_products").doc(item.productId);
    const productRes = await productRef.get();
    if (productRes.data) {
      await productRef.update({
        data: {
          stock: Number(productRes.data.stock || 0) + Number(item.quantity || 0),
          updatedAt: new Date(),
        },
      });
    }
  }
  await orderRef.update({
    data: {
      status: targetStatus,
      stockReleased: true,
      updatedAt: new Date(),
    },
  });
  return true;
});

const expirePendingOrders = async () => {
  let expired;
  try {
    expired = await db.collection("orders").where({
      status: "pending_payment",
      expiresAt: _.lt(new Date()),
      stockReleased: false,
    }).limit(20).get();
  } catch (error) {
    if (isCollectionMissing(error)) return 0;
    throw error;
  }
  let count = 0;
  for (const order of expired.data) {
    if (await releaseOrderStock(order._id, "expired")) count += 1;
  }
  return count;
};

const createOrder = async (event) => {
  const user = await requireUser();
  await expirePendingOrders();
  const outletId = text(event.outletId, 64);
  const phone = text(event.phone, 20).replace(/[^0-9+\-]/g, "");
  const note = text(event.note, 120);
  const rawItems = Array.isArray(event.items) ? event.items.slice(0, 20) : [];
  const savedAddress = user.defaultAddress || {};
  const buildingNo = Number(savedAddress.buildingNo);
  const floorNo = Number(savedAddress.floorNo);
  const roomIndex = Number(savedAddress.roomIndex);
  const addressValid = Number.isInteger(buildingNo) && buildingNo >= 1 && buildingNo <= 16
    && Number.isInteger(floorNo) && floorNo >= 1 && floorNo <= 6
    && Number.isInteger(roomIndex) && roomIndex >= 1 && roomIndex <= 39;
  if (!outletId || !rawItems.length) return fail("购物车为空");
  if (!addressValid) return fail("请先设置默认宿舍地址");
  if (!/^1\d{10}$/.test(phone)) return fail("请填写正确的手机号");
  const roomNo = floorNo * 100 + roomIndex;
  const addressDisplayText = `${buildingNo}号楼 ${roomNo}宿舍`;

  const quantities = new Map();
  rawItems.forEach((item) => {
    const productId = text(item.productId, 64);
    const quantity = Number(item.quantity);
    if (productId && Number.isInteger(quantity) && quantity > 0 && quantity <= 99) {
      quantities.set(productId, (quantities.get(productId) || 0) + quantity);
    }
  });
  if (!quantities.size || Array.from(quantities.values()).some((quantity) => quantity > 99)) {
    return fail("商品数量不合法");
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + PENDING_MINUTES * 60 * 1000);
  const orderNo = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}${crypto.randomBytes(5).toString("hex")}`;

  return db.runTransaction(async (transaction) => {
    const outletRes = await transaction.collection("outlets").doc(outletId).get();
    const outlet = outletRes.data;
    if (!outlet || outlet.isActive === false) throw new Error("代售点暂停营业");
    if (Number(outlet.buildingNo) !== buildingNo) throw new Error("购物车商品与默认宿舍楼不一致");

    const items = [];
    let itemAmountFen = 0;
    for (const [productId, quantity] of quantities.entries()) {
      const productRef = transaction.collection("store_products").doc(productId);
      const productRes = await productRef.get();
      const product = productRes.data;
      if (!product || product.outletId !== outletId || product.status !== "on_sale") {
        throw new Error("购物车中有商品已下架");
      }
      if (Number(product.stock || 0) < quantity) throw new Error(`${product.title} 库存不足`);
      const priceFen = Number(product.priceFen || 0);
      if (!Number.isInteger(priceFen) || priceFen <= 0) throw new Error("商品价格异常");
      itemAmountFen += priceFen * quantity;
      items.push({
        productId,
        title: product.title,
        image: product.image || "/images/default-goods-image.png",
        priceFen,
        quantity,
      });
    }

    const minimumOrderFen = Number(outlet.minimumOrderFen || 0);
    if (itemAmountFen < minimumOrderFen) {
      throw new Error(`未达到起送金额 ¥${(minimumOrderFen / 100).toFixed(2)}`);
    }

    for (const item of items) {
      const productRef = transaction.collection("store_products").doc(item.productId);
      const productRes = await productRef.get();
      await productRef.update({
        data: {
          stock: Number(productRes.data.stock || 0) - item.quantity,
          updatedAt: now,
        },
      });
    }

    const deliveryFeeFen = Number(outlet.deliveryFeeFen || 0);
    const totalAmountFen = itemAmountFen + deliveryFeeFen;
    const data = {
      orderNo,
      outTradeNo: `PY${orderNo}`,
      buyerUserId: user._id,
      buyerOpenId: user.openid,
      outletId,
      outletName: outlet.name,
      buildingName: outlet.buildingName,
      items,
      itemAmountFen,
      deliveryFeeFen,
      totalAmountFen,
      status: "pending_payment",
      delivery: {
        buildingNo,
        floorNo,
        roomIndex,
        roomNo,
        displayText: addressDisplayText,
        buildingName: outlet.buildingName,
        room: `${roomNo}宿舍`,
        phone,
      },
      note,
      stockReleased: false,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    };
    const addRes = await transaction.collection("orders").add({ data });
    return ok({ data: publicOrder({ _id: addRes._id, ...data }) });
  });
};

const listOrders = async (event) => {
  const user = await requireUser();
  await expirePendingOrders();
  const where = { buyerUserId: user._id };
  if (ORDER_STATUS.includes(event.status)) where.status = event.status;
  const res = await db.collection("orders").where(where).orderBy("createdAt", "desc").limit(100).get();
  return ok({ data: res.data.map(publicOrder) });
};

const detailOrder = async (event) => {
  const user = await requireUser();
  await expirePendingOrders();
  const order = await getOrderByReference(event.id);
  if (!order || (order.buyerUserId !== user._id && user.role !== "admin")) return fail("订单不存在");
  return ok({ data: publicOrder(order) });
};

const preparePayment = async (event) => {
  const user = await requireUser();
  await expirePendingOrders();
  const order = await getOrderByReference(event.id);
  if (!order || order.buyerUserId !== user._id) return fail("订单不存在");
  if (order.status !== "pending_payment" || new Date(order.expiresAt).getTime() <= Date.now()) {
    return fail("订单已失效，请重新下单");
  }
  return ok({
    data: {
      outTradeNo: order.outTradeNo,
      description: `${order.outletName}商品`,
      totalAmountFen: order.totalAmountFen,
    },
  });
};

const adminListOrders = async (event) => {
  const user = await requireUser();
  if (user.role !== "admin") return fail("无管理员权限");
  await expirePendingOrders();
  const where = {};
  if (ORDER_STATUS.includes(event.status)) where.status = event.status;
  const outletId = text(event.outletId, 64);
  if (outletId) where.outletId = outletId;
  const res = await db.collection("orders").where(where).orderBy("createdAt", "desc").limit(100).get();
  return ok({ data: res.data.map(publicOrder) });
};

const adminUpdateStatus = async (event) => {
  const user = await requireUser();
  if (user.role !== "admin") return fail("无管理员权限");
  const id = text(event.id, 64);
  const targetStatus = text(event.status, 30);
  if (!id) return fail("缺少订单 ID");
  const transitions = { paid: "delivering", delivering: "completed" };
  const result = await db.runTransaction(async (transaction) => {
    const ref = transaction.collection("orders").doc(id);
    const res = await ref.get();
    const order = res.data;
    if (!order) throw new Error("订单不存在");
    if (transitions[order.status] !== targetStatus) throw new Error("当前订单不能执行此操作");
    if (targetStatus === "completed" && !["manual_recorded", "synced"].includes(order.shippingSyncStatus)) {
      throw new Error("请先确认微信发货信息已录入");
    }
    const now = new Date();
    const data = { status: targetStatus, updatedAt: now };
    if (targetStatus === "delivering") {
      data.deliveringAt = now;
      data.shippingSyncStatus = "manual_required";
    }
    if (targetStatus === "completed") data.completedAt = now;
    await ref.update({ data });
    return { ...order, ...data };
  });
  return ok({ data: publicOrder(result) });
};

const adminConfirmShipping = async (event) => {
  const user = await requireUser();
  if (user.role !== "admin") return fail("无管理员权限");
  const id = text(event.id, 64);
  if (!id) return fail("缺少订单 ID");
  const result = await db.runTransaction(async (transaction) => {
    const ref = transaction.collection("orders").doc(id);
    const res = await ref.get();
    const order = res.data;
    if (!order || order.status !== "delivering") throw new Error("当前订单不能确认发货录入");
    if (["manual_recorded", "synced"].includes(order.shippingSyncStatus)) return order;
    const now = new Date();
    const data = { shippingSyncStatus: "manual_recorded", shippingRecordedAt: now, updatedAt: now };
    await ref.update({ data });
    return { ...order, ...data };
  });
  return ok({ data: publicOrder(result) });
};

const cancelOrder = async (event) => {
  const user = await requireUser();
  const order = await getOrderByReference(event.id);
  if (!order || order.buyerUserId !== user._id) return fail("订单不存在");
  if (order.status !== "pending_payment") return fail("当前订单不能取消");
  const cancelled = await releaseOrderStock(order._id, "cancelled");
  if (!cancelled) return fail("订单状态已变化，请刷新后重试");
  return ok({ id: order._id, status: "cancelled" });
};

exports.main = async (event = {}) => {
  try {
    if (isExpiryTimer(event)) {
      return ok({ count: await expirePendingOrders() });
    }
    switch (event.type) {
      case "create":
        return await createOrder(event);
      case "list":
        return await listOrders(event);
      case "detail":
        return await detailOrder(event);
      case "preparePayment":
        return await preparePayment(event);
      case "cancel":
        return await cancelOrder(event);
      case "adminList":
        return await adminListOrders(event);
      case "adminUpdateStatus":
        return await adminUpdateStatus(event);
      case "adminConfirmShipping":
        return await adminConfirmShipping(event);
      case "expirePending":
        await requireUser();
        return ok({ count: await expirePendingOrders() });
      default:
        return fail("未知操作");
    }
  } catch (error) {
    return fail(error.message || "订单服务异常");
  }
};
