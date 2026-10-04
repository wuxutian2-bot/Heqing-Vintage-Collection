const cart = require("../../utils/cart");
const { formatPrice, requireLogin } = require("../../utils/cloud");

Page({
  data: {
    cart: { outletId: "", items: [] },
    subtotalText: "0.00",
    paymentReady: false,
  },

  onShow() {
    const globalData = getApp().globalData || {};
    this.setData({
      paymentReady: Boolean(globalData.paymentFunctionName && globalData.paymentBusinessHookReady),
    });
    this.refresh();
  },

  refresh() {
    const current = cart.getCart();
    const items = current.items.map((item) => ({
      ...item,
      priceText: formatPrice(item.priceFen),
      amountText: formatPrice(Number(item.priceFen || 0) * Number(item.quantity || 0)),
    }));
    const subtotal = items.reduce((sum, item) => sum + item.priceFen * item.quantity, 0);
    this.setData({ cart: { ...current, items }, subtotalText: formatPrice(subtotal) });
  },

  changeQuantity(e) {
    const productId = e.currentTarget.dataset.id;
    const delta = Number(e.currentTarget.dataset.delta || 0);
    const item = this.data.cart.items.find((entry) => entry.productId === productId);
    if (!item) return;
    cart.updateQuantity(productId, Number(item.quantity) + delta);
    this.refresh();
  },

  removeItem(e) {
    cart.removeItem(e.currentTarget.dataset.id);
    this.refresh();
  },

  clearCart() {
    wx.showModal({
      title: "清空购物车",
      content: "确认移除全部商品吗？",
      success: (res) => {
        if (!res.confirm) return;
        cart.clearCart();
        this.refresh();
      },
    });
  },

  goStore() {
    wx.switchTab({ url: "/pages/store/index" });
  },

  goCheckout() {
    if (!requireLogin()) return;
    if (!this.data.cart.items.length) return;
    if (!this.data.paymentReady) {
      wx.showToast({ title: "微信支付渠道配置中", icon: "none" });
      return;
    }
    wx.navigateTo({ url: "/pages/checkout/index" });
  },
});
