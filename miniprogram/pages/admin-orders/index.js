const { callCloud, formatPrice, formatTime } = require("../../utils/cloud");

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
      { key: "paid", text: "待配送" },
      { key: "delivering", text: "配送中" },
      { key: "completed", text: "已完成" },
      { key: "payment_exception", text: "异常" },
      { key: "", text: "全部" },
    ],
    activeStatus: "paid",
    orders: [],
    loading: true,
  },

  onShow() {
    const user = wx.getStorageSync("user");
    if (!user || user.role !== "admin") {
      wx.showToast({ title: "无管理员权限", icon: "none" });
      setTimeout(() => wx.navigateBack(), 300);
      return;
    }
    this.loadOrders();
  },

  onPullDownRefresh() {
    this.loadOrders().finally(() => wx.stopPullDownRefresh());
  },

  async loadOrders() {
    this.setData({ loading: true });
    try {
      const res = await callCloud("orders", { type: "adminList", status: this.data.activeStatus });
      this.setData({
        orders: (res.data || []).map((order) => ({
          ...order,
          statusText: statusText[order.status] || order.status,
          totalAmountText: formatPrice(order.totalAmountFen),
          createdText: formatTime(order.createdAt),
          itemSummary: (order.items || []).map((item) => `${item.title}×${item.quantity}`).join("、"),
        })),
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  switchTab(e) {
    this.setData({ activeStatus: e.currentTarget.dataset.status }, () => this.loadOrders());
  },

  updateStatus(e) {
    const id = e.currentTarget.dataset.id;
    const status = e.currentTarget.dataset.status;
    const title = status === "delivering" ? "开始配送" : "完成订单";
    wx.showModal({
      title,
      content: status === "delivering"
        ? "确认商品已经交给配送人员？随后还需在微信后台录入发货信息。"
        : "确认商品已经送达用户？",
      success: async (res) => {
        if (!res.confirm) return;
        await callCloud("orders", { type: "adminUpdateStatus", id, status }, { loadingText: "更新中" });
        this.loadOrders();
      },
    });
  },

  confirmShipping(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "确认微信发货录入",
      content: "请只在微信小程序后台已为该支付订单录入“其他发货方式”后确认。",
      confirmText: "确认已录入",
      success: async (res) => {
        if (!res.confirm) return;
        await callCloud("orders", { type: "adminConfirmShipping", id }, { loadingText: "确认中" });
        this.loadOrders();
      },
    });
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/order-detail/index?id=${e.currentTarget.dataset.id}` });
  },
});
