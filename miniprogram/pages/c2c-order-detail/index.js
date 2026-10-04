const { callCloud, formatPrice, formatTime, requireLogin } = require("../../utils/cloud");
const { callPayCommon, startC2CMarketOrderPayment, queryMarketOrderPayment, getPaymentErrorInfo, logPaymentError } = require("../../utils/payment");

const STATUS_INFO = {
  pending_payment: { title: "等待付款", desc: "商品已临时锁定，付款后安排当面交付", tone: "attention" },
  paid: { title: "等待卖家交付", desc: "请按订单约定在校园内当面核对实物", tone: "success" },
  seller_delivered: { title: "请确认收货", desc: "核对实物无误后再确认，确认后将生成卖方待结算记录", tone: "success" },
  settlement_available: { title: "交易已确认", desc: "卖方已生成待结算记录，结算仍需经商户通道核验", tone: "success" },
  disputed: { title: "争议处理中", desc: "争议期间交易和结算状态已冻结，请保留商品与交付凭证", tone: "attention" },
  refunding: { title: "退款处理中", desc: "退款结果以微信支付服务端记录为准", tone: "attention" },
  refunded: { title: "退款已完成", desc: "请与对方协商实物退回安排", tone: "muted" },
  cancelled: { title: "订单已取消", desc: "商品锁定已解除", tone: "muted" },
  expired: { title: "订单已超时", desc: "商品锁定已解除", tone: "muted" },
  payment_exception: { title: "支付核对中", desc: "请勿重复付款，系统正在核对原支付单", tone: "attention" },
};
const key = (prefix, id) => `${prefix}_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

const normalizeOrder = (order) => {
  const status = String(order.status || "pending_payment");
  const info = STATUS_INFO[status] || { title: "订单处理中", desc: "请刷新查看订单状态", tone: "attention" };
  const snapshot = order.goodsSnapshot || {};
  const role = order.role || "buyer";
  return {
    ...order,
    ...info,
    status,
    role,
    roleText: role === "seller" ? "我是卖家" : "我是买家",
    title: snapshot.title || "闲置商品",
    cover: (snapshot.images || [])[0] || "/images/default-goods-image.png",
    totalText: formatPrice(order.totalAmountFen),
    feeText: formatPrice(order.feeAmountFen),
    sellerText: formatPrice(order.sellerAmountFen),
    createdText: formatTime(order.createdAt),
    expiresText: formatTime(order.expiresAt),
    paidText: formatTime(order.paidAt),
    canPay: role === "buyer" && status === "pending_payment",
    canCancel: role === "buyer" && status === "pending_payment",
    canDeliver: role === "seller" && status === "paid",
    canConfirm: role === "buyer" && status === "seller_delivered",
    canDispute: ["buyer", "seller"].includes(role) && ["paid", "seller_delivered", "settlement_available"].includes(status),
    canPayout: role === "seller" && status === "settlement_available" && order.settlementStatus === "available",
  };
};

Page({
  data: { id: "", order: null, loading: true, paying: false, acting: false, paymentReady: false, payoutEnabled: false },

  onLoad(options) {
    const globalData = getApp().globalData || {};
    this.setData({ id: options.id || "", paymentReady: Boolean(globalData.paymentFunctionName && globalData.paymentBusinessHookReady) });
  },

  onShow() {
    if (!requireLogin() || !this.data.id) return;
    this.loadOrder();
  },

  onPullDownRefresh() { this.loadOrder(true).finally(() => wx.stopPullDownRefresh()); },

  async loadOrder(silent = false) {
    if (!silent) this.setData({ loading: true });
    try {
      const [result, readiness] = await Promise.all([
        callCloud("c2c-market", { type: "getOrder", id: this.data.id }, { silent: true }),
        callCloud("c2c-market", { type: "readiness" }, { silent: true }).catch(() => null),
      ]);
      const raw = result.data && result.data.order ? result.data.order : {};
      const order = normalizeOrder(raw);
      this.setData({ id: order._id || this.data.id, order, payoutEnabled: Boolean(readiness && readiness.data && readiness.data.policy && readiness.data.policy.payoutEnabled) });
    } catch (error) {
      wx.showToast({ title: (error.message || "担保订单加载失败").slice(0, 20), icon: "none" });
    } finally { this.setData({ loading: false }); }
  },

  async payOrder() {
    if (!this.data.order || !this.data.order.canPay || this.data.paying) return;
    if (!this.data.paymentReady) return wx.showToast({ title: "微信支付渠道配置中", icon: "none" });
    this.setData({ paying: true });
    try {
      const result = await startC2CMarketOrderPayment(this.data.id);
      wx.showToast({ title: result.tradeState === "SUCCESS" ? "正在确认订单状态" : "支付结果确认中", icon: "none" });
    } catch (error) {
      const info = getPaymentErrorInfo(error);
      if (!info.cancelled) { logPaymentError(error); wx.showModal({ title: info.title, content: info.content, showCancel: false }); }
    } finally { await this.loadOrder(true); this.setData({ paying: false }); }
  },

  cancelOrder() {
    if (!this.data.order || !this.data.order.canCancel || this.data.acting) return;
    wx.showModal({ title: "取消担保订单", content: "未发起支付的订单会立即解除商品锁定。已发起支付时，系统必须先核对微信支付单。", confirmText: "取消订单", confirmColor: "#b5473c", success: async (modal) => {
      if (!modal.confirm) return;
      this.setData({ acting: true });
      try {
        const order = this.data.order;
        if (order.outTradeNo) {
          const state = await queryMarketOrderPayment(order.outTradeNo).catch(() => ({ tradeState: "ORDER_NOT_EXIST" }));
          if (["SUCCESS", "REFUND", "USERPAYING", "UNKNOWN"].includes(state.tradeState)) throw new Error("微信仍在确认支付结果，请稍后刷新订单");
          if (["NOTPAY", "PAYERROR"].includes(state.tradeState)) {
            await callPayCommon("wxpay_close_order", { out_trade_no: order.outTradeNo });
            wx.showToast({ title: "关闭请求已提交，请刷新订单", icon: "none" });
            return;
          }
        }
        await callCloud("c2c-market", { type: "cancelOrder", id: this.data.id, requestId: key("cancel_c2c", this.data.id) }, { loadingText: "正在取消", silent: true });
        wx.showToast({ title: "订单已取消", icon: "success" });
      } catch (error) { wx.showModal({ title: "暂时不能取消", content: (error.message || "请稍后刷新订单").slice(0, 180), showCancel: false });
      } finally { await this.loadOrder(true); this.setData({ acting: false }); }
    } });
  },

  confirmDelivery() { this.runConfirmedAction("确认已当面交付", "请确认买家已核对到实物。确认后等待买家确认收货。", "sellerDeliver", { deliveryNote: "卖家确认已当面交付，等待买家验货确认。" }); },
  confirmReceipt() { this.runConfirmedAction("确认收货", "确认收到并核对实物无误后，将生成卖方待结算记录。", "buyerConfirm"); },
  openDispute() { this.runConfirmedAction("发起争议", "发起后交易与结算状态会冻结，请保留商品与交付凭证。", "openDispute", { reason: "买卖双方对商品交付存在争议，请平台介入处理。" }, "发起争议"); },

  runConfirmedAction(title, content, type, extra = {}, confirmText = "确认") {
    if (this.data.acting) return;
    wx.showModal({ title, content, confirmText, confirmColor: type === "openDispute" ? "#b5473c" : "#174c3b", success: async (modal) => {
      if (!modal.confirm) return;
      this.setData({ acting: true });
      try {
        await callCloud("c2c-market", { type, id: this.data.id, requestId: key(type, this.data.id), ...extra }, { loadingText: "正在提交", silent: true });
        wx.showToast({ title: "订单状态已更新", icon: "success" });
      } catch (error) { wx.showToast({ title: (error.message || "操作失败").slice(0, 20), icon: "none" });
      } finally { await this.loadOrder(true); this.setData({ acting: false }); }
    } });
  },

  async requestPayout() {
    if (!this.data.order || !this.data.order.canPayout || this.data.acting) return;
    if (!this.data.payoutEnabled) return wx.showModal({ title: "卖家结算未开放", content: "订单已保留待结算记录；商户转账场景和收款通道完成核验后才会开放。", showCancel: false });
    this.setData({ acting: true });
    try { await callCloud("c2c-market", { type: "requestPayout", id: this.data.id }, { silent: true });
    } catch (error) { wx.showModal({ title: "暂不能结算", content: (error.message || "结算通道未完成核验").slice(0, 180), showCancel: false });
    } finally { await this.loadOrder(true); this.setData({ acting: false }); }
  },

  goOrders() { wx.redirectTo({ url: "/pages/c2c-order-list/index" }); },
});
