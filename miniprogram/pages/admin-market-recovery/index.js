const { callCloud, formatPrice, formatTime } = require("../../utils/cloud");

const STATUS_INFO = {
  submitted: { text: "待报价", tip: "核对商品资料后填写回收价与平台销售价" },
  quoted: { text: "待用户确认", tip: "用户确认当前报价后才能验收实物" },
  quote_accepted: { text: "待验货", tip: "收到实物后核对成色；不要提前确认收购" },
  inspected: { text: "验货已通过", tip: "确认实物已由平台接收后，完成收购并生成库存" },
  acquisition_completed: { text: "已收购上架", tip: "已产生平台应付款并生成平台销售库存" },
  closed: { text: "已关闭", tip: "本次回收申请已结束" },
};

const createIdempotencyKey = (prefix, id) => `${prefix}_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

const listFromResult = (result) => {
  const data = result && result.data;
  if (Array.isArray(data)) return data;
  return data && (data.items || data.recoveries || data.list) || [];
};

const amountInput = (fen) => Number(fen || 0) > 0 ? formatPrice(fen) : "";

const normalizeRecovery = (item) => {
  const status = String(item.status || "submitted").toLowerCase();
  const info = STATUS_INFO[status] || { text: item.status || "处理中", tip: "请核对当前回收状态" };
  const goods = item.goods || item.goodsSnapshot || {};
  const images = Array.isArray(goods.images) ? goods.images : [];
  const quote = item.quote || null;
  return {
    ...item,
    _id: item._id || item.id || item.recoveryId || "",
    status,
    statusText: info.text,
    statusTip: info.tip,
    title: goods.title || item.title || "回收商品",
    desc: goods.desc || "暂无商品描述",
    cover: images[0] || "/images/default-goods-image.png",
    ownerText: item.ownerDisplayName || item.ownerUserId || "回收用户",
    createdText: formatTime(item.createdAt),
    quote,
    quoteYuan: amountInput(quote && quote.grossAmountFen),
    salePriceYuan: amountInput(quote && quote.platformSalePriceFen),
    conditionInput: item.inspection && item.inspection.condition || goods.condition || "",
    inspectionNote: "",
    canQuote: status === "submitted" || status === "quoted",
    canInspect: status === "quote_accepted",
    canConfirm: status === "inspected",
    quoteGrossText: formatPrice(quote && quote.grossAmountFen),
    quoteNetText: formatPrice(quote && quote.netAmountFen),
    salePriceText: formatPrice(quote && quote.platformSalePriceFen),
  };
};

const yuanToFen = (value, label) => {
  const text = String(value || "").trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`${label}请输入最多两位小数的金额`);
  const fen = Math.round(Number(text) * 100);
  if (!Number.isSafeInteger(fen) || fen <= 0) throw new Error(`${label}必须大于0元`);
  return fen;
};

Page({
  data: {
    tabs: [
      { key: "", text: "全部" },
      { key: "submitted", text: "待报价" },
      { key: "quoted", text: "待确认" },
      { key: "quote_accepted", text: "待验货" },
      { key: "inspected", text: "待收购" },
    ],
    activeStatus: "",
    recoveries: [],
    loading: true,
    processingId: "",
  },

  onShow() {
    const user = wx.getStorageSync("user");
    if (!user || user.role !== "admin") {
      wx.showToast({ title: "无市场管理权限", icon: "none" });
      setTimeout(() => wx.navigateBack(), 350);
      return;
    }
    this.loadRecoveries();
  },

  onPullDownRefresh() {
    this.loadRecoveries().finally(() => wx.stopPullDownRefresh());
  },

  async loadRecoveries() {
    this.setData({ loading: true });
    try {
      const request = {
        type: "adminRecoveryList",
        page: 1,
        pageSize: 50,
      };
      if (this.data.activeStatus) request.status = this.data.activeStatus;
      const result = await callCloud("market", request, { silent: true });
      this.setData({ recoveries: listFromResult(result).map(normalizeRecovery) });
    } catch (error) {
      wx.showToast({ title: (error.message || "回收工作台加载失败").slice(0, 20), icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  switchTab(e) {
    this.setData({ activeStatus: e.currentTarget.dataset.status }, () => this.loadRecoveries());
  },

  onDraftInput(e) {
    const index = Number(e.currentTarget.dataset.index);
    const field = e.currentTarget.dataset.field;
    this.setData({ [`recoveries[${index}].${field}`]: e.detail.value });
  },

  getRecovery(index) {
    return this.data.recoveries[Number(index)] || null;
  },

  async saveQuote(e) {
    const recovery = this.getRecovery(e.currentTarget.dataset.index);
    if (!recovery || this.data.processingId) return;
    try {
      const grossAmountFen = yuanToFen(recovery.quoteYuan, "回收价");
      const platformSalePriceFen = yuanToFen(recovery.salePriceYuan, "销售价");
      if (grossAmountFen >= 200000) throw new Error("当前回收款必须低于2000元");
      this.setData({ processingId: recovery._id });
      await callCloud("market", {
        type: "adminQuote",
        recoveryId: recovery._id,
        expectedVersion: Number(recovery.version || 0),
        grossAmountFen,
        feeAmountFen: 0,
        platformSalePriceFen,
        remark: "平台回收报价，实物验收后确认",
        idempotencyKey: createIdempotencyKey("admin_quote", recovery._id),
      }, { loadingText: "正在保存报价", silent: true });
      wx.showToast({ title: "报价已提交用户确认", icon: "success" });
      await this.loadRecoveries();
    } catch (error) {
      wx.showToast({ title: (error.message || "报价失败").slice(0, 20), icon: "none" });
    } finally {
      this.setData({ processingId: "" });
    }
  },

  inspectPassed(e) {
    const recovery = this.getRecovery(e.currentTarget.dataset.index);
    if (!recovery || this.data.processingId) return;
    wx.showModal({
      title: "确认验货通过",
      content: "请确认平台已经收到并现场核对实物、配件与成色。本操作只记录验货通过，下一步仍需单独确认收购。",
      confirmText: "验货通过",
      confirmColor: "#174c3b",
      success: (modal) => {
        if (modal.confirm) this.submitInspection(recovery, "passed");
      },
    });
  },

  inspectReprice(e) {
    const recovery = this.getRecovery(e.currentTarget.dataset.index);
    if (!recovery || this.data.processingId) return;
    wx.showModal({
      title: "验货后调整报价",
      content: "将使用卡片中当前填写的回收价与销售价生成新报价。用户必须再次接受，之后才能继续收购。",
      confirmText: "发送新报价",
      confirmColor: "#a36f18",
      success: (modal) => {
        if (modal.confirm) this.submitInspection(recovery, "reprice");
      },
    });
  },

  async submitInspection(recovery, result) {
    this.setData({ processingId: recovery._id });
    try {
      const payload = {
        type: "adminInspect",
        recoveryId: recovery._id,
        expectedVersion: Number(recovery.version || 0),
        result,
        condition: String(recovery.conditionInput || "").trim(),
        note: result === "reprice" ? "实物验收后调整报价，请用户重新确认" : String(recovery.inspectionNote || "").trim(),
        idempotencyKey: createIdempotencyKey(`inspect_${result}`, recovery._id),
      };
      if (result === "reprice") {
        payload.grossAmountFen = yuanToFen(recovery.quoteYuan, "新回收价");
        payload.feeAmountFen = 0;
        payload.platformSalePriceFen = yuanToFen(recovery.salePriceYuan, "新销售价");
        if (payload.grossAmountFen >= 200000) throw new Error("当前回收款必须低于2000元");
      }
      await callCloud("market", payload, { loadingText: "正在保存验货结果", silent: true });
      wx.showToast({ title: result === "passed" ? "验货结果已保存" : "新报价已发送", icon: "success" });
      await this.loadRecoveries();
    } catch (error) {
      wx.showToast({ title: (error.message || "验货结果保存失败").slice(0, 20), icon: "none" });
    } finally {
      this.setData({ processingId: "" });
    }
  },

  confirmAcquisition(e) {
    const recovery = this.getRecovery(e.currentTarget.dataset.index);
    if (!recovery || !recovery.quote || this.data.processingId) return;
    wx.showModal({
      title: "确认平台完成收购",
      content: `请确认实物已归平台且最终报价已由用户接受。确认后立即产生 ¥${recovery.quoteNetText} 回收应付款，并以 ¥${recovery.salePriceText} 生成平台商品。`,
      confirmText: "确认收购",
      confirmColor: "#b5473c",
      success: async (modal) => {
        if (!modal.confirm) return;
        this.setData({ processingId: recovery._id });
        try {
          await callCloud("market", {
            type: "adminConfirmAcquisition",
            recoveryId: recovery._id,
            expectedVersion: Number(recovery.version || 0),
            quoteVersion: Number(recovery.quote.version),
            salePriceFen: Number(recovery.quote.platformSalePriceFen),
            idempotencyKey: createIdempotencyKey("confirm_acquisition", recovery._id),
          }, { loadingText: "正在确认收购", silent: true });
          wx.showToast({ title: "已收购并生成平台商品", icon: "success" });
          await this.loadRecoveries();
        } catch (error) {
          wx.showModal({ title: "确认收购失败", content: (error.message || "请刷新后核对状态").slice(0, 180), showCancel: false });
        } finally {
          this.setData({ processingId: "" });
        }
      },
    });
  },
});
