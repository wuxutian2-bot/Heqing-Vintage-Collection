const crypto = require("crypto");

const RECOVERY_STATUS = Object.freeze([
  "submitted",
  "quoted",
  "quote_accepted",
  "inspected",
  "acquisition_completed",
  "closed",
]);

const INVENTORY_STATUS = Object.freeze(["on_sale", "locked", "sold", "off_sale"]);
const SALE_STATUS = Object.freeze([
  "pending_payment",
  "paid",
  "delivering",
  "completed",
  "cancelled",
  "expired",
  "refunding",
  "refunded",
  "payment_exception",
]);
const CLAIM_STATUS = Object.freeze([
  "reserved",
  "dispatching",
  "wait_user_confirm",
  "accepted",
  "processing",
  "success",
  "fail",
  "canceling",
  "cancelled",
  "needs_review",
]);

const TRANSFER_SCENE_ID = "1010";
const TRANSFER_REPORT_TYPE = "回收商品名称";
const TRANSFER_REMARK = "二手回收货款";
const MIN_TRANSFER_FEN = 10;
const MAX_TRANSFER_FEN_EXCLUSIVE = 200000;
const ORDER_TTL_MS = 15 * 60 * 1000;

class BusinessError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "BusinessError";
    this.code = code;
  }
}

const ensure = (condition, code, message) => {
  if (!condition) throw new BusinessError(code, message);
};

const text = (value, fieldName, maxLength, required = false) => {
  ensure(
    value === undefined || value === null || typeof value === "string",
    "INVALID_INPUT",
    `${fieldName}格式不正确`
  );
  const valueText = String(value || "").trim();
  if (required) ensure(Boolean(valueText), "INVALID_INPUT", `缺少${fieldName}`);
  ensure(valueText.length <= maxLength, "INVALID_INPUT", `${fieldName}过长`);
  return valueText;
};

const id = (value, fieldName = "ID") => {
  const valueText = text(value, fieldName, 64, true);
  ensure(/^[A-Za-z0-9_-]+$/.test(valueText), "INVALID_INPUT", `${fieldName}格式不正确`);
  return valueText;
};

const requestId = (value) => {
  const valueText = text(value, "请求标识", 64, true);
  ensure(
    valueText.length >= 8 && /^[A-Za-z0-9_-]+$/.test(valueText),
    "INVALID_REQUEST_ID",
    "请求标识格式不正确"
  );
  return valueText;
};

const integer = (value, fieldName, minimum, maximum) => {
  ensure(
    typeof value === "number" && Number.isInteger(value),
    "INVALID_AMOUNT",
    `${fieldName}必须是整数分`
  );
  ensure(value >= minimum && value <= maximum, "INVALID_AMOUNT", `${fieldName}超出允许范围`);
  return value;
};

const version = (value, fieldName = "数据版本") => {
  ensure(
    typeof value === "number" && Number.isInteger(value) && value >= 0,
    "INVALID_VERSION",
    `${fieldName}必须是非负整数`
  );
  return value;
};

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = stableValue(value[key]);
      return result;
    }, {});
  }
  return value instanceof Date ? value.toISOString() : value;
};

const digest = (value) => crypto
  .createHash("sha256")
  .update(JSON.stringify(stableValue(value)))
  .digest("hex");

const deterministicId = (prefix, ...parts) => `${prefix}${digest(parts).slice(0, 40 - prefix.length)}`;
const makeRecoveryId = (goodsId) => deterministicId("rec_", goodsId);
const makeInventoryId = (recoveryId) => deterministicId("inv_", recoveryId);
const makeSaleOrderId = (buyerUserId, mutationId) => deterministicId("mso_", buyerUserId, mutationId);
// 每次明确终态失败/撤销后可以创建新的领取尝试；同一幂等请求仍得到同一 claimId。
const makeClaimId = (recoveryId, mutationId = "attempt-1") => deterministicId("clm_", recoveryId, mutationId);
const makeOutTradeNo = (saleOrderId) => `MS${digest(saleOrderId).slice(0, 30).toUpperCase()}`;
const makeOutBillNo = (claimId) => `MR${digest(claimId).slice(0, 30).toUpperCase()}`;

const validImages = (images) => {
  if (images === undefined || images === null) return [];
  ensure(Array.isArray(images), "INVALID_INPUT", "验货图片格式不正确");
  ensure(images.length <= 9, "INVALID_INPUT", "验货图片最多9张");
  return images.map((image) => {
    const value = text(image, "图片地址", 1024, true);
    ensure(
      value.startsWith("cloud://") || /^https:\/\//i.test(value),
      "INVALID_INPUT",
      "图片地址格式不正确"
    );
    return value;
  });
};

const validateQuote = (input, now = new Date()) => {
  const grossAmountFen = integer(input.grossAmountFen, "回收总价", MIN_TRANSFER_FEN, MAX_TRANSFER_FEN_EXCLUSIVE - 1);
  const feeAmountFen = input.feeAmountFen === undefined
    ? 0
    : integer(input.feeAmountFen, "服务费", 0, MAX_TRANSFER_FEN_EXCLUSIVE - 1);
  ensure(feeAmountFen === 0, "FEE_DISABLED", "当前未启用回收服务费");
  ensure(feeAmountFen < grossAmountFen, "INVALID_AMOUNT", "服务费必须小于回收总价");
  const netAmountFen = grossAmountFen - feeAmountFen;
  ensure(
    netAmountFen >= MIN_TRANSFER_FEN && netAmountFen < MAX_TRANSFER_FEN_EXCLUSIVE,
    "TRANSFER_AMOUNT_UNSUPPORTED",
    "净回收款必须在0.10元至2000元以下"
  );
  const platformSalePriceFen = integer(
    input.platformSalePriceFen,
    "平台销售价",
    1,
    99999999
  );
  const remark = text(input.remark, "报价说明", 500, false);
  let expiresAt;
  if (input.quoteExpiresAt === undefined || input.quoteExpiresAt === null || input.quoteExpiresAt === "") {
    expiresAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  } else {
    ensure(
      typeof input.quoteExpiresAt === "string" || input.quoteExpiresAt instanceof Date,
      "INVALID_INPUT",
      "报价有效期格式不正确"
    );
    expiresAt = new Date(input.quoteExpiresAt);
    ensure(!Number.isNaN(expiresAt.getTime()), "INVALID_INPUT", "报价有效期格式不正确");
    ensure(expiresAt.getTime() > now.getTime(), "INVALID_INPUT", "报价有效期必须晚于当前时间");
    ensure(
      expiresAt.getTime() <= now.getTime() + 30 * 24 * 60 * 60 * 1000,
      "INVALID_INPUT",
      "报价有效期不能超过30天"
    );
  }
  return {
    grossAmountFen,
    feeAmountFen,
    netAmountFen,
    platformSalePriceFen,
    feeRuleVersion: "fee-disabled-v1",
    remark,
    expiresAt,
  };
};

const expectedVersion = (value) => version(value, "数据版本");

const pageInput = (input = {}) => {
  const page = input.page === undefined ? 1 : Number(input.page);
  const pageSize = input.pageSize === undefined ? 20 : Number(input.pageSize);
  ensure(Number.isInteger(page) && page >= 1 && page <= 10000, "INVALID_INPUT", "页码不正确");
  ensure(Number.isInteger(pageSize) && pageSize >= 1 && pageSize <= 50, "INVALID_INPUT", "每页数量不正确");
  return { page, pageSize, skip: (page - 1) * pageSize };
};

const forbiddenClaimFields = Object.freeze([
  "openid",
  "openId",
  "ownerOpenId",
  "amount",
  "amountFen",
  "transferAmount",
  "transferAmountFen",
  "outBillNo",
  "out_bill_no",
  "sceneId",
  "transferSceneId",
  "userName",
  "user_name",
  "reports",
  "notifyUrl",
  "notify_url",
]);

const assertClaimHasNoClientMoneyOrRecipient = (input) => {
  const badField = forbiddenClaimFields.find((field) => Object.prototype.hasOwnProperty.call(input || {}, field));
  ensure(!badField, "FORBIDDEN_FIELD", `领取申请不能提交字段：${badField}`);
};

const goodsTitleForTransfer = (title) => {
  const value = text(title, "商品名称", 60, true).slice(0, 32);
  ensure(Boolean(value), "INVALID_GOODS", "商品名称不能为空");
  return value;
};

const publicQuote = (quote) => quote ? ({
  version: quote.version,
  grossAmountFen: quote.grossAmountFen,
  feeAmountFen: quote.feeAmountFen,
  netAmountFen: quote.netAmountFen,
  platformSalePriceFen: quote.platformSalePriceFen,
  feeRuleVersion: quote.feeRuleVersion,
  remark: quote.remark || "",
  expiresAt: quote.expiresAt,
  createdAt: quote.createdAt,
}) : null;

const publicRecovery = (record, options = {}) => {
  const result = {
    _id: record._id,
    goodsId: record.sourceGoodsId,
    status: record.status,
    version: Number(record.version || 0),
    goods: record.goodsSnapshot || {},
    quote: publicQuote(record.quote),
    acceptedQuoteVersion: record.acceptedQuoteVersion || null,
    acceptedAt: record.acceptedAt || null,
    inspection: record.inspection || null,
    payableAmountFen: Number(record.payableAmountFen || 0),
    payableStatus: record.payableStatus || "not_confirmed",
    activeClaimId: record.activeClaimId || "",
    inventoryId: record.inventoryId || "",
    acquiredAt: record.acquiredAt || null,
    closedAt: record.closedAt || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (options.admin) {
    result.ownerUserId = record.ownerUserId;
    result.ownerDisplayName = record.ownerDisplayName || "";
  }
  return result;
};

const publicInventory = (item, options = {}) => {
  const goodsId = item.goodsId || item.sourceGoodsId || "";
  const result = {
    _id: item._id,
    goodsId,
    title: item.title,
    desc: item.desc || "",
    category: item.category || "其他",
    images: Array.isArray(item.images) ? item.images : [],
    condition: item.condition || "",
    priceFen: Number(item.platformSalePriceFen || 0),
    status: item.status,
    version: Number(item.version || 0),
    platformOwned: true,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
  if (options.admin) {
    result.recoveryOrderId = item.recoveryOrderId;
    result.acquisitionCostFen = Number(item.acquisitionCostFen || 0);
    result.saleOrderId = item.saleOrderId || "";
    result.lockExpiresAt = item.lockExpiresAt || null;
  }
  return result;
};

const publicSaleOrder = (order, options = {}) => {
  const result = {
    _id: order._id,
    orderNo: order.orderNo,
    outTradeNo: order.outTradeNo,
    inventoryId: order.inventoryId,
    goodsId: order.goodsId,
    item: order.itemSnapshot || {},
    totalAmountFen: Number(order.totalAmountFen || 0),
    status: order.status,
    paymentStatus: order.paymentStatus || "unpaid",
    note: order.note || "",
    expiresAt: order.expiresAt,
    paidAt: order.paidAt || null,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
  };
  if (options.admin) result.buyerUserId = order.buyerUserId;
  return result;
};

const publicClaim = (claim, options = {}) => {
  const result = {
    _id: claim._id,
    recoveryOrderId: claim.recoveryOrderId,
    goodsTitle: claim.goodsTitleSnapshot,
    transferAmountFen: Number(claim.transferAmountFen || 0),
    status: claim.status,
    channelStatus: claim.channelStatus || "NOT_STARTED",
    canRequestMerchantTransfer: ["WAIT_USER_CONFIRM", "TRANSFERING"].includes(
      String(claim.channelStatus || "").toUpperCase()
    ) && Boolean(claim.packageInfo),
    failureCode: claim.failureCode || "",
    failureReason: claim.failureReason || "",
    createdAt: claim.createdAt,
    updatedAt: claim.updatedAt,
    succeededAt: claim.succeededAt || null,
  };
  if (options.includePackage && result.canRequestMerchantTransfer) {
    result.packageInfo = claim.packageInfo;
  }
  if (options.admin) result.ownerUserId = claim.ownerUserId;
  return result;
};

module.exports = {
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
  version,
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
};
