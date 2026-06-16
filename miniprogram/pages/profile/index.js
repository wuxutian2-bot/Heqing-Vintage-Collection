const { callCloud, normalizeGoods, normalizePost } = require("../../utils/cloud");

Page({
  data: {
    user: null,
    goods: [],
    posts: [],
    favorites: [],
    activeTab: "goods",
    tabs: [
      { key: "goods", text: "我的商品" },
      { key: "posts", text: "我的帖子" },
      { key: "favorites", text: "我的收藏" },
    ],
    loading: false,
  },

  onShow() {
    const user = wx.getStorageSync("user");
    this.setData({ user: user || null });
    if (user) {
      this.loadProfile();
    }
  },

  goLogin() {
    wx.navigateTo({ url: "/pages/login/index" });
  },

  switchTab(e) {
    this.setData({ activeTab: e.currentTarget.dataset.key });
  },

  async loadProfile() {
    this.setData({ loading: true });
    try {
      const goodsRes = await callCloud("goods", {
        type: "list",
        mine: true,
        page: 1,
        pageSize: 50,
      });
      const postsRes = await callCloud("posts", {
        type: "list",
        mine: true,
        page: 1,
        pageSize: 50,
      });
      const favRes = await callCloud("favorites", {
        type: "list",
        targetType: "goods",
      });
      this.setData({
        goods: (goodsRes.data || []).map(normalizeGoods),
        posts: (postsRes.data || []).map(normalizePost),
        favorites: (favRes.data || []).map(normalizeGoods),
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  goGoodsDetail(e) {
    wx.navigateTo({ url: `/pages/goods-detail/index?id=${e.currentTarget.dataset.id}` });
  },

  goPostDetail(e) {
    wx.navigateTo({ url: `/pages/post-detail/index?id=${e.currentTarget.dataset.id}` });
  },

  async markSold(e) {
    const id = e.currentTarget.dataset.id;
    await callCloud(
      "goods",
      {
        type: "updateStatus",
        id,
        status: "sold",
      },
      { loadingText: "更新中" }
    );
    this.loadProfile();
  },

  async removeGoods(e) {
    const id = e.currentTarget.dataset.id;
    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: "确认下架",
        content: "下架后商品不会出现在市场列表中",
        success: (res) => resolve(res.confirm),
      });
    });
    if (!confirm) return;
    await callCloud(
      "goods",
      {
        type: "updateStatus",
        id,
        status: "removed",
      },
      { loadingText: "下架中" }
    );
    this.loadProfile();
  },

  logout() {
    wx.removeStorageSync("user");
    this.setData({
      user: null,
      goods: [],
      posts: [],
      favorites: [],
    });
  },
});
