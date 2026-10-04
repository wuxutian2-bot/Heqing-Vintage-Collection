const { callCloud, formatPrice, formatTime, requireLogin } = require("../../utils/cloud");
const {
  callPayCommon,
  startMarketOrderPayment,
  queryMarketOrderPayment,
  getPaymentErrorInfo,
  logPaymentError,
} = require("../../utils/payment");

const STATUS_INFO = {
  pending_payment: { title: "等待支付", desc: "平台库存已为这笔订单预留", tone: "attention" },
  paid: { title: "支付已确认", desc: "平台将按订单约定准备交付", tone: "success" },
  fulfilling: { title: "正在交付", desc: "请按订单约定核对并接收商品", tone: "success" },
  delivering: { title: "正在交付", desc: "请按订单约定核对并接收商品", tone: "success" },
  completed: { title: "订单已完成", desc: "本次平台商品交易已完成", tone: "success" },
  cancelled: { title: "订单已取消", desc: "库存预留将在安全核对后释放", tone: "muted" },
  expired: { title: "订单已超时", desc: "支付结果核对完成后释放库存", tone: "muted" },
  refunding: { title: "退款处理中", desc: "退款结果以微信支付记录为准", tone: "attention" },
  refunded: { title: "退款已完成", desc: "款项已按原支付渠道退回", tone: "muted" },
  payment_exception: { title: "支付结果核对中", desc: "请勿重复付款，平台正在查询原支付单", tone: "attention" },
};

const createIdempotencyKey = (prefix, id) => `${prefix}_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

const normalizeOrder = (order) => {
  const status = String(order.status || "pending_payment").toLowerCase();
  const info = STATUS_INFO[status] || { title: order.status || "处理中", desc: "请刷新查看最新订单状态", tone: "attention" };
  const snapshot = order.itemSnapshot || order.inventorySnapshot || order.goodsSnapshot || order.item || {};
  const images = Array.isArray(snapshot.images) ? snapshot.images : [];
  return {
    ...order,
    ...info,
    _id: order._id || order.id || order.saleOrderId || "",
    status,
    orderNo: order.orderNo || order.outTradeNo || "待生成",
    outTradeNo: order.outTradeNo || "",
    title: order.itemTitle || order.title || snapshot.title || "平台商品",
    description: order.itemDescription || snapshot.condition || snapshot.desc || snapshot.description || "平台回收验货商品",
    cover: order.cover || snapshot.cover || snapshot.image || images[0] || "/images/default-goods-image.png",
    totalAmountText: formatPrice(order.totalAmountFen || order.amountFen || snapshot.salePriceFen || 0),
    createdText: formatTime(order.createdAt),
    expiresText: formatTime(order.expiresAt),
    paidText: formatTime(order.paidAt),
    fulfillmentText: order.fulfillmentText || order.deliveryText || "具体交付安排以平台通知为准",
    canPay: status === "pending_payment",
    canCancel: status === "pending_payment",
  };
};

Page({
  data: {
    id: "",
    order: null,
    loading: true,
    paying: false,
    cancelling: false,
    refreshing: false,
    paymentReady: false,
  },

  onLoad(options) {
    const globalData = getApp().globalData || {};
    this.setData({
      id: options.id || "",
      paymentReady: Boolean(globalData.paymentFunctionName && globalData.paymentBusinessHookReady),
    });
  },

  onShow() {
    if (!requireLogin() || !this.data.id) return;
    this.loadOrder();
  },

  onPullDownRefresh() {
    this.syncPaymentState()
      .then(() => this.loadOrder(true))
      .finally(() => wx.stopPullDownRefresh());
  },

  async loadOrder(silent = false) {
    if (!silent) this.setData({ loading: true });
    try {
      const result = await callCloud("market", { type: "saleGet", id: this.data.id }, { silent: true });
      const raw = result.data && result.data.order ? result.data.order : (result.data || {});
      const order = normalizeOrder(raw);
      this.setData({ id: order._id || this.data.id, order });
    } catch (error) {
      wx.showToast({ title: (error.message || "订单加载失败").slice(0, 20), icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  async payOrder() {
    if (this.data.paying || !this.data.order || !this.data.order.canPay) return;
    if (!this.data.paymentReady) {
      wx.showToast({ title: "微信支付渠道配置中", icon: "none" });
      return;
    }
    this.setData({ paying: true });
    try {
      const result = await startMarketOrderPayment(this.data.id);
      wx.showToast({
        title: result.tradeState === "SUCCESS" ? "正在确认订单状态" : "支付结果确认中",
        icon: "none",
      });
      await this.loadOrder(true);
    } catch (error) {
      const info = getPaymentErrorInfo(error);
      if (!info.cancelled) {
        logPaymentError(error);
        wx.showModal({ title: info.title, content: info.content, showCancel: false });
      }
      await this.syncPaymentState();
      await this.loadOrder(true);
    } finally {
      this.setData({ paying: false });
    }
  },

  cancelOrder() {
    if (!this.data.order || !this.data.order.canCancel || this.data.cancelling) return;
    wx.showModal({
      title: "取消市场订单",
      content: "系统会先核对微信支付单。只有确认未支付时，平台库存才会安全释放。",
      confirmText: "取消订单",
      confirmColor: "#b5473c",
      success: async (modal) => {
        if (!modal.confirm) return;
        this.setData({ cancelling: true });
        try {
          const outTradeNo = this.data.order.outTradeNo;
          let tradeState = "ORDER_NOT_EXIST";
          if (outTradeNo) {
            try {
              const query = await queryMarketOrderPayment(outTradeNo);
              tradeState = query.tradeState;
            } catch (error) {
              if (error && error.code !== "ORDER_NOT_EXIST") {
                logPaymentError(error);
                throw new Error("暂时无法核对微信支付状态，请稍后刷新再试");
              }
            }
          }

          if (["SUCCESS", "REFUND"].includes(tradeState)) {
            await this.loadOrder(true);
            throw new Error("微信支付已成功，订单不能取消；请刷新查看最新状态");
          }
          if (["USERPAYING", "UNKNOWN"].includes(tradeState)) {
            throw new Error("微信仍在确认支付结果，请稍后刷新订单");
          }
          if (outTradeNo && ["NOTPAY", "PAYERROR"].includes(tradeState)) {
            await callPayCommon("wxpay_close_order", { out_trade_no: outTradeNo });
          }
          await callCloud("market", {
            type: "saleCancel",
            id: this.data.id,
            idempotencyKey: createIdempotencyKey("cancel_sale", this.data.id),
          }, { loadingText: "正在核对订单", silent: true });
          wx.showToast({ title: "订单状态已更新", icon: "none" });
        } catch (error) {
          wx.showModal({
            title: "暂时不能取消",
            content: (error.message || "支付结果尚未确认，请刷新订单后重试").slice(0, 180),
            showCancel: false,
          });
        } finally {
          await this.loadOrder(true);
          this.setData({ cancelling: false });
        }
      },
    });
  },

  async refreshOrder() {
    if (this.data.refreshing) return;
    this.setData({ refreshing: true });
    try {
      await this.syncPaymentState();
      await this.loadOrder(true);
      wx.showToast({ title: "订单状态已刷新", icon: "none" });
    } finally {
      this.setData({ refreshing: false });
    }
  },

  async syncPaymentState() {
    const order = this.data.order;
    if (!order || !order.outTradeNo || !["pending_payment", "payment_exception"].includes(order.status)) {
      return { tradeState: "NOT_APPLICABLE" };
    }
    try {
      return await queryMarketOrderPayment(order.outTradeNo);
    } catch (error) {
      if (!error || error.code !== "ORDER_NOT_EXIST") logPaymentError(error);
      return { tradeState: error && error.code === "ORDER_NOT_EXIST" ? "ORDER_NOT_EXIST" : "UNKNOWN" };
    }
  },

  goOrders() {
    wx.redirectTo({ url: "/pages/market-order-list/index" });
  },
});
