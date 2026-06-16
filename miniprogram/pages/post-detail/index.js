const { callCloud, formatTime, normalizePost, requireLogin } = require("../../utils/cloud");

Page({
  data: {
    id: "",
    post: null,
    comments: [],
    commentText: "",
    loading: true,
    submitting: false,
  },

  onLoad(options) {
    this.setData({ id: options.id || "" });
    this.fetchDetail();
  },

  async fetchDetail() {
    if (!this.data.id) return;
    this.setData({ loading: true });
    try {
      const postRes = await callCloud("posts", { type: "detail", id: this.data.id });
      const commentsRes = await callCloud("comments", {
        type: "list",
        targetType: "post",
        targetId: this.data.id,
      });
      const comments = (commentsRes.data || []).map((item) => ({
        ...item,
        createdText: formatTime(item.createdAt),
      }));
      this.setData({
        post: normalizePost(postRes.data || {}),
        comments,
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  onCommentInput(e) {
    this.setData({ commentText: e.detail.value });
  },

  previewImage(e) {
    wx.previewImage({
      current: e.currentTarget.dataset.src,
      urls: this.data.post.images || [],
    });
  },

  async likePost() {
    if (!requireLogin()) return;
    const res = await callCloud(
      "posts",
      {
        type: "like",
        id: this.data.id,
      },
      { loadingText: "处理中" }
    );
    this.setData({
      post: {
        ...this.data.post,
        likeCount: res.likeCount,
      },
    });
  },

  async submitComment() {
    if (!requireLogin()) return;
    if (!this.data.commentText.trim()) {
      wx.showToast({ title: "评论不能为空", icon: "none" });
      return;
    }
    this.setData({ submitting: true });
    try {
      await callCloud(
        "comments",
        {
          type: "add",
          targetType: "post",
          targetId: this.data.id,
          content: this.data.commentText.trim(),
        },
        { loadingText: "发送中" }
      );
      this.setData({ commentText: "" });
      this.fetchDetail();
    } finally {
      this.setData({ submitting: false });
    }
  },
});
