const cart = require("../../utils/cart");
const { callCloud, formatPrice, requireLogin } = require("../../utils/cloud");

Page({
  data: {
    cart: { outletId: "", items: [] },
    outlet: null,
    defaultAddress: null,
    phone: "",
    note: "",
    itemAmountText: "0.00",
    deliveryFeeText: "0.00",
    totalAmountText: "0.00",
    submitting: false,
    paymentReady: false,
  },

  onLoad() {
    if (!requireLogin()) return;
    const user = wx.getStorageSync("user");
    if (!user.defaultAddress) {
      wx.navigateTo({ url: "/pages/address/index?required=1" });
      return;
    }
    this.setData({ defaultAddress: user.defaultAddress });
    const globalData = getApp().globalData || {};
    const paymentReady = Boolean(globalData.paymentFunctionName && globalData.paymentBusinessHookReady);
    this.setData({ paymentReady });
    if (!paymentReady) {
      wx.showModal({
        title: "暂未开放结算",
        content: "微信支付渠道正在完成安全验收，请稍后再试。",
        showCancel: false,
      });
      return;
    }
    this.loadCheckout();
  },

  onShow() {
    const user = wx.getStorageSync("user");
    if (!user || !user.defaultAddress) return;
    this.setData({ defaultAddress: user.defaultAddress });
    if (this.data.outlet && this.data.paymentReady) this.loadCheckout();
  },

  async loadCheckout() {
    const current = cart.getCart();
    if (!current.items.length) {
      wx.showToast({ title: "购物车为空", icon: "none" });
      setTimeout(() => wx.navigateBack(), 500);
      return;
    }
    const res = await callCloud("store", { type: "listOutlets", schoolId: getApp().globalData.schoolId });
    const outlet = (res.data || []).find((item) => item._id === current.outletId);
    if (!outlet) {
      wx.showToast({ title: "代售点暂停营业", icon: "none" });
      return;
    }
    if (Number(outlet.buildingNo) !== Number(this.data.defaultAddress.buildingNo)) {
      wx.showModal({
        title: "购物车楼栋不一致",
        content: "默认地址已变更，请返回首页重新选购本楼商品。",
        showCancel: false,
        success: () => {
          cart.clearCart();
          wx.switchTab({ url: "/pages/store/index" });
        },
      });
      return;
    }
    const items = current.items.map((item) => ({ ...item, priceText: formatPrice(item.priceFen) }));
    const itemAmountFen = items.reduce((sum, item) => sum + item.priceFen * item.quantity, 0);
    const deliveryFeeFen = Number(outlet.deliveryFeeFen || 0);
    this.setData({
      cart: { ...current, items },
      outlet,
      itemAmountText: formatPrice(itemAmountFen),
      deliveryFeeText: formatPrice(deliveryFeeFen),
      totalAmountText: formatPrice(itemAmountFen + deliveryFeeFen),
    });
  },

  onInput(e) {
    this.setData({ [e.currentTarget.dataset.field]: e.detail.value });
  },

  goAddress() {
    wx.navigateTo({ url: "/pages/address/index" });
  },

  async submit() {
    if (this.data.submitting || !this.data.outlet) return;
    if (!this.data.paymentReady) return;
    if (!this.data.defaultAddress) return wx.showToast({ title: "请先设置宿舍地址", icon: "none" });
    if (!/^1\d{10}$/.test(this.data.phone.trim())) return wx.showToast({ title: "手机号格式不正确", icon: "none" });
    this.setData({ submitting: true });
    try {
      const res = await callCloud("orders", {
        type: "create",
        outletId: this.data.cart.outletId,
        items: this.data.cart.items.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        phone: this.data.phone.trim(),
        note: this.data.note.trim(),
      }, { loadingText: "提交订单" });
      cart.clearCart();
      wx.redirectTo({ url: `/pages/order-detail/index?id=${res.data._id}` });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
