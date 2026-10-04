const { callCloud, formatPrice, formatTime, requireLogin } = require("../../utils/cloud");

const statusText = {
  pending_payment: "待支付",
  paid: "待配送",
  delivering: "配送中",
  completed: "已完成",
  cancelled: "已取消",
  expired: "已超时",
  refunding: "退款中",
  refunded: "已退款",
  payment_exception: "支付异常",
};

Page({
  data: {
    tabs: [
      { key: "", text: "全部" },
      { key: "pending_payment", text: "待支付" },
      { key: "paid", text: "待配送" },
      { key: "delivering", text: "配送中" },
      { key: "completed", text: "已完成" },
    ],
    activeStatus: "",
    orders: [],
    loading: true,
  },

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
      const res = await callCloud("orders", { type: "list", status: this.data.activeStatus });
      this.setData({
        orders: (res.data || []).map((order) => ({
          ...order,
          statusText: statusText[order.status] || order.status,
          totalAmountText: formatPrice(order.totalAmountFen),
          createdText: formatTime(order.createdAt),
          itemSummary: (order.items || []).map((item) => `${item.title}×${item.quantity}`).join("、"),
          totalQuantity: (order.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0),
        })),
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  switchTab(e) {
    this.setData({ activeStatus: e.currentTarget.dataset.status }, () => this.loadOrders());
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}` });
  },
});
