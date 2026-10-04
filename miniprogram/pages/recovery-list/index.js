const { callCloud, formatPrice, formatTime, requireLogin } = require("../../utils/cloud");
const {
  startRecoveryClaimTransfer,
  queryRecoveryClaimTransfer,
  logPaymentError,
} = require("../../utils/payment");

const RECOVERY_STATUS = {
  submitted: { text: "已提交", tip: "平台将在验货前给出回收报价" },
  quoted: { text: "待确认报价", tip: "请按平台通知确认报价并交付实物" },
  quote_accepted: { text: "已接受报价", tip: "请按约定交付实物" },
  accepted: { text: "已接受报价", tip: "请按约定交付实物" },
  inspecting: { text: "验货中", tip: "平台正在核对商品成色和配件" },
  inspected: { text: "验货通过", tip: "请等待平台确认收购并生成回收款" },
  acquisition_completed: { text: "收购完成", tip: "回收款已确认，可申请领取" },
  acquired: { text: "收购完成", tip: "回收款已确认，可申请领取" },
  completed: { text: "收购完成", tip: "回收款已确认，可申请领取" },
  rejected: { text: "未达成回收", tip: "本次申请已结束" },
  closed: { text: "已关闭", tip: "本次申请已结束" },
};

const CLAIM_STATUS = {
  reserved: { text: "待发起", tone: "waiting" },
  pending_channel: { text: "待渠道处理", tone: "waiting" },
  dispatching: { text: "正在发起转账", tone: "waiting" },
  wait_user_confirm: { text: "待确认收款", tone: "attention" },
  accepted: { text: "微信已受理", tone: "waiting" },
  processing: { text: "转账处理中", tone: "waiting" },
  transfering: { text: "转账处理中", tone: "waiting" },
  success: { text: "已到账", tone: "success" },
  fail: { text: "转账失败", tone: "danger" },
  cancelled: { text: "已撤销", tone: "danger" },
  canceling: { text: "撤销处理中", tone: "waiting" },
  needs_review: { text: "需要人工核对", tone: "danger" },
  unknown: { text: "状态核对中", tone: "waiting" },
};

const toKey = (value) => String(value || "").trim().toLowerCase();
const createIdempotencyKey = (prefix, id) => `${prefix}_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

const getList = (result, keys) => {
  const data = result && result.data;
  if (Array.isArray(data)) return data;
  const source = data && typeof data === "object" ? data : result || {};
  for (let index = 0; index < keys.length; index += 1) {
    if (Array.isArray(source[keys[index]])) return source[keys[index]];
  }
  return [];
};

const normalizeClaim = (claim) => {
  const state = toKey(claim.state || claim.channelStatus || claim.channelState || claim.status || "unknown");
  const info = CLAIM_STATUS[state] || CLAIM_STATUS.unknown;
  const amountFen = Number(claim.amountFen || claim.transferAmountFen || claim.netAmountFen || claim.amount || 0);
  return {
    ...claim,
    _id: claim._id || claim.id || claim.claimId || "",
    recoveryId: claim.recoveryId || claim.recoveryOrderId || claim.sourceRecoveryId || "",
    state,
    statusText: info.text,
    statusTone: info.tone,
    amountText: formatPrice(amountFen),
    createdText: formatTime(claim.createdAt),
    canConfirm: Boolean(claim.canRequestMerchantTransfer)
      || state === "wait_user_confirm"
      || (state === "transfering" && Boolean(claim.packageInfo || claim.package_info)),
    canStart: state === "reserved" || state === "not_started" || state === "ready",
    canQuery: ["reserved", "pending_channel", "dispatching", "accepted", "processing", "transfering", "canceling", "needs_review", "unknown"].indexOf(state) >= 0,
    terminalFailed: state === "fail" || state === "cancelled",
  };
};

const normalizeRecovery = (recovery, claimByRecovery) => {
  const state = toKey(recovery.state || recovery.status || "submitted");
  const info = RECOVERY_STATUS[state] || { text: recovery.status || "处理中", tip: "请等待平台更新处理结果" };
  const snapshot = recovery.goodsSnapshot || recovery.goods || {};
  const images = Array.isArray(snapshot.images) ? snapshot.images : [];
  const recoveryId = recovery._id || recovery.id || recovery.recoveryId || "";
  const claim = claimByRecovery[recoveryId] || null;
  const quote = recovery.quote || {};
  const netAmountFen = Number(recovery.payableAmountFen || quote.netAmountFen || 0);
  const claimableState = state === "acquired" || state === "completed" || state === "purchase_confirmed" || state === "acquisition_completed";
  let action = "";
  let actionText = "";
  if (claim && (claim.canConfirm || claim.canStart)) {
    action = "confirm";
    actionText = claim.canConfirm ? "确认收款" : "继续领取";
  } else if (claim && claim.canQuery) {
    action = "query";
    actionText = "刷新到账状态";
  } else if (claim && claim.terminalFailed && recovery.payableStatus === "available") {
    action = "create";
    actionText = "重新申请领取";
  } else if (state === "quoted" && quote.version) {
    action = "quote_accept";
    actionText = "确认回收报价";
  } else if (!claim && (recovery.claimable === true || claimableState) && netAmountFen > 0) {
    action = "create";
    actionText = "领取回收款";
  }

  return {
    ...recovery,
    _id: recoveryId,
    title: recovery.title || snapshot.title || "回收商品",
    cover: recovery.cover || images[0] || "/images/default-goods-image.png",
    statusText: info.text,
    statusTip: info.tip,
    createdText: formatTime(recovery.createdAt),
    quoteVersion: Number(quote.version || 0),
    quoteAmountText: formatPrice(quote.grossAmountFen || 0),
    feeAmountText: formatPrice(quote.feeAmountFen || 0),
    netAmountText: formatPrice(netAmountFen),
    hasConfirmedAmount: netAmountFen > 0,
    claim,
    action,
    actionText,
  };
};

Page({
  data: {
    recoveries: [],
    claims: [],
    loading: true,
    processingId: "",
    claimableCount: 0,
    processingCount: 0,
  },

  onShow() {
    if (!requireLogin()) return;
    this.loadData();
  },

  onPullDownRefresh() {
    this.loadData().finally(() => wx.stopPullDownRefresh());
  },

  async loadData() {
    this.setData({ loading: true });
    try {
      const results = await Promise.all([
        callCloud("market", { type: "recoveryList", page: 1, pageSize: 50 }, { silent: true }),
        callCloud("market", { type: "claimList", page: 1, pageSize: 50 }, { silent: true }),
      ]);
      const claims = getList(results[1], ["claims", "items", "list"]).map(normalizeClaim);
      const claimByRecovery = {};
      claims.forEach((claim) => {
        if (claim.recoveryId && !claimByRecovery[claim.recoveryId]) claimByRecovery[claim.recoveryId] = claim;
      });
      const recoveries = getList(results[0], ["recoveries", "items", "list"])
        .map((item) => normalizeRecovery(item, claimByRecovery));
      this.setData({
        recoveries,
        claims,
        claimableCount: recoveries.filter((item) => item.action === "create").length,
        processingCount: claims.filter((item) => item.canConfirm || item.canQuery).length,
      });
    } catch (error) {
      wx.showToast({ title: (error.message || "回收记录加载失败").slice(0, 20), icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  onClaimTap(e) {
    const action = e.currentTarget.dataset.action;
    const recoveryId = e.currentTarget.dataset.recoveryId;
    const claimId = e.currentTarget.dataset.claimId;
    if (action === "create") this.createClaim(recoveryId);
    if (action === "confirm") this.confirmClaim(claimId);
    if (action === "query") this.queryClaim(claimId);
    if (action === "quote_accept") this.acceptQuote(recoveryId);
  },

  acceptQuote(recoveryId) {
    const recovery = this.data.recoveries.find((item) => item._id === recoveryId);
    if (!recovery || !recovery.quoteVersion || this.data.processingId) return;
    wx.showModal({
      title: "确认回收报价",
      content: `回收总价 ¥${recovery.quoteAmountText}，费用 ¥${recovery.feeAmountText}，确认后可得 ¥${recovery.netAmountText}。实物验收需要改价时，你还会再次确认。`,
      confirmText: "接受报价",
      confirmColor: "#174c3b",
      success: async (modal) => {
        if (!modal.confirm) return;
        this.setData({ processingId: recoveryId });
        try {
          await callCloud("market", {
            type: "quoteAccept",
            recoveryId,
            quoteVersion: recovery.quoteVersion,
            idempotencyKey: createIdempotencyKey("accept_quote", recoveryId),
          }, { loadingText: "正在确认", silent: true });
          wx.showToast({ title: "报价已确认", icon: "success" });
        } catch (error) {
          wx.showToast({ title: (error.message || "报价确认失败").slice(0, 20), icon: "none" });
        } finally {
          await this.loadData();
          this.setData({ processingId: "" });
        }
      },
    });
  },

  async createClaim(recoveryId) {
    if (!recoveryId || this.data.processingId) return;
    this.setData({ processingId: recoveryId });
    let claimId = "";
    try {
      const result = await callCloud("market", {
        type: "claimCreate",
        recoveryId,
        idempotencyKey: createIdempotencyKey("claim", recoveryId),
      }, { loadingText: "正在创建领取单", silent: true });
      const claim = result.data && result.data.claim ? result.data.claim : (result.data || {});
      claimId = claim._id || claim.id || claim.claimId || result.id || "";
      if (!claimId) throw new Error("领取单创建成功，但未返回领取单编号");
      await this.openTransferConfirmation(claimId);
    } catch (error) {
      this.showTransferError(error);
    } finally {
      if (claimId) await this.refreshClaimFromBusiness(claimId);
      else await this.loadData();
      this.setData({ processingId: "" });
    }
  },

  async confirmClaim(claimId) {
    if (!claimId || this.data.processingId) return;
    this.setData({ processingId: claimId });
    try {
      await this.openTransferConfirmation(claimId);
    } catch (error) {
      this.showTransferError(error);
    } finally {
      await this.refreshClaimFromBusiness(claimId);
      this.setData({ processingId: "" });
    }
  },

  async openTransferConfirmation(claimId) {
    const transfer = await startRecoveryClaimTransfer(claimId);
    if (toKey(transfer.state) === "wait_user_confirm") {
      wx.showToast({ title: "已返回，正在核对到账", icon: "none" });
    } else {
      wx.showToast({ title: "领取状态已更新", icon: "none" });
    }
  },

  async queryClaim(claimId) {
    if (!claimId || this.data.processingId) return;
    this.setData({ processingId: claimId });
    try {
      await queryRecoveryClaimTransfer(claimId);
      await this.refreshClaimFromBusiness(claimId);
      wx.showToast({ title: "到账状态已刷新", icon: "none" });
    } catch (error) {
      logPaymentError(error);
      wx.showToast({ title: (error.message || "暂时无法查询").slice(0, 20), icon: "none" });
      await this.refreshClaimFromBusiness(claimId);
    } finally {
      this.setData({ processingId: "" });
    }
  },

  async refreshClaimFromBusiness(claimId) {
    try {
      // 主动读取本人领取单；前端不依据微信页面的 success/cancel/fail 自行改状态。
      await callCloud("market", { type: "claimGet", id: claimId }, { silent: true });
    } catch (error) {
      console.warn("领取单刷新失败", error && error.code);
    }
    await this.loadData();
  },

  showTransferError(error) {
    const message = String(error && (error.errMsg || error.message) || "未完成收款确认");
    if (/cancel/i.test(message) || message.indexOf("取消") >= 0) {
      wx.showToast({ title: "已取消，可稍后继续确认", icon: "none" });
      return;
    }
    logPaymentError(error);
    wx.showModal({
      title: "暂未确认到账",
      content: `${message.replace(/^requestMerchantTransfer:fail\s*/i, "").slice(0, 180)}\n请刷新领取状态后再操作。`,
      showCancel: false,
    });
  },

  goMarket() {
    wx.switchTab({ url: "/pages/home/index" });
  },
});
