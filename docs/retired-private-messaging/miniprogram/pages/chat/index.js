const { callCloud, formatTime, requireLogin } = require("../../utils/cloud");

Page({
  data: {
    conversationId: "",
    otherUser: null,
    context: {},
    messages: [],
    inputText: "",
    page: 1,
    hasMore: false,
    loading: true,
    sending: false,
    canSend: true,
    blockedByMe: false,
    scrollIntoView: "",
  },

  onLoad(options) {
    if (!requireLogin()) return;
    this.setData({ conversationId: options.id || "" });
    this.loadMessages(true);
  },

  onShow() {
    if (!this.data.conversationId) return;
    this.startPolling();
  },

  onHide() {
    this.stopPolling();
  },

  onUnload() {
    this.stopPolling();
  },

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.loadLatest(), 3000);
  },

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  },

  decorateMessages(messages) {
    return messages.map((item) => ({ ...item, timeText: formatTime(item.createdAt) }));
  },

  async loadMessages(reset = false) {
    if (this.loadingMessages || !this.data.conversationId) return;
    this.loadingMessages = true;
    const page = reset ? 1 : this.data.page;
    if (reset) this.setData({ loading: true });
    try {
      const res = await callCloud("chat", {
        type: "listMessages",
        conversationId: this.data.conversationId,
        page,
        pageSize: 30,
      }, { silent: !reset });
      const messages = this.decorateMessages(res.data || []);
      const nextMessages = reset ? messages : messages.concat(this.data.messages);
      const last = nextMessages[nextMessages.length - 1];
      this.setData({
        messages: nextMessages,
        page: page + 1,
        hasMore: !!res.hasMore,
        otherUser: res.otherUser,
        context: res.context || {},
        blockedByMe: !!res.blockedByMe,
        canSend: !!res.canSend,
        scrollIntoView: reset && last ? `msg-${last._id}` : this.data.scrollIntoView,
      });
      if (res.otherUser) wx.setNavigationBarTitle({ title: res.otherUser.displayName });
      await callCloud("chat", { type: "markRead", conversationId: this.data.conversationId }, { silent: true });
    } finally {
      this.loadingMessages = false;
      if (reset) this.setData({ loading: false });
    }
  },

  async loadLatest() {
    if (this.loadingMessages || !this.data.conversationId) return;
    this.loadingMessages = true;
    try {
      const res = await callCloud("chat", {
        type: "listMessages",
        conversationId: this.data.conversationId,
        page: 1,
        pageSize: 30,
      }, { silent: true });
      const merged = new Map(this.data.messages.map((item) => [item._id, item]));
      this.decorateMessages(res.data || []).forEach((item) => merged.set(item._id, item));
      const messages = Array.from(merged.values()).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      this.setData({
        messages,
        otherUser: res.otherUser,
        blockedByMe: !!res.blockedByMe,
        canSend: !!res.canSend,
      });
      await callCloud("chat", { type: "markRead", conversationId: this.data.conversationId }, { silent: true });
    } finally {
      this.loadingMessages = false;
    }
  },

  loadOlder() {
    if (this.data.hasMore) this.loadMessages(false);
  },

  onInput(e) {
    this.setData({ inputText: e.detail.value });
  },

  async send() {
    const content = this.data.inputText.trim();
    if (!content || this.data.sending || !this.data.canSend) return;
    this.setData({ sending: true });
    try {
      const res = await callCloud("chat", {
        type: "send",
        conversationId: this.data.conversationId,
        content,
      }, { loadingText: "发送中" });
      const message = this.decorateMessages([res.data])[0];
      this.setData({
        messages: this.data.messages.concat(message),
        inputText: "",
        scrollIntoView: `msg-${message._id}`,
      });
    } finally {
      this.setData({ sending: false });
    }
  },

  toggleBlock() {
    const blocked = !this.data.blockedByMe;
    wx.showModal({
      title: blocked ? "屏蔽该用户" : "解除屏蔽",
      content: blocked ? "屏蔽后双方不能在此会话发送新消息。" : "解除后，如对方未屏蔽你，可继续发送消息。",
      success: async (res) => {
        if (!res.confirm) return;
        const result = await callCloud("chat", {
          type: "setBlock",
          conversationId: this.data.conversationId,
          targetUserId: this.data.otherUser.userId,
          blocked,
        }, { loadingText: "处理中" });
        this.setData({ blockedByMe: result.blocked, canSend: !result.blocked });
      },
    });
  },

  reportUser() {
    const reasons = ["疑似诈骗", "骚扰辱骂", "发布违禁内容", "虚假商品或信息", "其他违规"];
    wx.showActionSheet({
      itemList: reasons,
      success: async (res) => {
        const result = await callCloud("chat", {
          type: "report",
          conversationId: this.data.conversationId,
          targetUserId: this.data.otherUser.userId,
          reason: reasons[res.tapIndex],
        }, { loadingText: "提交中" });
        wx.showToast({ title: result.duplicate ? "已提交过举报" : "举报已提交", icon: "none" });
      },
    });
  },
});
