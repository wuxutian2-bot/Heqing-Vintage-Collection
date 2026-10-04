const { callCloud, normalizeGoods, normalizePost } = require("../../utils/cloud");

const normalizeIdentity = (user) => {
  if (!user) return null;
  let aliasNo = Number(user.aliasNo || 0);
  if (!Number.isInteger(aliasNo) || aliasNo <= 0) {
    const legacy = String(user.displayName || "").match(/用户(\d+)$/);
    aliasNo = legacy ? Number(legacy[1]) : 0;
  }
  return aliasNo > 0
    ? { ...user, aliasNo, displayName: `鹏宇用户${String(aliasNo).padStart(4, "0")}` }
    : { ...user, displayName: "" };
};

const getRoleState = (user) => {
  const isSuperAdmin = !!user && user.role === "admin";
  const isOutletAdmin = !!user && user.role === "outlet_admin";
  return {
    isAdmin: isSuperAdmin,
    isSuperAdmin,
    isOutletAdmin,
    isStoreManager: isSuperAdmin || isOutletAdmin,
    managerRoleText: isSuperAdmin ? "代售点总管理员" : (isOutletAdmin ? "代售点管理员" : ""),
  };
};

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
    isAdmin: false,
    isSuperAdmin: false,
    isOutletAdmin: false,
    isStoreManager: false,
    managerRoleText: "",
    avatarPickerVisible: false,
    avatarOptions: [],
    avatarPage: 1,
    avatarHasMore: true,
    avatarLoading: false,
    avatarError: "",
    avatarSavingId: 0,
  },

  onShow() {
    const user = normalizeIdentity(wx.getStorageSync("user"));
    if (user) wx.setStorageSync("user", user);
    this.setData({ user: user || null, ...getRoleState(user) });
    if (user) {
      this.loadProfile();
      const needsIdentityRefresh = !Number(user.aliasNo || 0)
        || !Number(user.avatarId || 0)
        || !user.avatarUrl
        || String(user.avatarUrl).indexOf("/images/avatars/") === 0;
      if (needsIdentityRefresh) this.refreshIdentity();
    }
  },

  async refreshIdentity() {
    try {
      const refreshed = normalizeIdentity(await callCloud("login", {}, { silent: true }));
      if (!refreshed || !Number(refreshed.aliasNo || 0)) return;
      wx.setStorageSync("user", refreshed);
      this.setData({ user: refreshed, ...getRoleState(refreshed) });
    } catch (error) {
      console.warn("身份信息刷新失败", error);
    }
  },

  goLogin() {
    wx.navigateTo({ url: "/pages/login/index" });
  },

  goAdminStore() {
    wx.navigateTo({ url: "/pages/admin-store/index" });
  },

  goAdminOrders() {
    wx.navigateTo({ url: "/pages/admin-orders/index" });
  },

  goOrders() {
    wx.navigateTo({ url: "/pages/order-list/index" });
  },

  goC2COrders() {
    wx.navigateTo({ url: "/pages/c2c-order-list/index" });
  },

  goRecoveries() {
    wx.navigateTo({ url: "/pages/recovery-list/index" });
  },

  goAdminMarketRecovery() {
    wx.navigateTo({ url: "/pages/admin-market-recovery/index" });
  },

  goAddress() {
    wx.navigateTo({ url: "/pages/address/index" });
  },

  goLegal() {
    wx.navigateTo({ url: "/pages/legal/index?mode=terms" });
  },

  async openAvatarPicker() {
    if (!this.data.user) return;
    this.setData({ avatarPickerVisible: true });
    if (!this.data.avatarOptions.length) await this.loadAvatarOptions(true);
  },

  closeAvatarPicker() {
    if (this.data.avatarSavingId) return;
    this.setData({ avatarPickerVisible: false });
  },

  keepAvatarPickerOpen() {},

  async loadAvatarOptions(reset = false) {
    if (this.data.avatarLoading || (!reset && !this.data.avatarHasMore)) return;
    const page = reset ? 1 : this.data.avatarPage;
    this.setData({ avatarLoading: true, avatarError: "" });
    try {
      const res = await callCloud("login", {
        type: "listAvatars",
        page,
        pageSize: 24,
      }, { silent: true });
      if (!res || !Array.isArray(res.data)) {
        const versionError = new Error("头像接口未更新，请重新上传并部署 login 云函数");
        versionError.code = "AVATAR_API_VERSION_MISMATCH";
        throw versionError;
      }
      const incoming = Array.isArray(res.data) ? res.data : [];
      const avatarOptions = reset ? incoming : this.data.avatarOptions.concat(incoming);
      this.setData({
        avatarOptions,
        avatarPage: page + 1,
        avatarHasMore: Boolean(res.hasMore),
      });
    } catch (error) {
      const message = String(error && (error.message || error.errMsg) || "");
      let avatarError = "头像加载失败，请稍后重试";
      let toastTitle = "头像加载失败";
      if (error.code === "AVATAR_API_VERSION_MISMATCH") {
        avatarError = "云端 login 函数未更新，请重新部署";
        toastTitle = "请重新部署 login";
      } else if (message.includes("Cannot find module 'wx-server-sdk'")) {
        avatarError = "login 云函数依赖未安装，请使用“云端安装依赖”重新部署";
        toastTitle = "云函数依赖未安装";
      }
      this.setData({ avatarError });
      wx.showToast({ title: toastTitle, icon: "none" });
    } finally {
      this.setData({ avatarLoading: false });
    }
  },

  loadMoreAvatars() {
    return this.loadAvatarOptions(false);
  },

  async selectAvatar(e) {
    const avatarId = Number(e.currentTarget.dataset.id || 0);
    if (!avatarId || this.data.avatarSavingId) return;
    if (avatarId === Number(this.data.user.avatarId || 0)) {
      this.setData({ avatarPickerVisible: false });
      return;
    }

    this.setData({ avatarSavingId: avatarId });
    try {
      const res = await callCloud("login", {
        type: "updateAvatar",
        avatarId,
      }, { silent: true });
      const user = normalizeIdentity(res.user);
      if (!user || !user.avatarUrl) throw new Error("头像保存失败");
      wx.setStorageSync("user", user);
      this.setData({ user, avatarPickerVisible: false });
      wx.showToast({ title: "头像已更新", icon: "success" });
    } catch (error) {
      wx.showToast({ title: error.message || "头像保存失败", icon: "none" });
    } finally {
      this.setData({ avatarSavingId: 0 });
    }
  },

  goMarket() {
    wx.switchTab({ url: "/pages/home/index" });
  },

  goPublishGoods() {
    wx.navigateTo({ url: "/pages/publish-goods/index" });
  },

  goPublishPost() {
    wx.navigateTo({ url: "/pages/publish-post/index" });
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

  async removePost(e) {
    const id = e.currentTarget.dataset.id;
    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: "确认删除",
        content: "删除后帖子和评论将无法恢复",
        success: (res) => resolve(res.confirm),
      });
    });
    if (!confirm) return;
    await callCloud(
      "posts",
      {
        type: "delete",
        id,
      },
      { loadingText: "删除中" }
    );
    this.loadProfile();
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
        title: "确认删除",
        content: "删除后商品将无法恢复",
        success: (res) => resolve(res.confirm),
      });
    });
    if (!confirm) return;
    await callCloud(
      "goods",
      {
        type: "delete",
        id,
      },
      { loadingText: "删除中" }
    );
    this.loadProfile();
  },

  logout() {
    wx.showModal({
      title: "退出当前账号？",
      content: "退出后，下次进入需要重新登录。",
      confirmText: "退出",
      confirmColor: "#b5473c",
      success: (res) => {
        if (!res.confirm) return;
        wx.removeStorageSync("user");
        this.setData({
          user: null,
          goods: [],
          posts: [],
          favorites: [],
          activeTab: "goods",
          avatarPickerVisible: false,
          avatarOptions: [],
          avatarPage: 1,
          avatarHasMore: true,
          avatarError: "",
          ...getRoleState(null),
        });
      },
    });
  },

  onShareAppMessage() {
    return {
      title: "鹏宇优选",
      path: "/pages/store/index",
    };
  },

  onShareTimeline() {
    return {
      title: "鹏宇优选",
      query: "",
    };
  },
});
