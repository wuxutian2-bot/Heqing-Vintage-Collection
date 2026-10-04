const { callCloud, formatPrice } = require("../../utils/cloud");
const cart = require("../../utils/cart");

Page({
  data: {
    id: "",
    product: null,
    loading: true,
    cartCount: 0,
  },

  onLoad(options) {
    this.setData({ id: options.id || "" });
    this.loadProduct();
  },

  onShow() {
    this.setData({ cartCount: cart.getCount() });
  },

  async loadProduct() {
    if (!this.data.id) return;
    this.setData({ loading: true });
    try {
      const res = await callCloud("store", { type: "detailProduct", id: this.data.id });
      this.setData({
        product: {
          ...res.data,
          priceText: formatPrice(res.data.priceFen),
          stockText: res.data.stock > 0 ? `库存 ${res.data.stock}` : "暂时售罄",
        },
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  previewImage() {
    if (!this.data.product || !this.data.product.image) return;
    wx.previewImage({ current: this.data.product.image, urls: [this.data.product.image] });
  },

  addToCart() {
    const product = this.data.product;
    if (!product || product.stock <= 0) return;
    const result = cart.addItem(product);
    if (result.conflict) {
      wx.showModal({
        title: "切换代售点",
        content: "购物车已有其他代售点商品，继续将清空原购物车。",
        confirmText: "继续",
        success: (res) => {
          if (!res.confirm) return;
          cart.addItem(product, true);
          this.setData({ cartCount: cart.getCount() });
          wx.showToast({ title: "已加入购物车", icon: "success" });
        },
      });
      return;
    }
    this.setData({ cartCount: cart.getCount() });
    wx.showToast({ title: "已加入购物车", icon: "success" });
  },

  goCart() {
    wx.navigateTo({ url: "/pages/cart/index" });
  },

  onShareAppMessage() {
    return {
      title: this.data.product ? `${this.data.product.title} - 鹏宇优选` : "鹏宇优选",
      path: `/pages/store-product/index?id=${this.data.id}`,
    };
  },
});
