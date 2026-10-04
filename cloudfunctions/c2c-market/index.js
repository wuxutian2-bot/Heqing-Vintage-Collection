/**
 * C2C 闲置市场的受控结算订单域。
 *
 * 这不是“钱包”实现：买方支付成功前不产生卖方资产；付款、退款只能由
 * 微信支付服务端回调更新；卖方提现适配器默认关闭，不能由前端提交金额、
 * openid 或转账场景。
 */
const cloud = require("wx-server-sdk");
const crypto = require("crypto");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = Object.freeze({
  users: "users",
  goods: "goods",
  orders: "market_c2c_orders",
  ledger: "market_c2c_ledger",
  idempotency: "market_c2c_idempotency",
  disputes: "market_c2c_disputes",
  payouts: "market_c2c_payouts",
  config: "market_c2c_config",
  audit: "market_c2c_audit",
});

const ORDER_TTL_MS = 15 * 60 * 1000;
const TERMINAL_GOODS_STATES = new Set(["cancelled", "expired"]);
const ACTIVE_DISPUTE_STATES = new Set(["open", "under_review"]);
const DEFAULT_POLICY = Object.freeze({
  checkoutEnabled: false,
  payoutEnabled: false,
  feeRuleVersion: "fee-disabled-v1",
  feeRateBps: 0,
  minFeeFen: 0,
  maxFeeFen: 0,
});

class BusinessError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const ok = (data = {}) => ({ success: true, data });
const fail = (errMsg, errorCode = "C2C_MARKET_ERROR") => ({ success: false, errMsg, errorCode });
const ensure = (condition, code, message) => {
  if (!condition) throw new BusinessError(code, message);
};
const getOpenId = () => cloud.getWXContext().OPENID;
const nowId = (prefix) => `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(7).toString("hex")}`;
const asText = (value, field, max = 200, required = false) => {
  const text = typeof value === "string" ? value.trim() : "";
  ensure(!required || Boolean(text), "INVALID_INPUT", `${field}不能为空`);
  ensure(text.length <= max, "INVALID_INPUT", `${field}过长`);
  return text;
};
const asId = (value, field) => {
  const result = asText(value, field, 128, true);
  ensure(/^[A-Za-z0-9_-]+$/.test(result), "INVALID_INPUT", `${field}格式不正确`);
  return result;
};
const asRequestId = (value) => {
  const result = asText(value, "幂等请求标识", 96, true);
  ensure(/^[A-Za-z0-9_-]+$/.test(result), "INVALID_INPUT", "幂等请求标识格式不正确");
  return result;
};
const hash = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const errorText = (error) => String((error && (error.errMsg || error.message)) || error || "");
// 云开发对不存在文档的报错会随运行时版本变化，例如：
// "document.get:fail document with _id xxx does not exist"。首次读取幂等记录
// 时这属于正常的空记录，不能将其升级为内部错误。
const isNotFound = (error) => /document(?:\.get)?\s*:?.*(?:not exist|does not exist)|not found/i.test(errorText(error));
const isMissingCollection = (error) => /collection not exists/i.test(errorText(error));

const readOptional = async (reference) => {
  try {
    const result = await reference.get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
};

// CloudBase 的 doc(id).set() 已经由路径指定文档 ID；data 中重复携带 _id
// 会被服务端拒绝（invalid parameters: 不能更新_id的值）。
const withoutDocumentId = (record) => {
  const { _id, ...data } = record;
  return data;
};

// 同一笔请求的结果会保存在幂等记录中。CloudBase 连嵌套对象里的 `_id`
// 也视为保留字段，因此写入前编码、读回时再还原；客户端始终得到原始 `_id`。
const IDEMPOTENCY_ID_KEY = "__c2cStoredDocumentId";
const encodeIdempotencyResponse = (value) => {
  if (value instanceof Date || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(encodeIdempotencyResponse);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key === "_id" ? IDEMPOTENCY_ID_KEY : key,
    encodeIdempotencyResponse(item),
  ]));
};
const decodeIdempotencyResponse = (value) => {
  if (value instanceof Date || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeIdempotencyResponse);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key === IDEMPOTENCY_ID_KEY ? "_id" : key,
    decodeIdempotencyResponse(item),
  ]));
};

const requireUser = async () => {
  const openid = getOpenId();
  ensure(Boolean(openid), "UNAUTHENTICATED", "请先登录");
  const result = await db.collection(COLLECTIONS.users).where({ _openid: openid }).limit(2).get();
  ensure(result.data.length === 1, "UNAUTHENTICATED", "请先登录");
  return { ...result.data[0], openid };
};

const requireAdmin = async () => {
  const user = await requireUser();
  ensure(user.role === "admin", "FORBIDDEN", "无管理员权限");
  return user;
};

const displayName = (user) => {
  const aliasNo = Number(user && user.aliasNo || 0);
  return Number.isInteger(aliasNo) && aliasNo > 0
    ? `鹏宇用户${String(aliasNo).padStart(4, "0")}`
    : "校园用户";
};

const validImages = (images) => (Array.isArray(images) ? images : [])
  .filter((item) => typeof item === "string")
  .map((item) => item.trim())
  .filter((item) => item.startsWith("cloud://") || /^https:\/\//i.test(item))
  .slice(0, 9);

const snapshotGoods = (goods) => {
  const price = Number(goods.price);
  ensure(Number.isFinite(price) && price > 0, "INVALID_GOODS", "商品价格不正确");
  const priceFen = Math.round(price * 100);
  ensure(Number.isSafeInteger(priceFen) && priceFen > 0 && priceFen <= 100000000, "INVALID_GOODS", "商品价格不正确");
  return {
    title: asText(goods.title, "商品名称", 60, true),
    description: asText(goods.desc, "商品描述", 1000, false),
    category: asText(goods.category, "商品分类", 30, false) || "其他",
    images: validImages(goods.images),
    priceFen,
  };
};

const normalisePolicy = (source) => {
  const policy = source && typeof source === "object" ? source : {};
  const feeRateBps = Number(policy.feeRateBps);
  const minFeeFen = Number(policy.minFeeFen);
  const maxFeeFen = Number(policy.maxFeeFen);
  const safeInteger = (value, min, max, fallback) => Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback;
  const normalized = {
    checkoutEnabled: policy.checkoutEnabled === true,
    payoutEnabled: policy.payoutEnabled === true,
    feeRuleVersion: asText(policy.feeRuleVersion, "服务费规则版本", 60, false) || DEFAULT_POLICY.feeRuleVersion,
    feeRateBps: safeInteger(feeRateBps, 0, 10000, 0),
    minFeeFen: safeInteger(minFeeFen, 0, 100000000, 0),
    maxFeeFen: safeInteger(maxFeeFen, 0, 100000000, 0),
  };
  if (normalized.maxFeeFen > 0 && normalized.maxFeeFen < normalized.minFeeFen) normalized.maxFeeFen = normalized.minFeeFen;
  return normalized;
};

const readPolicy = async () => {
  try {
    const stored = await readOptional(db.collection(COLLECTIONS.config).doc("settlement"));
    return normalisePolicy(stored || DEFAULT_POLICY);
  } catch (error) {
    if (isMissingCollection(error)) return { ...DEFAULT_POLICY };
    throw error;
  }
};

const publicPolicy = (policy) => ({
  checkoutEnabled: policy.checkoutEnabled,
  payoutEnabled: policy.payoutEnabled,
  feeRuleVersion: policy.feeRuleVersion,
  // 仅展示规则，不展示商户号、收款方、证书或其他资金配置。
  feeRateBps: policy.feeRateBps,
});

const calculateFee = (amountFen, policy) => {
  let feeAmountFen = Math.floor(amountFen * policy.feeRateBps / 10000);
  if (policy.feeRateBps > 0) feeAmountFen = Math.max(feeAmountFen, policy.minFeeFen);
  if (policy.maxFeeFen > 0) feeAmountFen = Math.min(feeAmountFen, policy.maxFeeFen);
  feeAmountFen = Math.max(0, Math.min(feeAmountFen, amountFen - 1));
  return { feeAmountFen, sellerAmountFen: amountFen - feeAmountFen };
};

const publicOrder = (order, role) => {
  const snapshot = order.goodsSnapshot || {};
  const isBuyer = role === "buyer";
  return {
    _id: order._id,
    orderNo: order.orderNo,
    outTradeNo: isBuyer ? order.outTradeNo : "",
    role,
    status: order.status,
    settlementStatus: order.settlementStatus || "not_available",
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    expiresAt: order.expiresAt,
    paidAt: order.paidAt || null,
    deliveredAt: order.deliveredAt || null,
    confirmedAt: order.confirmedAt || null,
    totalAmountFen: Number(order.totalAmountFen || 0),
    feeAmountFen: Number(order.feeAmountFen || 0),
    sellerAmountFen: Number(order.sellerAmountFen || 0),
    feeRuleVersion: order.feeRuleVersion || "",
    goodsSnapshot: {
      title: snapshot.title || "闲置商品",
      category: snapshot.category || "其他",
      images: validImages(snapshot.images),
      priceFen: Number(snapshot.priceFen || order.totalAmountFen || 0),
    },
    counterpart: isBuyer
      ? { displayName: order.sellerDisplayName || "校园卖家" }
      : { displayName: order.buyerDisplayName || "校园买家" },
    deliveryNote: role === "buyer" || role === "seller" ? (order.deliveryNote || "") : "",
    disputeId: order.disputeId || "",
    payoutStatus: order.payoutStatus || "not_requested",
  };
};

const findRole = (order, user) => {
  if (order.buyerUserId === user._id) return "buyer";
  if (order.sellerUserId === user._id) return "seller";
  if (user.role === "admin") return "admin";
  return "";
};

const writeAudit = async (transaction, actor, action, targetId, now, details = {}) => {
  const auditId = `${targetId}_${action}_${now.getTime()}_${crypto.randomBytes(3).toString("hex")}`;
  await transaction.collection(COLLECTIONS.audit).doc(auditId).set({ data: {
    actorUserId: actor._id,
    actorRole: actor.role || "user",
    action,
    targetId,
    amountFen: Number(details.amountFen || 0),
    status: details.status || "",
    createdAt: now,
  } });
};

const runIdempotent = async ({ actor, action, requestId, payload }, operation) => {
  const recordId = crypto.createHash("sha256").update(`${actor._id}:${action}:${requestId}`).digest("hex");
  const inputHash = hash(payload);
  return db.runTransaction(async (transaction) => {
    const idemRef = transaction.collection(COLLECTIONS.idempotency).doc(recordId);
    const existing = await readOptional(idemRef);
    if (existing) {
      ensure(existing.actorUserId === actor._id && existing.action === action && existing.inputHash === inputHash,
        "IDEMPOTENCY_CONFLICT", "该幂等标识已用于不同请求");
      return decodeIdempotencyResponse(existing.response);
    }
    const response = await operation(transaction, new Date());
    await idemRef.set({ data: {
      actorUserId: actor._id,
      action,
      requestId,
      inputHash,
      response: encodeIdempotencyResponse(response),
      createdAt: new Date(),
    } });
    return response;
  });
};

const releaseGoodsLock = async (transaction, order, now, tradeStatus) => {
  const goodsRef = transaction.collection(COLLECTIONS.goods).doc(order.goodsId);
  const goods = await readOptional(goodsRef);
  if (goods && goods.c2cOrderId === order._id && goods.status === "locked") {
    await goodsRef.update({ data: {
      status: "on_sale",
      c2cOrderId: "",
      c2cTradeStatus: tradeStatus,
      c2cLockExpiresAt: null,
      updatedAt: now,
    } });
  }
};

const getOrderForUser = async (user, value) => {
  const orderId = asId(value, "订单ID");
  const order = await readOptional(db.collection(COLLECTIONS.orders).doc(orderId));
  ensure(Boolean(order), "ORDER_NOT_FOUND", "交易订单不存在");
  const role = findRole(order, user);
  ensure(Boolean(role), "FORBIDDEN", "无权查看该交易订单");
  return { order, role };
};

const createOrder = async (event) => {
  const buyer = await requireUser();
  const policy = await readPolicy();
  ensure(policy.checkoutEnabled, "C2C_CHECKOUT_DISABLED", "平台担保交易暂未开放");
  const goodsId = asId(event.goodsId, "商品ID");
  const requestId = asRequestId(event.requestId || event.idempotencyKey);
  return runIdempotent({ actor: buyer, action: "createOrder", requestId, payload: { goodsId } }, async (transaction, now) => {
    const goodsRef = transaction.collection(COLLECTIONS.goods).doc(goodsId);
    const goods = await readOptional(goodsRef);
    ensure(Boolean(goods), "GOODS_NOT_FOUND", "商品不存在");
    ensure(goods.platformOwned !== true, "INVALID_GOODS", "平台出售商品请使用平台订单购买");
    ensure(goods.category !== "求购", "INVALID_GOODS", "求购信息不能创建交易订单");
    ensure(goods.status === "on_sale" && !goods.c2cOrderId, "GOODS_UNAVAILABLE", "商品已被锁定、下架或售出");
    const legacySellerUserId = goods.authorId || goods.userId || "";
    ensure(legacySellerUserId !== buyer._id && goods._openid !== buyer.openid, "INVALID_GOODS", "不能购买自己发布的商品");
    let seller = null;
    if (legacySellerUserId) {
      const sellerResult = await transaction.collection(COLLECTIONS.users).doc(legacySellerUserId).get();
      seller = sellerResult && sellerResult.data;
    } else if (goods._openid) {
      const sellerResult = await transaction.collection(COLLECTIONS.users).where({ _openid: goods._openid }).limit(2).get();
      seller = sellerResult.data.length === 1 ? sellerResult.data[0] : null;
    }
    ensure(Boolean(seller), "INVALID_GOODS", "商品发布者不存在");

    const goodsSnapshot = snapshotGoods(goods);
    const amounts = calculateFee(goodsSnapshot.priceFen, policy);
    const orderId = nowId("c2c");
    const expiresAt = new Date(now.getTime() + ORDER_TTL_MS);
    const order = {
      _id: orderId,
      orderNo: orderId.slice(-16).toUpperCase(),
      outTradeNo: `C2C${now.getTime()}${crypto.randomBytes(4).toString("hex").toUpperCase()}`.slice(0, 32),
      goodsId,
      goodsSnapshot,
      buyerUserId: buyer._id,
      buyerOpenId: buyer.openid,
      buyerDisplayName: displayName(buyer),
      sellerUserId: seller._id,
      sellerOpenId: seller._openid || "",
      sellerDisplayName: displayName(seller),
      totalAmountFen: goodsSnapshot.priceFen,
      feeAmountFen: amounts.feeAmountFen,
      sellerAmountFen: amounts.sellerAmountFen,
      feeRuleVersion: policy.feeRuleVersion,
      status: "pending_payment",
      settlementStatus: "not_available",
      payoutStatus: "not_requested",
      paymentStatus: "not_started",
      createdAt: now,
      updatedAt: now,
      expiresAt,
      version: 1,
    };
    await transaction.collection(COLLECTIONS.orders).doc(orderId).set({ data: withoutDocumentId(order) });
    await goodsRef.update({ data: {
      status: "locked",
      c2cOrderId: orderId,
      c2cTradeStatus: "pending_payment",
      c2cLockExpiresAt: expiresAt,
      updatedAt: now,
    } });
    await writeAudit(transaction, buyer, "c2c_order_created", orderId, now, { status: order.status, amountFen: order.totalAmountFen });
    return { created: true, order: publicOrder(order, "buyer") };
  });
};

const getOrder = async (event) => {
  const user = await requireUser();
  const { order, role } = await getOrderForUser(user, event.id || event.orderId);
  return { order: publicOrder(order, role) };
};

const listOrders = async (event) => {
  const user = await requireUser();
  const page = Math.max(1, Math.min(Number(event.page) || 1, 10000));
  const pageSize = Math.max(1, Math.min(Number(event.pageSize) || 20, 50));
  const status = event.status ? asText(event.status, "订单状态", 40, true) : "";
  const buyerWhere = { buyerUserId: user._id };
  const sellerWhere = { sellerUserId: user._id };
  if (status) { buyerWhere.status = status; sellerWhere.status = status; }
  const [buyerResult, sellerResult] = await Promise.all([
    db.collection(COLLECTIONS.orders).where(buyerWhere).orderBy("createdAt", "desc").skip((page - 1) * pageSize).limit(pageSize).get(),
    db.collection(COLLECTIONS.orders).where(sellerWhere).orderBy("createdAt", "desc").skip((page - 1) * pageSize).limit(pageSize).get(),
  ]);
  const items = [];
  const seen = new Set();
  buyerResult.data.forEach((order) => { if (!seen.has(order._id)) { seen.add(order._id); items.push(publicOrder(order, "buyer")); } });
  sellerResult.data.forEach((order) => { if (!seen.has(order._id)) { seen.add(order._id); items.push(publicOrder(order, "seller")); } });
  items.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return { items, page, pageSize, hasMore: buyerResult.data.length === pageSize || sellerResult.data.length === pageSize };
};

const preparePayment = async (event) => {
  const buyer = await requireUser();
  const policy = await readPolicy();
  ensure(policy.checkoutEnabled, "C2C_CHECKOUT_DISABLED", "平台担保交易暂未开放");
  const { order, role } = await getOrderForUser(buyer, event.id || event.orderId);
  ensure(role === "buyer", "FORBIDDEN", "仅买家可以支付");
  ensure(order.status === "pending_payment", "INVALID_STATE", "当前订单不可支付");
  ensure(new Date(order.expiresAt).getTime() > Date.now(), "ORDER_EXPIRED", "订单已超时，请重新下单");
  return { order: {
    orderId: order._id,
    outTradeNo: order.outTradeNo,
    description: `校园闲置 · ${(order.goodsSnapshot && order.goodsSnapshot.title) || "商品"}`.slice(0, 127),
    totalAmountFen: Number(order.totalAmountFen),
    expiresAt: order.expiresAt,
  } };
};

const cancelOrder = async (event) => {
  const buyer = await requireUser();
  const orderId = asId(event.id || event.orderId, "订单ID");
  const requestId = asRequestId(event.requestId || event.idempotencyKey);
  return runIdempotent({ actor: buyer, action: "cancelOrder", requestId, payload: { orderId } }, async (transaction, now) => {
    const ref = transaction.collection(COLLECTIONS.orders).doc(orderId);
    const current = await readOptional(ref);
    ensure(current && current.buyerUserId === buyer._id, "ORDER_NOT_FOUND", "交易订单不存在");
    ensure(current.status === "pending_payment", "INVALID_STATE", "当前订单不能取消");
    ensure(!current.paymentRequestedAt, "PAYMENT_IN_PROGRESS", "支付已发起，请在支付结果确认后处理");
    await releaseGoodsLock(transaction, current, now, "cancelled");
    await ref.update({ data: { status: "cancelled", settlementStatus: "not_available", cancelledAt: now, updatedAt: now, version: Number(current.version || 0) + 1 } });
    await writeAudit(transaction, buyer, "c2c_order_cancelled", orderId, now, { status: "cancelled" });
    return { order: publicOrder({ ...current, status: "cancelled", cancelledAt: now, updatedAt: now }, "buyer") };
  });
};

const sellerDeliver = async (event) => {
  const seller = await requireUser();
  const orderId = asId(event.id || event.orderId, "订单ID");
  const deliveryNote = asText(event.deliveryNote, "交付说明", 240, false);
  const requestId = asRequestId(event.requestId || event.idempotencyKey);
  return runIdempotent({ actor: seller, action: "sellerDeliver", requestId, payload: { orderId, deliveryNote } }, async (transaction, now) => {
    const ref = transaction.collection(COLLECTIONS.orders).doc(orderId);
    const current = await readOptional(ref);
    ensure(current && current.sellerUserId === seller._id, "ORDER_NOT_FOUND", "交易订单不存在");
    ensure(current.status === "paid", "INVALID_STATE", "买家付款后才能确认交付");
    const patch = { status: "seller_delivered", deliveryNote, deliveredAt: now, updatedAt: now, version: Number(current.version || 0) + 1 };
    await ref.update({ data: patch });
    await writeAudit(transaction, seller, "c2c_seller_delivered", orderId, now, { status: patch.status });
    return { order: publicOrder({ ...current, ...patch }, "seller") };
  });
};

const buyerConfirm = async (event) => {
  const buyer = await requireUser();
  const orderId = asId(event.id || event.orderId, "订单ID");
  const requestId = asRequestId(event.requestId || event.idempotencyKey);
  return runIdempotent({ actor: buyer, action: "buyerConfirm", requestId, payload: { orderId } }, async (transaction, now) => {
    const ref = transaction.collection(COLLECTIONS.orders).doc(orderId);
    const current = await readOptional(ref);
    ensure(current && current.buyerUserId === buyer._id, "ORDER_NOT_FOUND", "交易订单不存在");
    ensure(current.status === "seller_delivered", "INVALID_STATE", "请在卖家确认交付后再确认收货");
    ensure(!current.disputeId, "DISPUTE_OPEN", "争议处理中，暂不能确认收货");
    const patch = {
      status: "settlement_available",
      settlementStatus: "available",
      confirmedAt: now,
      updatedAt: now,
      version: Number(current.version || 0) + 1,
    };
    await ref.update({ data: patch });
    await transaction.collection(COLLECTIONS.ledger).doc(`settlement_${orderId}`).set({ data: {
      orderId,
      sellerUserId: current.sellerUserId,
      type: "seller_settlement_available",
      amountFen: Number(current.sellerAmountFen),
      currency: "CNY",
      feeAmountFen: Number(current.feeAmountFen),
      feeRuleVersion: current.feeRuleVersion,
      createdAt: now,
      immutable: true,
    } });
    const goodsRef = transaction.collection(COLLECTIONS.goods).doc(current.goodsId);
    const goods = await readOptional(goodsRef);
    if (goods && goods.c2cOrderId === orderId) await goodsRef.update({ data: { status: "sold", c2cTradeStatus: "settlement_available", updatedAt: now } });
    await writeAudit(transaction, buyer, "c2c_buyer_confirmed", orderId, now, { status: patch.status, amountFen: current.sellerAmountFen });
    return { order: publicOrder({ ...current, ...patch }, "buyer") };
  });
};

const openDispute = async (event) => {
  const user = await requireUser();
  const orderId = asId(event.id || event.orderId, "订单ID");
  const reason = asText(event.reason, "争议说明", 300, true);
  const requestId = asRequestId(event.requestId || event.idempotencyKey);
  return runIdempotent({ actor: user, action: "openDispute", requestId, payload: { orderId, reason } }, async (transaction, now) => {
    const ref = transaction.collection(COLLECTIONS.orders).doc(orderId);
    const current = await readOptional(ref);
    const role = current ? findRole(current, user) : "";
    ensure(Boolean(role) && role !== "admin", "ORDER_NOT_FOUND", "交易订单不存在");
    ensure(["paid", "seller_delivered", "settlement_available"].includes(current.status), "INVALID_STATE", "当前订单不能发起争议");
    ensure(!current.disputeId, "DISPUTE_EXISTS", "该订单已有争议处理中");
    ensure(current.payoutStatus === "not_requested", "PAYOUT_IN_PROGRESS", "结算处理中，请联系平台处理");
    const disputeId = nowId("dispute");
    const patch = { status: "disputed", settlementStatus: "frozen", disputeId, disputedAt: now, updatedAt: now, version: Number(current.version || 0) + 1 };
    await ref.update({ data: patch });
    await transaction.collection(COLLECTIONS.disputes).doc(disputeId).set({ data: {
      orderId,
      status: "open",
      openedByUserId: user._id,
      openedByRole: role,
      reason,
      createdAt: now,
      updatedAt: now,
    } });
    const goodsRef = transaction.collection(COLLECTIONS.goods).doc(current.goodsId);
    const goods = await readOptional(goodsRef);
    if (goods && goods.c2cOrderId === orderId) await goodsRef.update({ data: { status: "trading", c2cTradeStatus: "disputed", updatedAt: now } });
    await writeAudit(transaction, user, "c2c_dispute_opened", orderId, now, { status: patch.status });
    return { order: publicOrder({ ...current, ...patch }, role), dispute: { _id: disputeId, status: "open" } };
  });
};

const requestPayout = async (event) => {
  const seller = await requireUser();
  const policy = await readPolicy();
  const { order, role } = await getOrderForUser(seller, event.id || event.orderId);
  ensure(role === "seller", "FORBIDDEN", "仅卖家可以申请结算");
  ensure(order.status === "settlement_available" && order.settlementStatus === "available", "INVALID_STATE", "当前订单暂无可结算款项");
  // 即使后台误将 payoutEnabled 打开，未接入经核验的收款/转账适配器也绝不写入“转账中”。
  ensure(policy.payoutEnabled, "PAYOUT_DISABLED", "卖家结算尚未开放，请联系平台处理");
  throw new BusinessError("PAYOUT_ADAPTER_NOT_CONFIGURED", "卖家结算通道尚未完成商户场景核验");
};

const expirePendingOrders = async (limit = 50) => {
  const now = new Date();
  let result;
  try {
    result = await db.collection(COLLECTIONS.orders)
      .where({ status: "pending_payment", expiresAt: _.lte(now) }).limit(Math.max(1, Math.min(limit, 100))).get();
  } catch (error) {
    if (isMissingCollection(error)) return 0;
    throw error;
  }
  let expired = 0;
  for (const order of result.data) {
    await db.runTransaction(async (transaction) => {
      const ref = transaction.collection(COLLECTIONS.orders).doc(order._id);
      const current = await readOptional(ref);
      if (!current || current.status !== "pending_payment" || new Date(current.expiresAt).getTime() > now.getTime()) return;
      if (current.paymentRequestedAt) return;
      await releaseGoodsLock(transaction, current, now, "expired");
      await ref.update({ data: { status: "expired", settlementStatus: "not_available", expiredAt: now, updatedAt: now, version: Number(current.version || 0) + 1 } });
      expired += 1;
    });
  }
  return expired;
};

const adminListDisputes = async (event) => {
  await requireAdmin();
  const status = event.status ? asText(event.status, "争议状态", 40, true) : "";
  const where = status ? { status } : {};
  const result = await db.collection(COLLECTIONS.disputes).where(where).orderBy("createdAt", "desc").limit(Math.min(Number(event.pageSize) || 50, 100)).get();
  return { items: result.data.map((item) => ({ _id: item._id, orderId: item.orderId, status: item.status, reason: item.reason, createdAt: item.createdAt })) };
};

const dispatch = async (event = {}) => {
  switch (event.type) {
    case "readiness": return { policy: publicPolicy(await readPolicy()) };
    case "createOrder": return createOrder(event);
    case "getOrder": return getOrder(event);
    case "listOrders": return listOrders(event);
    case "preparePayment": return preparePayment(event);
    case "cancelOrder": return cancelOrder(event);
    case "sellerDeliver": return sellerDeliver(event);
    case "buyerConfirm": return buyerConfirm(event);
    case "openDispute": return openDispute(event);
    case "requestPayout": return requestPayout(event);
    case "adminListDisputes": return adminListDisputes(event);
    case "expirePendingOrders":
      // 定时器可调用，管理端手动调用仍要求权限。
      if (getOpenId()) await requireAdmin();
      return { expiredCount: await expirePendingOrders(Number(event.limit) || 50) };
    default: throw new BusinessError("UNKNOWN_ACTION", "未知操作");
  }
};

exports.main = async (event = {}) => {
  try {
    return ok(await dispatch(event));
  } catch (error) {
    if (error instanceof BusinessError) return fail(error.message, error.code);
    console.error("[c2c-market] unexpected error", { type: event && event.type, message: errorText(error) });
    return fail("担保交易服务暂时不可用", "INTERNAL_ERROR");
  }
};

exports._private = { COLLECTIONS, DEFAULT_POLICY, calculateFee, normalisePolicy, publicOrder, dispatch, expirePendingOrders, ACTIVE_DISPUTE_STATES, TERMINAL_GOODS_STATES };
