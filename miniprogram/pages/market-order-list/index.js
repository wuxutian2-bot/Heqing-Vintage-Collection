const { callCloud, formatPrice, formatTime, requireLogin } = require("../../utils/cloud");

const STATUS_TEXT = {
  pending_payment: "待支付",
  paid: "已支付",
  fulfilling: "交付中",
  delivering: "交付中",
  completed: "已完成",
  cancelled: "已取消",
  expired: "已超时",
  refunding: "退款中",
  refunded: "已退款",
  payment_exception: "支付核对中",
};

const getList = (result) => {
  const data = result && result.data;
  if (Array.isArray(data)) return data;
  const source = data && typeof data === "object" ? data : result || {};
  return source.orders || source.items || source.list || [];
};

const normalizeOrder = (order) => {
  const snapshot = order.itemSnapshot || order.inventorySnapshot || order.goodsSnapshot || order.item || {};
  const images = Array.isArray(snapshot.images) ? snapshot.images : [];
  const status = String(order.status || "pending_payment").toLowerCase();
  return {
    ...order,
    _id: order._id || order.id || order.saleOrderId || "",
    status,
    statusText: STATUS_TEXT[status] || order.status || "处理中",
    title: order.title || snapshot.title || "平台商品",
    cover: order.cover || snapshot.cover || snapshot.image || images[0] || "/images/default-goods-image.png",
    totalAmountText: formatPrice(order.totalAmountFen || order.amountFen || snapshot.salePriceFen || 0),
    createdText: formatTime(order.createdAt),
    canPay: status === "pending_payment",
  };
};

Page({
  data: {
    tabs: [
      { key: "", text: "全部" },
      { key: "pending_payment", text: "待支付" },
      { key: "paid", text: "已支付" },
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
      const request = {
        type: "saleList",
        page: 1,
        pageSize: 50,
      };
      if (this.data.activeStatus) request.status = this.data.activeStatus;
      const result = await callCloud("market", request, { silent: true });
      this.setData({ orders: getList(result).map(normalizeOrder) });
    } catch (error) {
      wx.showToast({ title: (error.message || "市场订单加载失败").slice(0, 20), icon: "none" });
    } finally {
      this.setData({ loading: false });
    }
  },

  switchTab(e) {
    this.setData({ activeStatus: e.currentTarget.dataset.status }, () => this.loadOrders());
  },

  goDetail(e) {
    wx.navigateTo({ url: `/pages/market-order-detail/index?id=${e.currentTarget.dataset.id}` });
  },

  goMarket() {
    wx.switchTab({ url: "/pages/home/index" });
  },
});
