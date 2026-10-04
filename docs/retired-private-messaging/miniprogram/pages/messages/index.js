const { callCloud, formatTime } = require("../../utils/cloud");

Page({
  data: {
    conversations: [],
    loading: false,
    isGuest: true,
  },

  onShow() {
    this.stopPolling();
    const user = wx.getStorageSync("user");
    if (!user || (!user._id && !user._openid)) {
      wx.removeTabBarBadge({ index: 3 });
      this.setData({ conversations: [], loading: false, isGuest: true });
      return;
    }
    this.setData({ isGuest: false });
    this.loadConversations();
    this.startPolling();
  },

  onHide() {
    this.stopPolling();
  },

  onUnload() {
    this.stopPolling();
  },

  onPullDownRefresh() {
    if (this.data.isGuest) {
      wx.stopPullDownRefresh();
      return;
    }
    this.loadConversations().finally(() => wx.stopPullDownRefresh());
  },

  goLogin() {
    wx.navigateTo({ url: "/pages/login/index" });
  },

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.loadConversations(true), 3000);
  },

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  },

  async loadConversations(silent = false) {
    if (this.loadingConversations) return;
    this.loadingConversations = true;
    if (!silent) this.setData({ loading: true });
    try {
      const res = await callCloud("chat", { type: "listConversations" }, { silent });
      const conversations = (res.data || []).map((item) => ({
        ...item,
        timeText: formatTime(item.lastMessageAt),
      }));
      const unreadTotal = conversations.reduce((sum, item) => sum + Number(item.unreadCount || 0), 0);
      if (unreadTotal > 0) {
        wx.setTabBarBadge({ index: 3, text: unreadTotal > 99 ? "99+" : String(unreadTotal) });
      } else {
        wx.removeTabBarBadge({ index: 3 });
      }
      this.setData({ conversations });
    } finally {
      this.loadingConversations = false;
      if (!silent) this.setData({ loading: false });
    }
  },

  goChat(e) {
    wx.navigateTo({ url: `/pages/chat/index?id=${e.currentTarget.dataset.id}` });
  },
});
