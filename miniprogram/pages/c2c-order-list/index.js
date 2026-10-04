const { callCloud, formatPrice, formatTime, requireLogin } = require("../../utils/cloud");

const STATUS_TEXT = {
  pending_payment: "待支付",
  paid: "待交付",
  seller_delivered: "待确认收货",
  settlement_available: "待卖家结算",
  disputed: "争议处理中",
  refunding: "退款处理中",
  refunded: "已退款",
  cancelled: "已取消",
  expired: "已超时",
  payment_exception: "支付核对中",
};

const normalizeOrder = (order) => {
  const snapshot = order.goodsSnapshot || {};
  const status = String(order.status || "pending_payment");
  return {
    ...order,
    title: snapshot.title || "闲置商品",
    cover: (snapshot.images || [])[0] || "/images/default-goods-image.png",
    amountText: formatPrice(order.totalAmountFen),
    createdText: formatTime(order.createdAt),
    statusText: STATUS_TEXT[status] || "处理中",
    roleText: order.role === "seller" ? "我是卖家" : "我是买家",
  };
};

Page({
  data: { orders: [], loading: true },

  onShow() {
    if (!requireLogin()) return;
    this.loadOrders();
  },

  onPullDownRefresh() {
    this.loadOrders().finally(() => wx.stopPullDownRefresh());
  },

  async loadOrders() {
    this.setData({ loading: true });
    try {
      const result = await callCloud("c2c-market", { type: "listOrders", page: 1, pageSize: 50 }, { silent: true });
      const source = result.data || {};
      this.setData({ orders: (source.items || []).map(normalizeOrder) });
    } catch (error) {
      wx.showToast({ title: (error.message || "担保订单加载失败").slice(0, 20), icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/c2c-order-detail/index?id=${e.currentTarget.dataset.id}` });
  },

  goMarket() {
    wx.switchTab({ url: "/pages/home/index" });
  },
});
