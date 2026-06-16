const { callCloud } = require("../../utils/cloud");

Page({
  data: {
    loading: false,
  },

  getProfile() {
    return new Promise((resolve) => {
      if (!wx.getUserProfile) {
        resolve({});
        return;
      }

      wx.getUserProfile({
        desc: "用于展示个人信息和管理发布内容",
        success: (res) => resolve(res.userInfo || {}),
        fail: () => resolve({}),
      });
    });
  },

  async login() {
    this.setData({ loading: true });
    try {
      const userInfo = await this.getProfile();
      const user = await callCloud(
        "login",
        {
          nickName: userInfo.nickName,
          avatarUrl: userInfo.avatarUrl,
        },
        { loadingText: "登录中", silent: true }
      );
      wx.setStorageSync("user", user);
      wx.showToast({ title: "登录成功", icon: "success" });
      setTimeout(() => {
        const pages = getCurrentPages();
        if (pages.length > 1) {
          wx.navigateBack();
        } else {
          wx.switchTab({ url: "/pages/profile/index" });
        }
      }, 500);
    } catch (error) {
      wx.showToast({
        title: (error && (error.errMsg || error.message)) || "登录失败",
        icon: "none",
      });
    } finally {
      this.setData({ loading: false });
    }
  },
});
