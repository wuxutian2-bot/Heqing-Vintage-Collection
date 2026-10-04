const cloud = require("wx-server-sdk");
const {
  BusinessError,
  RECOVERY_STATUS,
  INVENTORY_STATUS,
  SALE_STATUS,
  CLAIM_STATUS,
  TRANSFER_SCENE_ID,
  TRANSFER_REPORT_TYPE,
  TRANSFER_REMARK,
  MIN_TRANSFER_FEN,
  MAX_TRANSFER_FEN_EXCLUSIVE,
  ORDER_TTL_MS,
  ensure,
  text,
  id,
  requestId,
  integer,
  expectedVersion,
  digest,
  deterministicId,
  makeRecoveryId,
  makeInventoryId,
  makeSaleOrderId,
  makeClaimId,
  makeOutTradeNo,
  makeOutBillNo,
  validImages,
  validateQuote,
  pageInput,
  assertClaimHasNoClientMoneyOrRecipient,
  goodsTitleForTransfer,
  publicRecovery,
  publicInventory,
  publicSaleOrder,
  publicClaim,
} = require("./domain");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const COLLECTIONS = Object.freeze({
  users: "users",
  goods: "goods",
  recoveries: "market_recovery_orders",
  inventory: "market_inventory",
  sales: "market_sale_orders",
  claims: "market_claims",
  finance: "market_finance_entries",
  idempotency: "market_idempotency",
  audit: "market_audit_logs",
});

const ACTION_ALIASES = Object.freeze({
  market_recovery_submit: "recoverySubmit",
  market_recovery_list: "recoveryList",
  market_recovery_get: "recoveryGet",
  market_quote_accept: "quoteAccept",
  market_catalog_list: "catalogList",
  market_catalog_get: "catalogGet",
  market_sale_create: "saleCreate",
  market_sale_list: "saleList",
  market_sale_get: "saleGet",
  market_sale_cancel: "saleCancel",
  market_sale_prepare_payment: "salePreparePayment",
  market_claim_create: "claimCreate",
  market_claim_list: "claimList",
  market_claim_get: "claimGet",
  admin_market_recovery_list: "adminRecoveryList",
  admin_market_recovery_get: "adminRecoveryGet",
  admin_market_quote: "adminQuote",
  admin_market_inspect: "adminInspect",
  admin_market_recovery_confirm: "adminConfirmAcquisition",
  admin_market_sale_list: "adminSaleList",
  admin_market_claim_list: "adminClaimList",
  admin_market_inventory_list: "adminInventoryList",
  admin_market_stock: "adminStock",
});

const ok = (data = {}) => ({ success: true, data });
const fail = (errMsg, errorCode = "MARKET_ERROR") => ({ success: false, errMsg, errorCode });
const getOpenId = () => cloud.getWXContext().OPENID;

const errorText = (error) => String((error && (error.errMsg || error.message)) || error || "");
const isMissingDocument = (error) => {
  const message = errorText(error).toLowerCase();
  return message.includes("document not exist")
    || message.includes("document does not exist")
    || message.includes("does not exist")
    || message.includes("not found")
    || (error && ["DATABASE_DOCUMENT_NOT_EXIST", "DOCUMENT_NOT_FOUND"].includes(error.code));
};
const isMissingCollection = (error) => errorText(error).toLowerCase().includes("collection not exists");

const readOptional = async (reference) => {
  try {
    const result = await reference.get();
    return result && result.data ? result.data : null;
  } catch (error) {
    if (isMissingDocument(error)) return null;
    throw error;
  }
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

const formatDisplayName = (user) => {
  const aliasNo = Number(user && user.aliasNo || 0);
  if (Number.isInteger(aliasNo) && aliasNo > 0) return `鹏宇用户${String(aliasNo).padStart(4, "0")}`;
  return text(user && user.displayName, "用户昵称", 60, false) || "鹏宇用户";
};

const checkVersion = (record, value) => {
  const requested = expectedVersion(value);
  ensure(Number(record.version || 0) === requested, "VERSION_CONFLICT", "数据已更新，请刷新后重试");
  return requested;
};

const writeAudit = async (transaction, context, details = {}) => {
  const auditId = deterministicId("aud_", context.actor._id, context.action, context.mutationId);
  await transaction.collection(COLLECTIONS.audit).doc(auditId).set({
    data: {
      actorUserId: context.actor._id,
      actorRole: context.actor.role || "user",
      action: context.action,
      requestId: context.mutationId,
      targetType: details.targetType || "",
      targetId: details.targetId || "",
      resultStatus: details.resultStatus || "",
      amountFen: Number(details.amountFen || 0),
      createdAt: context.now,
    },
  });
};

const runIdempotent = async ({ actor, action, mutationId, payload }, operation) => {
  const inputDigest = digest(payload);
  const recordId = deterministicId("idem_", actor._id, action, mutationId);
  const now = new Date();
  return db.runTransaction(async (transaction) => {
    const idemRef = transaction.collection(COLLECTIONS.idempotency).doc(recordId);
    const existing = await readOptional(idemRef);
    if (existing) {
      ensure(
        existing.actorUserId === actor._id && existing.action === action && existing.inputDigest === inputDigest,
        "IDEMPOTENCY_CONFLICT",
        "该请求标识已用于不同操作"
      );
      return existing.response;
    }

    const context = { actor, action, mutationId, now, transaction };
    const response = await operation(context);
    await idemRef.set({
      data: {
        actorUserId: actor._id,
        action,
        requestId: mutationId,
        inputDigest,
        response,
        createdAt: now,
      },
    });
    return response;
  });
};

const goodsSnapshot = (goods) => {
  const images = Array.isArray(goods.images)
    ? goods.images
      .filter((value) => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.startsWith("cloud://") || /^https?:\/\//i.test(value))
      .slice(0, 9)
    : [];
  const legacyPrice = Number(goods.price);
  return {
    title: text(goods.title, "商品名称", 60, true),
    desc: text(goods.desc, "商品描述", 1000, false),
    category: text(goods.category, "商品分类", 30, false) || "其他",
    images,
    condition: text(goods.condition, "商品成色", 200, false),
    originalPriceFen: Number.isFinite(legacyPrice) && legacyPrice >= 0
      ? Math.round(legacyPrice * 100)
      : 0,
  };
};

const listQuery = async (collectionName, where, event, projection, orderField = "createdAt") => {
  const paging = pageInput(event);
  let query = db.collection(collectionName).where(where);
  if (orderField) query = query.orderBy(orderField, "desc");
  const result = await query.skip(paging.skip).limit(paging.pageSize).get();
  return {
    items: result.data.map(projection),
    page: paging.page,
    pageSize: paging.pageSize,
    hasMore: result.data.length === paging.pageSize,
  };
};

const recoverySubmit = async (event) => {
  const user = await requireUser();
  const sourceGoodsId = id(event.goodsId, "商品ID");
  const mutationId = requestId(event.requestId || event.idempotencyKey);
  const recoveryId = makeRecoveryId(sourceGoodsId);
  const payload = { sourceGoodsId };

  return runIdempotent({ actor: user, action: "recoverySubmit", mutationId, payload }, async (context) => {
    const existing = await readOptional(context.transaction.collection(COLLECTIONS.recoveries).doc(recoveryId));
    if (existing) {
      ensure(existing.ownerUserId === user._id, "RECOVERY_EXISTS", "该商品已有回收申请");
      return { created: false, recovery: publicRecovery(existing) };
    }

    const goodsRef = context.transaction.collection(COLLECTIONS.goods).doc(sourceGoodsId);
    const goods = await readOptional(goodsRef);
    ensure(Boolean(goods), "GOODS_NOT_FOUND", "商品不存在");
    const isOwner = goods._openid === user.openid || goods.authorId === user._id;
    ensure(isOwner, "FORBIDDEN", "只能申请回收自己的商品");
    ensure(goods.category !== "求购", "INVALID_GOODS", "求购信息不能申请平台回收");
    ensure(!goods.platformOwned, "INVALID_GOODS", "平台商品不能重复申请回收");
    ensure(goods.status === "on_sale", "INVALID_GOODS", "只有在售商品可以申请回收");
    ensure(!goods.recoveryOrderId, "RECOVERY_EXISTS", "该商品已有回收申请");

    const snapshot = goodsSnapshot(goods);
    const record = {
      _id: recoveryId,
      sourceGoodsId,
      ownerUserId: user._id,
      ownerOpenId: user.openid,
      ownerDisplayName: formatDisplayName(user),
      goodsSnapshot: snapshot,
      status: "submitted",
      version: 1,
      quote: null,
      acceptedQuoteVersion: null,
      inspection: null,
      payableAmountFen: 0,
      payableStatus: "not_confirmed",
      activeClaimId: "",
      inventoryId: "",
      createdAt: context.now,
      updatedAt: context.now,
    };
    await context.transaction.collection(COLLECTIONS.recoveries).doc(recoveryId).set({ data: record });
    await goodsRef.update({
      data: {
        recoveryOrderId: recoveryId,
        recoveryStatus: "submitted",
        updatedAt: context.now,
      },
    });
    await writeAudit(context.transaction, context, {
      targetType: "recovery",
      targetId: recoveryId,
      resultStatus: record.status,
    });
    return { created: true, recovery: publicRecovery(record) };
  });
};

const recoveryList = async (event) => {
  const user = await requireUser();
  const where = { ownerUserId: user._id };
  if (event.status !== undefined) {
    const status = text(event.status, "回收状态", 40, true);
    ensure(RECOVERY_STATUS.includes(status), "INVALID_INPUT", "回收状态不正确");
    where.status = status;
  }
  return listQuery(COLLECTIONS.recoveries, where, event, (item) => publicRecovery(item));
};

const recoveryGet = async (event) => {
  const user = await requireUser();
  const recoveryId = id(event.recoveryId || event.id, "回收单ID");
  const record = await readOptional(db.collection(COLLECTIONS.recoveries).doc(recoveryId));
  ensure(record && record.ownerUserId === user._id, "RECOVERY_NOT_FOUND", "回收单不存在");
  return { recovery: publicRecovery(record) };
};

const adminRecoveryList = async (event) => {
  await requireAdmin();
  const where = {};
  if (event.status !== undefined) {
    const status = text(event.status, "回收状态", 40, true);
    ensure(RECOVERY_STATUS.includes(status), "INVALID_INPUT", "回收状态不正确");
    where.status = status;
  }
  return listQuery(COLLECTIONS.recoveries, where, event, (item) => publicRecovery(item, { admin: true }));
};

const adminRecoveryGet = async (event) => {
  await requireAdmin();
  const recoveryId = id(event.recoveryId || event.id, "回收单ID");
  const record = await readOptional(db.collection(COLLECTIONS.recoveries).doc(recoveryId));
  ensure(Boolean(record), "RECOVERY_NOT_FOUND", "回收单不存在");
  return { recovery: publicRecovery(record, { admin: true }) };
};

const adminQuote = async (event) => {
  const admin = await requireAdmin();
  const recoveryId = id(event.recoveryId, "回收单ID");
  const mutationId = requestId(event.requestId || event.idempotencyKey);
  const recordVersion = expectedVersion(event.expectedVersion);
  const now = new Date();
  const quoteInput = validateQuote(event, now);
  const payload = { recoveryId, recordVersion, ...quoteInput };

  return runIdempotent({ actor: admin, action: "adminQuote", mutationId, payload }, async (context) => {
    const ref = context.transaction.collection(COLLECTIONS.recoveries).doc(recoveryId);
    const current = await readOptional(ref);
    ensure(Boolean(current), "RECOVERY_NOT_FOUND", "回收单不存在");
    checkVersion(current, recordVersion);
    ensure(["submitted", "quoted"].includes(current.status), "INVALID_STATE", "当前回收单不能报价");

    const nextQuoteVersion = Number(current.quote && current.quote.version || 0) + 1;
    const quote = {
      ...quoteInput,
      version: nextQuoteVersion,
      createdBy: admin._id,
      createdAt: context.now,
    };
    const patch = {
      status: "quoted",
      version: Number(current.version || 0) + 1,
      quote,
      acceptedQuoteVersion: null,
      acceptedAt: null,
      inspection: null,
      updatedAt: context.now,
    };
    await ref.update({ data: patch });
    await context.transaction.collection(COLLECTIONS.goods).doc(current.sourceGoodsId).update({
      data: { recoveryStatus: "quoted", updatedAt: context.now },
    });
    await writeAudit(context.transaction, context, {
      targetType: "recovery",
      targetId: recoveryId,
      resultStatus: patch.status,
      amountFen: quote.netAmountFen,
    });
    return { recovery: publicRecovery({ ...current, ...patch }) };
  });
};

const quoteAccept = async (event) => {
  const user = await requireUser();
  const recoveryId = id(event.recoveryId, "回收单ID");
  const quoteVersion = integer(event.quoteVersion, "报价版本", 1, Number.MAX_SAFE_INTEGER);
  const mutationId = requestId(event.requestId || event.idempotencyKey);
  const payload = { recoveryId, quoteVersion };

  return runIdempotent({ actor: user, action: "quoteAccept", mutationId, payload }, async (context) => {
    const ref = context.transaction.collection(COLLECTIONS.recoveries).doc(recoveryId);
    const current = await readOptional(ref);
    ensure(current && current.ownerUserId === user._id, "RECOVERY_NOT_FOUND", "回收单不存在");
    ensure(current.status === "quoted" && current.quote, "INVALID_STATE", "当前没有可接受的报价");
    ensure(Number(current.quote.version) === quoteVersion, "QUOTE_CHANGED", "报价已更新，请重新确认");
    ensure(new Date(current.quote.expiresAt).getTime() > context.now.getTime(), "QUOTE_EXPIRED", "报价已过期");
    ensure(
      Number.isInteger(current.quote.netAmountFen)
        && current.quote.netAmountFen >= MIN_TRANSFER_FEN
        && current.quote.netAmountFen < MAX_TRANSFER_FEN_EXCLUSIVE,
      "TRANSFER_AMOUNT_UNSUPPORTED",
      "该报价暂不支持领取"
    );

    const patch = {
      status: "quote_accepted",
      version: Number(current.version || 0) + 1,
      acceptedQuoteVersion: quoteVersion,
      acceptedAt: context.now,
      updatedAt: context.now,
    };
    await ref.update({ data: patch });
    await context.transaction.collection(COLLECTIONS.goods).doc(current.sourceGoodsId).update({
      data: { recoveryStatus: "quote_accepted", updatedAt: context.now },
    });
    await writeAudit(context.transaction, context, {
      targetType: "recovery",
      targetId: recoveryId,
      resultStatus: patch.status,
      amountFen: current.quote.netAmountFen,
    });
    return { recovery: publicRecovery({ ...current, ...patch }) };
  });
};

const adminInspect = async (event) => {
  const admin = await requireAdmin();
  const recoveryId = id(event.recoveryId, "回收单ID");
  const mutationId = requestId(event.requestId || event.idempotencyKey);
  const recordVersion = expectedVersion(event.expectedVersion);
  const result = text(event.result, "验货结果", 20, true);
  ensure(["passed", "reprice", "rejected"].includes(result), "INVALID_INPUT", "验货结果不正确");
  const note = text(event.note, "验货说明", 500, result !== "passed");
  const condition = text(event.condition, "验货成色", 200, false);
  const evidenceImages = validImages(event.evidenceImages);
  const quoteInput = result === "reprice" ? validateQuote(event, new Date()) : null;
  const payload = { recoveryId, recordVersion, result, note, condition, evidenceImages, quoteInput };

  return runIdempotent({ actor: admin, action: "adminInspect", mutationId, payload }, async (context) => {
    const ref = context.transaction.collection(COLLECTIONS.recoveries).doc(recoveryId);
    const current = await readOptional(ref);
    ensure(Boolean(current), "RECOVERY_NOT_FOUND", "回收单不存在");
    checkVersion(current, recordVersion);
    ensure(
      ["quote_accepted", "inspected"].includes(current.status),
      "INVALID_STATE",
      "当前回收单不能验货"
    );
    ensure(
      current.quote && Number(current.acceptedQuoteVersion) === Number(current.quote.version),
      "QUOTE_CHANGED",
      "报价尚未由用户确认"
    );

    const inspection = {
      result,
      note,
      condition,
      evidenceImages,
      quoteVersion: current.quote.version,
      inspectedBy: admin._id,
      inspectedAt: context.now,
    };
    const history = [...(Array.isArray(current.inspectionHistory) ? current.inspectionHistory : []), inspection].slice(-20);
    const patch = {
      version: Number(current.version || 0) + 1,
      inspection,
      inspectionHistory: history,
      updatedAt: context.now,
    };
    if (result === "passed") {
      patch.status = "inspected";
    } else if (result === "rejected") {
      patch.status = "closed";
      patch.closedAt = context.now;
      patch.closeReason = "inspection_rejected";
    } else {
      patch.status = "quoted";
      patch.quote = {
        ...quoteInput,
        version: Number(current.quote.version || 0) + 1,
        createdBy: admin._id,
        createdAt: context.now,
      };
      patch.acceptedQuoteVersion = null;
      patch.acceptedAt = null;
    }
    await ref.update({ data: patch });
    await context.transaction.collection(COLLECTIONS.goods).doc(current.sourceGoodsId).update({
      data: { recoveryStatus: patch.status, updatedAt: context.now },
    });
    await writeAudit(context.transaction, context, {
      targetType: "recovery",
      targetId: recoveryId,
      resultStatus: patch.status,
      amountFen: patch.quote ? patch.quote.netAmountFen : current.quote.netAmountFen,
    });
    return { recovery: publicRecovery({ ...current, ...patch }) };
  });
};

const adminConfirmAcquisition = async (event) => {
  const admin = await requireAdmin();
  const recoveryId = id(event.recoveryId, "回收单ID");
  const mutationId = requestId(event.requestId || event.idempotencyKey);
  const recordVersion = expectedVersion(event.expectedVersion);
  const quoteVersion = integer(event.quoteVersion, "报价版本", 1, Number.MAX_SAFE_INTEGER);
  const inventoryId = makeInventoryId(recoveryId);
  const payload = { recoveryId, recordVersion, quoteVersion };

  return runIdempotent({ actor: admin, action: "adminConfirmAcquisition", mutationId, payload }, async (context) => {
    const recoveryRef = context.transaction.collection(COLLECTIONS.recoveries).doc(recoveryId);
    const current = await readOptional(recoveryRef);
    ensure(Boolean(current), "RECOVERY_NOT_FOUND", "回收单不存在");
    if (current.status === "acquisition_completed") {
      ensure(current.inventoryId === inventoryId, "DATA_CONFLICT", "回收单库存绑定异常");
      ensure(
        Number(current.acceptedQuoteVersion) === quoteVersion,
        "QUOTE_CHANGED",
        "已完成收购的报价版本不一致"
      );
      return {
        recovery: publicRecovery(current, { admin: true }),
        inventoryId,
        created: false,
      };
    }
    checkVersion(current, recordVersion);
    ensure(current.status === "inspected", "INVALID_STATE", "验货通过后才能确认收购");
    ensure(current.inspection && current.inspection.result === "passed", "INVALID_STATE", "验货尚未通过");
    ensure(current.quote && Number(current.quote.version) === quoteVersion, "QUOTE_CHANGED", "报价版本不一致");
    ensure(Number(current.acceptedQuoteVersion) === quoteVersion, "QUOTE_CHANGED", "最终报价尚未由用户确认");

    const grossAmountFen = integer(current.quote.grossAmountFen, "回收总价", MIN_TRANSFER_FEN, MAX_TRANSFER_FEN_EXCLUSIVE - 1);
    const feeAmountFen = integer(current.quote.feeAmountFen, "服务费", 0, grossAmountFen - 1);
    const netAmountFen = grossAmountFen - feeAmountFen;
    ensure(netAmountFen === current.quote.netAmountFen, "DATA_CONFLICT", "报价金额数据不一致");
    ensure(netAmountFen < MAX_TRANSFER_FEN_EXCLUSIVE, "TRANSFER_AMOUNT_UNSUPPORTED", "回收款金额暂不支持领取");
    const salePriceFen = integer(current.quote.platformSalePriceFen, "平台销售价", 1, 99999999);

    const goodsRef = context.transaction.collection(COLLECTIONS.goods).doc(current.sourceGoodsId);
    const goods = await readOptional(goodsRef);
    ensure(Boolean(goods), "GOODS_NOT_FOUND", "原商品不存在，不能确认收购");
    ensure(
      goods._openid === current.ownerOpenId || goods.authorId === current.ownerUserId,
      "DATA_CONFLICT",
      "原商品归属已变化"
    );
    ensure(!goods.platformOwned, "DATA_CONFLICT", "原商品已转为平台库存");
    ensure(goods.status === "on_sale", "INVALID_STATE", "原商品当前状态不能入库");

    const inventoryRef = context.transaction.collection(COLLECTIONS.inventory).doc(inventoryId);
    const existingInventory = await readOptional(inventoryRef);
    ensure(!existingInventory, "DATA_CONFLICT", "该回收单已存在库存记录");
    const snapshot = current.goodsSnapshot || {};
    const inventory = {
      _id: inventoryId,
      recoveryOrderId: recoveryId,
      goodsId: current.sourceGoodsId,
      sourceGoodsId: current.sourceGoodsId,
      originalOwnerUserId: current.ownerUserId,
      title: text(snapshot.title, "商品名称", 60, true),
      desc: text(snapshot.desc, "商品描述", 1000, false),
      category: text(snapshot.category, "商品分类", 30, false) || "其他",
      images: Array.isArray(snapshot.images) ? snapshot.images.slice(0, 9) : [],
      condition: text(current.inspection.condition || snapshot.condition, "验货成色", 200, false),
      acquisitionCostFen: netAmountFen,
      grossAcquisitionAmountFen: grossAmountFen,
      feeAmountFen,
      platformSalePriceFen: salePriceFen,
      status: "on_sale",
      saleOrderId: "",
      lockExpiresAt: null,
      version: 1,
      createdAt: context.now,
      updatedAt: context.now,
    };
    await inventoryRef.set({ data: inventory });

    const recoveryPatch = {
      status: "acquisition_completed",
      version: Number(current.version || 0) + 1,
      payableAmountFen: netAmountFen,
      payableStatus: "available",
      inventoryId,
      acquiredAt: context.now,
      acquiredBy: admin._id,
      updatedAt: context.now,
    };
    await recoveryRef.update({ data: recoveryPatch });
    await goodsRef.update({
      data: {
        status: "on_sale",
        platformOwned: true,
        inventoryId,
        recoveryOrderId: recoveryId,
        recoveryStatus: "acquisition_completed",
        platformSalePriceFen: salePriceFen,
        price: salePriceFen / 100,
        updatedAt: context.now,
      },
    });

    const liabilityId = deterministicId("fin_", "payable_confirmed", recoveryId);
    await context.transaction.collection(COLLECTIONS.finance).doc(liabilityId).set({
      data: {
        type: "payable_confirmed",
        businessType: "market_recovery",
        businessId: recoveryId,
        ownerUserId: current.ownerUserId,
        amountFen: netAmountFen,
        quoteVersion,
        createdBy: admin._id,
        createdAt: context.now,
      },
    });
    await writeAudit(context.transaction, context, {
      targetType: "recovery",
      targetId: recoveryId,
      resultStatus: recoveryPatch.status,
      amountFen: netAmountFen,
    });
    return {
      recovery: publicRecovery({ ...current, ...recoveryPatch }, { admin: true }),
      inventory: publicInventory(inventory, { admin: true }),
      inventoryId,
      created: true,
    };
  });
};

const catalogList = async (event) => {
  const where = { status: "on_sale" };
  if (event.category !== undefined) where.category = text(event.category, "商品分类", 30, true);
  if (event.keyword !== undefined) {
    const keyword = text(event.keyword, "搜索词", 40, false);
    if (keyword) {
      where.title = db.RegExp({
        regexp: keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        options: "i",
      });
    }
  }
  return listQuery(COLLECTIONS.inventory, where, event, (item) => publicInventory(item));
};

const catalogGet = async (event) => {
  const inventoryId = event.inventoryId ? id(event.inventoryId, "库存ID") : "";
  const goodsId = event.goodsId ? id(event.goodsId, "商品ID") : "";
  ensure(Boolean(inventoryId || goodsId), "INVALID_INPUT", "缺少库存ID或商品ID");
  let item = null;
  if (inventoryId) item = await readOptional(db.collection(COLLECTIONS.inventory).doc(inventoryId));
  else {
    const result = await db.collection(COLLECTIONS.inventory).where({ sourceGoodsId: goodsId }).limit(2).get();
    ensure(result.data.length <= 1, "DATA_CONFLICT", "商品库存数据重复");
    item = result.data[0] || null;
  }
  ensure(item && item.status === "on_sale", "INVENTORY_NOT_FOUND", "平台商品不存在或已下架");
  return { item: publicInventory(item) };
};

const hasPaymentStarted = (order) => Boolean(order && order.paymentRequestedAt)
  || Boolean(order && order.paymentStatus && order.paymentStatus !== "unpaid");

const markSaleForPaymentReconcile = async (transaction, order, now) => {
  const patch = {
    status: "payment_exception",
    needsPaymentReconcile: true,
    paymentExceptionReason: "pending_order_expired_after_payment_requested",
    updatedAt: now,
  };
  await transaction.collection(COLLECTIONS.sales).doc(order._id).update({ data: patch });
  return { ...order, ...patch };
};

const releaseSaleOrderInTransaction = async (transaction, order, targetStatus, now) => {
  if (!order || order.status !== "pending_payment" || order.stockReleased) return null;
  ensure(!hasPaymentStarted(order), "PAYMENT_RECONCILING", "支付状态确认中，请刷新后重试");
  const orderRef = transaction.collection(COLLECTIONS.sales).doc(order._id);
  const inventoryRef = transaction.collection(COLLECTIONS.inventory).doc(order.inventoryId);
  const inventory = await readOptional(inventoryRef);
  if (inventory && inventory.status === "locked" && inventory.saleOrderId === order._id) {
    await inventoryRef.update({
      data: {
        status: "on_sale",
        saleOrderId: "",
        lockExpiresAt: null,
        version: Number(inventory.version || 0) + 1,
        updatedAt: now,
      },
    });
  }
  const patch = {
    status: targetStatus,
    stockReleased: true,
    updatedAt: now,
  };
  if (targetStatus === "cancelled") patch.cancelledAt = now;
  if (targetStatus === "expired") patch.expiredAt = now;
  await orderRef.update({ data: patch });
  return { ...order, ...patch };
};

const expireSaleOrder = async (orderId, now = new Date()) => db.runTransaction(async (transaction) => {
  const order = await readOptional(transaction.collection(COLLECTIONS.sales).doc(orderId));
  if (!order || order.status !== "pending_payment" || order.stockReleased) return false;
  if (new Date(order.expiresAt).getTime() > now.getTime()) return false;
  if (hasPaymentStarted(order)) {
    await markSaleForPaymentReconcile(transaction, order, now);
    return "needs_reconcile";
  }
  await releaseSaleOrderInTransaction(transaction, order, "expired", now);
  return "released";
});

const expirePendingSales = async (limit = 30) => {
  let result;
  try {
    result = await db.collection(COLLECTIONS.sales).where({
      status: "pending_payment",
      expiresAt: _.lt(new Date()),
      stockReleased: false,
    }).limit(Math.min(Math.max(Number(limit || 30), 1), 50)).get();
  } catch (error) {
    if (isMissingCollection(error)) return 0;
    throw error;
  }
  let count = 0;
  for (const order of result.data) {
    if (await expireSaleOrder(order._id)) count += 1;
  }
  return count;
};

const resolveInventoryId = async (event) => {
  if (event.inventoryId) return id(event.inventoryId, "库存ID");
  const goodsId = id(event.goodsId, "商品ID");
  const result = await db.collection(COLLECTIONS.inventory).where({ sourceGoodsId: goodsId }).limit(2).get();
  ensure(result.data.length === 1, "INVENTORY_NOT_FOUND", "平台商品不存在");
  return result.data[0]._id;
};

const saleCreate = async (event) => {
  const user = await requireUser();
  await expirePendingSales(20);
  const inventoryId = await resolveInventoryId(event);
  const mutationId = requestId(event.requestId || event.idempotencyKey);
  const note = text(event.note, "订单备注", 120, false);
  const saleOrderId = makeSaleOrderId(user._id, mutationId);
  const outTradeNo = makeOutTradeNo(saleOrderId);
  const payload = { inventoryId, note };

  return runIdempotent({ actor: user, action: "saleCreate", mutationId, payload }, async (context) => {
    const orderRef = context.transaction.collection(COLLECTIONS.sales).doc(saleOrderId);
    const existingOrder = await readOptional(orderRef);
    if (existingOrder) {
      ensure(
        existingOrder.buyerUserId === user._id && existingOrder.inventoryId === inventoryId,
        "IDEMPOTENCY_CONFLICT",
        "该请求标识已用于其他订单"
      );
      return { created: false, order: publicSaleOrder(existingOrder) };
    }

    const inventoryRef = context.transaction.collection(COLLECTIONS.inventory).doc(inventoryId);
    let inventory = await readOptional(inventoryRef);
    ensure(Boolean(inventory), "INVENTORY_NOT_FOUND", "平台商品不存在");
    if (
      inventory.status === "locked"
      && inventory.saleOrderId
      && new Date(inventory.lockExpiresAt).getTime() <= context.now.getTime()
    ) {
      const staleOrder = await readOptional(
        context.transaction.collection(COLLECTIONS.sales).doc(inventory.saleOrderId)
      );
      if (staleOrder && staleOrder.status === "pending_payment" && !staleOrder.stockReleased) {
        if (hasPaymentStarted(staleOrder)) {
          await markSaleForPaymentReconcile(context.transaction, staleOrder, context.now);
        } else {
          await releaseSaleOrderInTransaction(context.transaction, staleOrder, "expired", context.now);
          inventory = { ...inventory, status: "on_sale", saleOrderId: "", lockExpiresAt: null };
        }
      }
    }
    ensure(inventory.status === "on_sale" && !inventory.saleOrderId, "INVENTORY_LOCKED", "商品已被购买或正在支付");
    const amountFen = integer(inventory.platformSalePriceFen, "商品价格", 1, 99999999);
    const expiresAt = new Date(context.now.getTime() + ORDER_TTL_MS);
    const description = text(`平台二手-${inventory.title}`, "支付描述", 127, true);
    const itemSnapshot = {
      inventoryId,
      goodsId: inventory.goodsId || inventory.sourceGoodsId,
      title: inventory.title,
      image: Array.isArray(inventory.images) ? inventory.images[0] || "" : "",
      condition: inventory.condition || "",
      priceFen: amountFen,
      quantity: 1,
      platformOwned: true,
    };
    const order = {
      _id: saleOrderId,
      orderNo: outTradeNo,
      outTradeNo,
      buyerUserId: user._id,
      buyerOpenId: user.openid,
      inventoryId,
      goodsId: inventory.goodsId || inventory.sourceGoodsId,
      itemSnapshot,
      totalAmountFen: amountFen,
      description,
      note,
      status: "pending_payment",
      paymentStatus: "unpaid",
      stockReleased: false,
      expiresAt,
      createdAt: context.now,
      updatedAt: context.now,
    };
    await orderRef.set({ data: order });
    await inventoryRef.update({
      data: {
        status: "locked",
        saleOrderId,
        lockExpiresAt: expiresAt,
        version: Number(inventory.version || 0) + 1,
        updatedAt: context.now,
      },
    });
    await writeAudit(context.transaction, context, {
      targetType: "sale_order",
      targetId: saleOrderId,
      resultStatus: order.status,
      amountFen,
    });
    return { created: true, order: publicSaleOrder(order) };
  });
};

const saleList = async (event) => {
  const user = await requireUser();
  await expirePendingSales(20);
  const where = { buyerUserId: user._id };
  if (event.status !== undefined) {
    const status = text(event.status, "订单状态", 40, true);
    ensure(SALE_STATUS.includes(status), "INVALID_INPUT", "订单状态不正确");
    where.status = status;
  }
  return listQuery(COLLECTIONS.sales, where, event, (item) => publicSaleOrder(item));
};

const loadOwnedSale = async (event, user) => {
  const orderId = id(event.orderId || event.id, "市场订单ID");
  await expireSaleOrder(orderId);
  const order = await readOptional(db.collection(COLLECTIONS.sales).doc(orderId));
  ensure(order && order.buyerUserId === user._id, "SALE_NOT_FOUND", "市场订单不存在");
  return order;
};

const saleGet = async (event) => {
  const user = await requireUser();
  const order = await loadOwnedSale(event, user);
  return { order: publicSaleOrder(order) };
};

const saleCancel = async (event) => {
  const user = await requireUser();
  const orderId = id(event.orderId || event.id, "市场订单ID");
  const mutationId = requestId(event.requestId || event.idempotencyKey);
  const payload = { orderId };
  return runIdempotent({ actor: user, action: "saleCancel", mutationId, payload }, async (context) => {
    const order = await readOptional(context.transaction.collection(COLLECTIONS.sales).doc(orderId));
    ensure(order && order.buyerUserId === user._id, "SALE_NOT_FOUND", "市场订单不存在");
    if (order.status === "cancelled" && order.stockReleased) {
      return { order: publicSaleOrder(order), cancelled: false };
    }
    ensure(order.status === "pending_payment" && !order.stockReleased, "INVALID_STATE", "当前订单不能取消");
    ensure(!hasPaymentStarted(order), "PAYMENT_RECONCILING", "支付状态确认中，请刷新后重试");
    const cancelled = await releaseSaleOrderInTransaction(context.transaction, order, "cancelled", context.now);
    ensure(Boolean(cancelled), "STATE_CHANGED", "订单状态已变化，请刷新后重试");
    await writeAudit(context.transaction, context, {
      targetType: "sale_order",
      targetId: orderId,
      resultStatus: "cancelled",
      amountFen: order.totalAmountFen,
    });
    return { order: publicSaleOrder(cancelled), cancelled: true };
  });
};

const salePreparePayment = async (event) => {
  const user = await requireUser();
  const order = await loadOwnedSale(event, user);
  ensure(
    order.status === "pending_payment" && !order.stockReleased,
    "INVALID_STATE",
    "订单已失效，请重新下单"
  );
  ensure(new Date(order.expiresAt).getTime() > Date.now(), "ORDER_EXPIRED", "订单已失效，请重新下单");
  const inventory = await readOptional(db.collection(COLLECTIONS.inventory).doc(order.inventoryId));
  ensure(
    inventory && inventory.status === "locked" && inventory.saleOrderId === order._id,
    "INVENTORY_CONFLICT",
    "库存锁定状态异常，请稍后重试"
  );
  const amountFen = integer(order.totalAmountFen, "订单金额", 1, 99999999);
  ensure(amountFen === inventory.platformSalePriceFen, "PRICE_CHANGED", "订单价格校验失败");
  return {
    orderId: order._id,
    outTradeNo: order.outTradeNo,
    description: order.description,
    totalAmountFen: amountFen,
    expiresAt: order.expiresAt,
  };
};

const adminSaleList = async (event) => {
  await requireAdmin();
  await expirePendingSales(30);
  const where = {};
  if (event.status !== undefined) {
    const status = text(event.status, "订单状态", 40, true);
    ensure(SALE_STATUS.includes(status), "INVALID_INPUT", "订单状态不正确");
    where.status = status;
  }
  return listQuery(COLLECTIONS.sales, where, event, (item) => publicSaleOrder(item, { admin: true }));
};

const claimCreate = async (event) => {
  assertClaimHasNoClientMoneyOrRecipient(event);
  const user = await requireUser();
  const recoveryId = id(event.recoveryId, "回收单ID");
  const mutationId = requestId(event.requestId || event.idempotencyKey);
  const claimId = makeClaimId(recoveryId, mutationId);
  const outBillNo = makeOutBillNo(claimId);
  const payload = { recoveryId };

  return runIdempotent({ actor: user, action: "claimCreate", mutationId, payload }, async (context) => {
    const recoveryRef = context.transaction.collection(COLLECTIONS.recoveries).doc(recoveryId);
    const recovery = await readOptional(recoveryRef);
    ensure(recovery && recovery.ownerUserId === user._id, "RECOVERY_NOT_FOUND", "回收单不存在");
    ensure(recovery.ownerOpenId === user.openid, "OWNER_CHANGED", "回收款收款身份不一致");
    ensure(recovery.status === "acquisition_completed", "INVALID_STATE", "收购完成后才能领取回收款");
    const amountFen = integer(
      recovery.payableAmountFen,
      "回收款",
      MIN_TRANSFER_FEN,
      MAX_TRANSFER_FEN_EXCLUSIVE - 1
    );
    ensure(
      recovery.quote && amountFen === recovery.quote.netAmountFen,
      "DATA_CONFLICT",
      "回收款金额校验失败"
    );

    if (recovery.activeClaimId) {
      const active = await readOptional(
        context.transaction.collection(COLLECTIONS.claims).doc(recovery.activeClaimId)
      );
      ensure(active && active.ownerUserId === user._id, "DATA_CONFLICT", "领取单绑定异常");
      return { created: false, claim: publicClaim(active) };
    }
    ensure(recovery.payableStatus === "available", "CLAIM_EXISTS", "该回收款已申请领取或已领取");

    const claimRef = context.transaction.collection(COLLECTIONS.claims).doc(claimId);
    const existing = await readOptional(claimRef);
    if (existing) {
      ensure(
        existing.ownerUserId === user._id && existing.recoveryOrderId === recoveryId,
        "DATA_CONFLICT",
        "领取单绑定异常"
      );
      return { created: false, claim: publicClaim(existing) };
    }

    const titleSnapshot = goodsTitleForTransfer(recovery.goodsSnapshot && recovery.goodsSnapshot.title);
    const claim = {
      _id: claimId,
      recoveryOrderId: recoveryId,
      ownerUserId: user._id,
      ownerOpenId: recovery.ownerOpenId,
      transferAmountFen: amountFen,
      outBillNo,
      sceneId: TRANSFER_SCENE_ID,
      goodsTitleSnapshot: titleSnapshot,
      transferRemark: TRANSFER_REMARK,
      transferSceneReportInfos: [{
        info_type: TRANSFER_REPORT_TYPE,
        info_content: titleSnapshot,
      }],
      status: "reserved",
      channelStatus: "NOT_STARTED",
      dispatchStatus: "not_dispatched",
      channelTransferBillNo: "",
      packageInfo: "",
      failureCode: "",
      failureReason: "",
      requestId: mutationId,
      quoteVersion: recovery.acceptedQuoteVersion,
      createdAt: context.now,
      updatedAt: context.now,
    };
    await claimRef.set({ data: claim });
    await recoveryRef.update({
      data: {
        payableStatus: "reserved",
        activeClaimId: claimId,
        reservedAt: context.now,
        version: Number(recovery.version || 0) + 1,
        updatedAt: context.now,
      },
    });
    const reserveEntryId = deterministicId("fin_", "claim_reserved", claimId);
    await context.transaction.collection(COLLECTIONS.finance).doc(reserveEntryId).set({
      data: {
        type: "claim_reserved",
        businessType: "market_recovery_claim",
        businessId: claimId,
        recoveryOrderId: recoveryId,
        ownerUserId: user._id,
        amountFen,
        createdAt: context.now,
      },
    });
    await writeAudit(context.transaction, context, {
      targetType: "claim",
      targetId: claimId,
      resultStatus: claim.status,
      amountFen,
    });
    return { created: true, claim: publicClaim(claim) };
  });
};

const claimList = async (event) => {
  const user = await requireUser();
  const where = { ownerUserId: user._id };
  if (event.status !== undefined) {
    const status = text(event.status, "领取状态", 40, true);
    ensure(CLAIM_STATUS.includes(status), "INVALID_INPUT", "领取状态不正确");
    where.status = status;
  }
  return listQuery(COLLECTIONS.claims, where, event, (item) => publicClaim(item));
};

const claimGet = async (event) => {
  const user = await requireUser();
  const claimId = id(event.claimId || event.id, "领取单ID");
  const claim = await readOptional(db.collection(COLLECTIONS.claims).doc(claimId));
  ensure(claim && claim.ownerUserId === user._id, "CLAIM_NOT_FOUND", "领取单不存在");
  return { claim: publicClaim(claim, { includePackage: true }) };
};

const adminClaimList = async (event) => {
  await requireAdmin();
  const where = {};
  if (event.status !== undefined) {
    const status = text(event.status, "领取状态", 40, true);
    ensure(CLAIM_STATUS.includes(status), "INVALID_INPUT", "领取状态不正确");
    where.status = status;
  }
  return listQuery(COLLECTIONS.claims, where, event, (item) => publicClaim(item, { admin: true }));
};

const adminInventoryList = async (event) => {
  await requireAdmin();
  const where = {};
  if (event.status !== undefined) {
    const status = text(event.status, "库存状态", 40, true);
    ensure(INVENTORY_STATUS.includes(status), "INVALID_INPUT", "库存状态不正确");
    where.status = status;
  }
  return listQuery(COLLECTIONS.inventory, where, event, (item) => publicInventory(item, { admin: true }));
};

const adminStock = async (event) => {
  const admin = await requireAdmin();
  const inventoryId = id(event.inventoryId || event.id, "库存ID");
  const targetStatus = text(event.status || event.targetStatus, "库存状态", 20, true);
  ensure(["on_sale", "off_sale"].includes(targetStatus), "INVALID_INPUT", "库存只能上架或下架");
  const recordVersion = expectedVersion(event.expectedVersion);
  const mutationId = requestId(event.requestId || event.idempotencyKey);
  const payload = { inventoryId, targetStatus, recordVersion };

  return runIdempotent({ actor: admin, action: "adminStock", mutationId, payload }, async (context) => {
    const inventoryRef = context.transaction.collection(COLLECTIONS.inventory).doc(inventoryId);
    const current = await readOptional(inventoryRef);
    ensure(Boolean(current), "INVENTORY_NOT_FOUND", "平台库存不存在");
    checkVersion(current, recordVersion);
    ensure(
      ["on_sale", "off_sale"].includes(current.status),
      "INVALID_STATE",
      "锁定或已售库存不能上下架"
    );
    ensure(!current.saleOrderId && !current.lockExpiresAt, "INVENTORY_LOCKED", "库存已绑定销售订单，不能上下架");

    const linkedGoodsId = id(current.goodsId || current.sourceGoodsId, "商品ID");
    ensure(
      !current.goodsId || !current.sourceGoodsId || current.goodsId === current.sourceGoodsId,
      "DATA_CONFLICT",
      "库存商品绑定不一致"
    );
    const goodsRef = context.transaction.collection(COLLECTIONS.goods).doc(linkedGoodsId);
    const goods = await readOptional(goodsRef);
    ensure(Boolean(goods), "GOODS_NOT_FOUND", "平台商品不存在");
    ensure(
      goods.platformOwned === true && goods.inventoryId === inventoryId,
      "DATA_CONFLICT",
      "平台商品与库存绑定不一致"
    );

    const platformSalePriceFen = integer(current.platformSalePriceFen, "平台销售价", 1, 99999999);
    const goodsStatus = targetStatus === "on_sale" ? "on_sale" : "removed";
    const inventoryChanged = current.status !== targetStatus
      || current.goodsId !== linkedGoodsId
      || current.sourceGoodsId !== linkedGoodsId;
    const goodsChanged = goods.status !== goodsStatus
      || Number(goods.platformSalePriceFen || 0) !== platformSalePriceFen;
    if (!inventoryChanged && !goodsChanged) {
      return { inventory: publicInventory(current, { admin: true }), changed: false };
    }

    const inventoryPatch = {
      status: targetStatus,
      goodsId: linkedGoodsId,
      sourceGoodsId: linkedGoodsId,
      version: Number(current.version || 0) + 1,
      updatedAt: context.now,
    };
    await inventoryRef.update({ data: inventoryPatch });
    await goodsRef.update({
      data: {
        status: goodsStatus,
        platformOwned: true,
        inventoryId,
        platformSalePriceFen,
        price: platformSalePriceFen / 100,
        updatedAt: context.now,
      },
    });
    await writeAudit(context.transaction, context, {
      targetType: "inventory",
      targetId: inventoryId,
      resultStatus: targetStatus,
      amountFen: platformSalePriceFen,
    });
    return {
      inventory: publicInventory({ ...current, ...inventoryPatch }, { admin: true }),
      changed: true,
    };
  });
};

const isExpiryTimer = (event) => Boolean(
  event
  && (event.Type === "Timer" || event.type === "timer")
  && event.TriggerName === "expire-market-sale-orders"
);

const dispatch = async (event = {}) => {
  if (isExpiryTimer(event)) return { expiredCount: await expirePendingSales(50) };
  const rawType = text(event.type, "操作类型", 80, true);
  const type = ACTION_ALIASES[rawType] || rawType;
  switch (type) {
    case "recoverySubmit":
      return recoverySubmit(event);
    case "recoveryList":
      return recoveryList(event);
    case "recoveryGet":
      return recoveryGet(event);
    case "adminRecoveryList":
      return adminRecoveryList(event);
    case "adminRecoveryGet":
      return adminRecoveryGet(event);
    case "adminQuote":
      return adminQuote(event);
    case "quoteAccept":
      return quoteAccept(event);
    case "adminInspect":
      return adminInspect(event);
    case "adminConfirmAcquisition":
      return adminConfirmAcquisition(event);
    case "catalogList":
      return catalogList(event);
    case "catalogGet":
      return catalogGet(event);
    case "saleCreate":
      return saleCreate(event);
    case "saleList":
      return saleList(event);
    case "saleGet":
      return saleGet(event);
    case "saleCancel":
      return saleCancel(event);
    case "salePreparePayment":
      return salePreparePayment(event);
    case "adminSaleList":
      return adminSaleList(event);
    case "claimCreate":
      return claimCreate(event);
    case "claimList":
      return claimList(event);
    case "claimGet":
      return claimGet(event);
    case "adminClaimList":
      return adminClaimList(event);
    case "adminInventoryList":
      return adminInventoryList(event);
    case "adminStock":
      return adminStock(event);
    case "expirePendingSales":
      await requireAdmin();
      return { expiredCount: await expirePendingSales(50) };
    default:
      throw new BusinessError("UNKNOWN_ACTION", "未知操作");
  }
};

exports.main = async (event = {}) => {
  try {
    return ok(await dispatch(event));
  } catch (error) {
    if (error instanceof BusinessError) return fail(error.message, error.code);
    console.error("[market] unexpected error", {
      type: event && event.type,
      message: errorText(error),
      stack: error && error.stack,
    });
    return fail("市场服务暂时不可用", "INTERNAL_ERROR");
  }
};

exports._private = {
  COLLECTIONS,
  ACTION_ALIASES,
  dispatch,
  expirePendingSales,
};
