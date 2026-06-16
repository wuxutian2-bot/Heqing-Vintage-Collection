const { callCloud, formatTime, normalizeGoods, requireLogin } = require("../../utils/cloud");

Page({
  data: {
    id: "",
    goods: null,
    favorite: false,
    loading: true,
  },

  onLoad(options) {
    this.setData({ id: options.id || "" });
    this.fetchDetail();
  },

  async fetchDetail() {
    if (!this.data.id) return;
    this.setData({ loading: true });
    try {
      const res = await callCloud("goods", { type: "detail", id: this.data.id });
      const goods = normalizeGoods(res.data || {});
      goods.updatedText = formatTime(goods.updatedAt);
      this.setData({ goods });
      this.checkFavorite();
    } finally {
      this.setData({ loading: false });
    }
  },

  async checkFavorite() {
    if (!wx.getStorageSync("user")) return;
    const res = await callCloud(
      "favorites",
      {
        type: "check",
        targetType: "goods",
        targetId: this.data.id,
      },
      { silent: true }
    );
    this.setData({ favorite: !!res.favorite });
  },

  previewImage(e) {
    const current = e.currentTarget.dataset.src;
    wx.previewImage({
      current,
      urls: this.data.goods.images || [],
    });
  },

  copyContact() {
    const contact = this.data.goods && this.data.goods.contact;
    if (!contact) return;
    wx.setClipboardData({ data: contact });
  },

  async toggleFavorite() {
    if (!requireLogin()) return;
    const res = await callCloud(
      "favorites",
      {
        type: "toggle",
        targetType: "goods",
        targetId: this.data.id,
      },
      { loadingText: "处理中" }
    );
    this.setData({ favorite: res.favorite });
    wx.showToast({
      title: res.favorite ? "已收藏" : "已取消",
      icon: "success",
    });
  },
});
