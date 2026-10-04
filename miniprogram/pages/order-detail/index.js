const { callCloud, formatPrice, formatTime, requireLogin } = require("../../utils/cloud");
const { startOrderPayment, getPaymentErrorInfo, logPaymentError } = require("../../utils/payment");

const statusInfo = {
  pending_payment: { title: "等待支付", desc: "库存已为你保留 15 分钟" },
  paid: { title: "商家备货中", desc: "代售点会尽快安排配送" },
  delivering: { title: "正在配送", desc: "商品正在送往你的宿舍" },
  completed: { title: "订单已完成", desc: "感谢使用鹏宇优选" },
  cancelled: { title: "订单已取消", desc: "预留库存已经释放" },
  expired: { title: "订单已超时", desc: "超过 15 分钟未支付，库存已经释放" },
  refunding: { title: "退款处理中", desc: "请留意微信支付通知" },
  refunded: { title: "退款已完成", desc: "款项已按原渠道退回" },
  payment_exception: { title: "支付异常处理中", desc: "订单不会配送，管理员将核对并退款" },
};

Page({
  data: { id: "", order: null, loading: true, paying: false, paymentReady: false },

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

  async loadOrder() {
    this.setData({ loading: true });
    try {
      const res = await callCloud("orders", { type: "detail", id: this.data.id });
      const order = res.data;
      const info = statusInfo[order.status] || { title: order.status, desc: "" };
      this.setData({
        // 外部入口的 id 可能是商户订单号；后续操作统一使用服务端返回的文档 ID。
        id: order._id,
        order: {
          ...order,
          ...info,
          itemAmountText: formatPrice(order.itemAmountFen),
          deliveryFeeText: formatPrice(order.deliveryFeeFen),
          totalAmountText: formatPrice(order.totalAmountFen),
          createdText: formatTime(order.createdAt),
          expiresText: formatTime(order.expiresAt),
          items: (order.items || []).map((item) => ({ ...item, priceText: formatPrice(item.priceFen) })),
        },
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  async payOrder() {
    if (this.data.paying) return;
    if (!this.data.paymentReady) {
      wx.showToast({ title: "微信支付渠道配置中", icon: "none" });
      return;
    }
    this.setData({ paying: true });
    try {
      const result = await startOrderPayment(this.data.id);
      if (result.tradeState === "SUCCESS") {
        wx.showToast({ title: "支付成功", icon: "success" });
      } else {
        wx.showToast({ title: "支付结果确认中", icon: "none" });
      }
      setTimeout(() => this.loadOrder(), 800);
    } catch (error) {
      const info = getPaymentErrorInfo(error);
      if (!info.cancelled) {
        logPaymentError(error);
        wx.showModal({ title: info.title, content: info.content, showCancel: false });
      }
    } finally {
      this.setData({ paying: false });
    }
  },

  cancelOrder() {
    wx.showModal({
      title: "取消订单",
      content: "取消后会立即释放预留库存",
      success: async (res) => {
        if (!res.confirm) return;
        await callCloud("orders", { type: "cancel", id: this.data.id }, { loadingText: "取消中" });
        this.loadOrder();
      },
    });
  },

  goOrders() {
    wx.redirectTo({ url: "/pages/order-list/index" });
  },
});
