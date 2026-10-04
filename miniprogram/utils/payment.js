const { callCloud } = require("./cloud");

// wx.requestPayment 的失败对象使用 errMsg，不一定是带 message 的 Error。
const normalizePaymentError = (value, stage, fallback = "支付服务调用失败") => {
  const source = value || {};
  const message = typeof value === "string"
    ? value : source.errMsg || source.message || source.msg || fallback;
  const error = new Error(String(message));
  error.errMsg = error.message;
  error.stage = stage || source.stage || "payment";
  ["errno", "errCode", "code", "statusCode"].forEach((key) => {
    if (typeof source[key] === "number" || typeof source[key] === "string") error[key] = source[key];
  });
  return error;
};

const getPaymentErrorInfo = (value) => {
  const error = normalizePaymentError(value);
  const message = error.message.trim();
  const nativeError = error.stage === "requestPayment" || /^requestPayment:/i.test(message);
  const cancelled = nativeError && /^(?:requestPayment:fail\s*)?(?:cancel(?:led|ed)?|用户取消(?:支付)?)$/i.test(message);
  // 只有明确的权限/违规提示才归类为受限，不能把任意 errno=102 或 HTTP 403 当成违规。
  const restricted = /小程序违规|商户涉嫌违规/.test(message)
    || (nativeError && /banned|access denied|no permission|支付功能暂时无法使用/i.test(message));
  const codes = ["errno", "errCode", "code"]
    .filter((key) => error[key] !== undefined)
    .map((key) => `${key}=${String(error[key]).slice(0, 60)}`);
  const detail = restricted
    ? "微信暂时限制了本小程序的支付权限，请联系商家检查小程序后台通知及订单发货管理。反复重试无法解除限制。"
    : message.replace(/^requestPayment:fail\s*/i, "") || "微信未能调起支付，请稍后查看订单状态。";
  return {
    cancelled,
    title: restricted ? "微信支付受限" : "暂时无法支付",
    content: `${detail.slice(0, 240)}${codes.length ? `\n错误码：${codes.join("，")}` : ""}`,
  };
};

const logPaymentError = (value) => {
  const error = normalizePaymentError(value);
  // 不输出完整错误对象、订单/付款人资料、prepay_id 或签名。
  console.warn("[payment]", {
    stage: error.stage, errno: error.errno, errCode: error.errCode,
    code: error.code, statusCode: error.statusCode,
  });
};

const getPaymentConfig = () => {
  const globalData = getApp().globalData || {};
  if (!globalData.paymentFunctionName) {
    throw new Error("支付函数未配置");
  }
  if (!globalData.paymentBusinessHookReady) {
    throw new Error("支付安全钩子未启用");
  }
  if (typeof wx.cloud.callHTTPFunction !== "function") {
    throw new Error("微信基础库版本过低");
  }
  return {
    env: globalData.env,
    functionName: globalData.paymentFunctionName,
  };
};

const callPayCommon = async (action, data) => {
  try {
    const config = getPaymentConfig();
    return await new Promise((resolve, reject) => {
      wx.cloud.callHTTPFunction({
        name: config.functionName,
        config: { env: config.env },
        method: "POST",
        header: { "Content-Type": "application/json" },
        path: `/wx-pay/${action}`,
        data,
        success: (res) => {
          try {
            const httpFailed = res.statusCode >= 300;
            let result = res.data;
            if (typeof result === "string") {
              try { result = JSON.parse(result); } catch (_) { result = null; }
            }
            if (!result || typeof result !== "object") {
              throw normalizePaymentError({ statusCode: res.statusCode }, action,
                httpFailed ? `支付服务 HTTP ${res.statusCode}` : "支付服务返回格式异常");
            }
            if (httpFailed || result.code !== 0) {
              throw normalizePaymentError({ ...result, statusCode: res.statusCode }, action,
                httpFailed ? `支付服务 HTTP ${res.statusCode}` : "支付服务调用失败");
            }
            // 支付函数把 SDK 的 { status, data } 包在 code=0 的响应内。
            // HTTP 200 / code=0 不代表上游微信接口成功。
            const upstream = result.data;
            if (upstream && upstream.status >= 300) {
              throw normalizePaymentError({ ...upstream.data, statusCode: upstream.status }, action,
                `微信支付接口 HTTP ${upstream.status}`);
            }
            resolve(result);
          } catch (error) {
            reject(error);
          }
        },
        fail: reject,
      });
    });
  } catch (error) {
    throw normalizePaymentError(error, action);
  }
};

const requestPayment = async (params) => {
  try {
    if (!params || !params.timeStamp || !params.nonceStr || !params.package || !params.paySign) {
      throw new Error("支付参数不完整");
    }
    await new Promise((resolve, reject) => {
      wx.requestPayment({
        timeStamp: String(params.timeStamp),
        nonceStr: params.nonceStr,
        package: params.package,
        signType: params.signType || "RSA",
        paySign: params.paySign,
        success: resolve,
        fail: reject,
      });
    });
  } catch (error) {
    throw normalizePaymentError(error, "requestPayment");
  }
};

const unwrapUpstreamData = (result) => {
  let data = result && result.data;
  if (data && typeof data === "object" && data.data && typeof data.data === "object") {
    data = data.data;
  }
  return data || {};
};

const queryMarketOrderPayment = async (outTradeNo) => {
  if (!outTradeNo) {
    throw normalizePaymentError(null, "wxpay_query_order_by_out_trade_no", "缺少商户订单号");
  }
  const query = await callPayCommon("wxpay_query_order_by_out_trade_no", {
    out_trade_no: outTradeNo,
  });
  const queryData = unwrapUpstreamData(query);
  return {
    tradeState: String(queryData.trade_state || "UNKNOWN").toUpperCase(),
    outTradeNo,
  };
};

const queryOrderAfterCashier = async (outTradeNo) => {
  try {
    return await queryMarketOrderPayment(outTradeNo);
  } catch (error) {
    // 收银台返回后查单超时不等于支付失败，订单状态仍由服务端回调或后续查单确认。
    logPaymentError(error);
    return { tradeState: "UNKNOWN", outTradeNo };
  }
};

const startOrderPayment = async (orderId) => {
  let prepared;
  try {
    prepared = await callCloud("orders", { type: "preparePayment", id: orderId }, { silent: true });
  } catch (error) {
    throw normalizePaymentError(error, "preparePayment");
  }
  const order = prepared.data;
  const unified = await callPayCommon("wxpay_order", {
    description: order.description,
    out_trade_no: order.outTradeNo,
    amount: { total: order.totalAmountFen, currency: "CNY" },
  });
  const paymentParams = unwrapUpstreamData(unified);
  await requestPayment(paymentParams);
  return queryOrderAfterCashier(order.outTradeNo);
};

// 市场订单的价格、商户单号和描述均由 market 云函数根据订单快照返回。
// 客户端只提交销售订单 ID，不能覆盖金额或付款人。
const startMarketOrderPayment = async (orderId) => {
  let prepared;
  try {
    prepared = await callCloud("market", {
      type: "salePreparePayment",
      id: orderId,
    }, { silent: true });
  } catch (error) {
    throw normalizePaymentError(error, "salePreparePayment");
  }

  const order = prepared && prepared.data;
  if (!order || !order.outTradeNo || !Number.isInteger(Number(order.totalAmountFen))) {
    throw normalizePaymentError(null, "salePreparePayment", "市场订单支付参数不完整");
  }

  const unified = await callPayCommon("wxpay_order", {
    description: order.description,
    out_trade_no: order.outTradeNo,
    amount: { total: Number(order.totalAmountFen), currency: "CNY" },
  });
  await requestPayment(unwrapUpstreamData(unified));
  return queryOrderAfterCashier(order.outTradeNo);
};

// C2C 担保订单同样只能由云端订单快照提供金额和商户订单号。客户端绝不提交
// 商品价格、卖家 openid、服务费或任何转账信息。
const startC2CMarketOrderPayment = async (orderId) => {
  let prepared;
  try {
    prepared = await callCloud("c2c-market", {
      type: "preparePayment",
      id: orderId,
    }, { silent: true });
  } catch (error) {
    throw normalizePaymentError(error, "c2cPreparePayment");
  }
  const order = prepared && prepared.data && prepared.data.order;
  if (!order || !order.outTradeNo || !Number.isInteger(Number(order.totalAmountFen))) {
    throw normalizePaymentError(null, "c2cPreparePayment", "担保订单支付参数不完整");
  }
  const unified = await callPayCommon("wxpay_order", {
    description: order.description,
    out_trade_no: order.outTradeNo,
    amount: { total: Number(order.totalAmountFen), currency: "CNY" },
  });
  await requestPayment(unwrapUpstreamData(unified));
  return queryOrderAfterCashier(order.outTradeNo);
};

const requestMerchantTransfer = async (transfer) => {
  const packageInfo = transfer && transfer.package_info;
  const mchId = transfer && transfer.mchId;
  const appId = transfer && transfer.appId;
  if (!packageInfo || !mchId || !appId) {
    throw normalizePaymentError(null, "requestMerchantTransfer", "微信收款确认参数不完整");
  }
  if (typeof wx.requestMerchantTransfer !== "function") {
    throw normalizePaymentError(null, "requestMerchantTransfer", "微信版本过低，请升级后确认收款");
  }
  if (typeof wx.canIUse === "function" && !wx.canIUse("requestMerchantTransfer")) {
    throw normalizePaymentError(null, "requestMerchantTransfer", "当前微信版本不支持确认收款，请升级微信");
  }

  const accountInfo = typeof wx.getAccountInfoSync === "function" ? wx.getAccountInfoSync() : null;
  const currentAppId = accountInfo && accountInfo.miniProgram && accountInfo.miniProgram.appId;
  if (currentAppId && currentAppId !== appId) {
    throw normalizePaymentError(null, "requestMerchantTransfer", "收款 AppID 与当前小程序不一致");
  }

  try {
    await new Promise((resolve, reject) => {
      wx.requestMerchantTransfer({
        mchId,
        appId,
        package: packageInfo,
        success: resolve,
        fail: reject,
      });
    });
  } catch (error) {
    throw normalizePaymentError(error, "requestMerchantTransfer", "未完成微信收款确认");
  }
};

// HTTP 入口只接收领取单 ID。金额、openid、场景 1010 和商户单号由后端从可信领取单构造。
// 微信页面 success 只表示用户已从确认页返回，不代表款项已经到账。
const startRecoveryClaimTransfer = async (claimId) => {
  const result = await callPayCommon("market_claim_transfer", { claim_id: claimId });
  const transfer = unwrapUpstreamData(result);
  if (["WAIT_USER_CONFIRM", "TRANSFERING"].includes(transfer.state) && transfer.package_info) {
    let interactionError = null;
    try {
      await requestMerchantTransfer(transfer);
    } catch (error) {
      interactionError = error;
    }

    // 官方确认页返回 ok 只表示页面展示成功。无论用户确认还是取消，都查原单同步可信状态。
    let queried = transfer;
    try {
      queried = await queryRecoveryClaimTransfer(claimId);
    } catch (error) {
      logPaymentError(error);
    }
    if (interactionError) throw interactionError;
    return queried;
  }
  return transfer;
};

const queryRecoveryClaimTransfer = async (claimId) => {
  const result = await callPayCommon("market_claim_transfer_query", { claim_id: claimId });
  return unwrapUpstreamData(result);
};

module.exports = {
  callPayCommon,
  startOrderPayment,
  startMarketOrderPayment,
  startC2CMarketOrderPayment,
  queryMarketOrderPayment,
  startRecoveryClaimTransfer,
  queryRecoveryClaimTransfer,
  getPaymentErrorInfo,
  logPaymentError,
};
