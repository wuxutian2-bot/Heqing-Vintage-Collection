const { callCloud } = require("../../utils/cloud");

Page({
  data: {
    loading: false,
    agreed: false,
  },

  onAgreementChange(e) {
    this.setData({ agreed: (e.detail.value || []).includes("agreed") });
  },

  openLegal(e) {
    const mode = e.currentTarget.dataset.mode === "privacy" ? "privacy" : "terms";
    wx.navigateTo({ url: `/pages/legal/index?mode=${mode}` });
  },

  async login() {
    if (!this.data.agreed) {
      wx.showToast({ title: "请先阅读并同意相关协议", icon: "none" });
      return;
    }
    this.setData({ loading: true });
    try {
      const user = await callCloud(
        "login",
        {},
        { loadingText: "登录中", silent: true }
      );
      wx.setStorageSync("user", user);
      wx.showToast({ title: "登录成功", icon: "success" });
      setTimeout(() => {
        const pages = getCurrentPages();
        if (pages.length > 1) {
          wx.navigateBack({
            delta: 1,
            fail: () => wx.reLaunch({ url: "/pages/forum/index" }),
          });
          return;
        }
        wx.reLaunch({ url: "/pages/forum/index" });
      }, 500);
    } catch (error) {
      const setupMessages = {
        COUNTERS_COLLECTION_MISSING: "请打开云开发控制台 → 数据库，新建 counters 集合，然后重新上传并部署 login 云函数。",
        USERS_COLLECTION_MISSING: "请打开云开发控制台 → 数据库，新建 users 集合，然后重新上传并部署 login 云函数。",
      };
      wx.showModal({
        title: setupMessages[error.code] ? "登录环境未初始化" : "登录失败",
        content: setupMessages[error.code]
          || error.message
          || error.errMsg
          || "请在云开发控制台查看 login 云函数日志",
        showCancel: false,
        confirmText: "知道了",
      });
    } finally {
      this.setData({ loading: false });
    }
  },
});
