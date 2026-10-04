const { callCloud, formatTime, normalizePost, requireLogin } = require("../../utils/cloud");

const buildCommentThreads = (comments) => {
  const roots = [];
  const rootsById = new Map();

  comments.forEach((comment) => {
    if (!comment.parentId) {
      const root = { ...comment, replies: [] };
      roots.push(root);
      rootsById.set(root._id, root);
    }
  });

  comments.forEach((comment) => {
    if (!comment.parentId) return;
    const root = rootsById.get(comment.parentId);
    if (root) {
      root.replies.push(comment);
      return;
    }
    // 兼容主评论被删除或旧数据关系缺失的情况，回复仍可独立展示。
    const orphan = { ...comment, parentId: "", replies: [] };
    roots.push(orphan);
    rootsById.set(orphan._id, orphan);
  });

  return roots;
};

Page({
  data: {
    id: "",
    post: null,
    comments: [],
    commentThreads: [],
    commentText: "",
    commentPlaceholder: "写下友善的回应...",
    commentInputFocus: false,
    replyingTo: null,
    likingCommentIds: {},
    loading: true,
    submitting: false,
    currentUserId: "",
    isAdmin: false,
    managingPost: false,
    deletingCommentIds: {},
  },

  onLoad(options) {
    const user = wx.getStorageSync("user");
    this.setData({
      id: options.id || "",
      currentUserId: user && user._id || "",
      isAdmin: !!user && user.role === "admin",
    });
    this.fetchDetail();
  },

  onShow() {
    const user = wx.getStorageSync("user");
    this.setData({
      currentUserId: user && user._id || "",
      isAdmin: !!user && user.role === "admin",
    });
  },

  async fetchDetail(countView = true) {
    if (!this.data.id) return;
    this.setData({ loading: true });
    try {
      const postRes = await callCloud("posts", { type: "detail", id: this.data.id, countView });
      const commentsRes = await callCloud("comments", {
        type: "list",
        targetType: "post",
        targetId: this.data.id,
      });
      const comments = (commentsRes.data || []).map((item) => ({
        ...item,
        createdText: formatTime(item.createdAt),
      }));
      const post = normalizePost(postRes.data || {});
      this.setData({
        post: { ...post, category: post.category || "校园动态" },
        comments,
        commentThreads: buildCommentThreads(comments),
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  onCommentInput(e) {
    this.setData({ commentText: e.detail.value });
  },

  startReply(e) {
    if (!requireLogin()) return;
    const commentId = e.currentTarget.dataset.commentId;
    const displayName = e.currentTarget.dataset.name || "该用户";
    if (!commentId) return;
    this.setData({
      replyingTo: { commentId, displayName },
      commentPlaceholder: `回复 ${displayName}`,
      commentInputFocus: true,
    });
  },

  cancelReply() {
    this.setData({
      replyingTo: null,
      commentPlaceholder: "写下友善的回应...",
      commentInputFocus: false,
    });
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

  async togglePinned() {
    if (!this.data.isAdmin || !this.data.post || this.data.managingPost) return;
    const isPinned = !this.data.post.isPinned;
    this.setData({ managingPost: true });
    try {
      const res = await callCloud("posts", {
        type: "setPinned",
        id: this.data.id,
        isPinned,
      }, { loadingText: isPinned ? "正在置顶" : "取消置顶" });
      this.setData({
        post: {
          ...this.data.post,
          isPinned: Boolean(res.isPinned),
          pinnedAt: res.pinnedAt || null,
        },
      });
      wx.showToast({ title: isPinned ? "帖子已置顶" : "已取消置顶", icon: "success" });
    } finally {
      this.setData({ managingPost: false });
    }
  },

  deletePost() {
    const post = this.data.post;
    const canDelete = post && (this.data.isAdmin || post.author.userId === this.data.currentUserId);
    if (!canDelete || this.data.managingPost) return;
    wx.showModal({
      title: this.data.isAdmin ? "删除校园圈帖子" : "删除我的帖子",
      content: "帖子及其全部评论将被删除，且无法恢复。",
      confirmText: "确认删除",
      confirmColor: "#B83A32",
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({ managingPost: true });
        try {
          await callCloud("posts", {
            type: "delete",
            id: this.data.id,
          }, { loadingText: "正在删除" });
          wx.showToast({ title: "帖子已删除", icon: "success" });
          setTimeout(() => wx.navigateBack(), 500);
        } finally {
          this.setData({ managingPost: false });
        }
      },
    });
  },

  async toggleCommentLike(e) {
    if (!requireLogin()) return;
    const commentId = e.currentTarget.dataset.commentId;
    if (!commentId || this.data.likingCommentIds[commentId]) return;

    const likingCommentIds = { ...this.data.likingCommentIds, [commentId]: true };
    this.setData({ likingCommentIds });
    try {
      const res = await callCloud("comments", {
        type: "toggleLike",
        commentId,
      }, { silent: true });
      const comments = this.data.comments.map((comment) => (
        comment._id === commentId
          ? { ...comment, liked: Boolean(res.liked), likeCount: Number(res.likeCount || 0) }
          : comment
      ));
      this.setData({ comments, commentThreads: buildCommentThreads(comments) });
    } catch (error) {
      wx.showToast({ title: error.message || "点赞失败", icon: "none" });
    } finally {
      const nextLiking = { ...this.data.likingCommentIds };
      delete nextLiking[commentId];
      this.setData({ likingCommentIds: nextLiking });
    }
  },

  deleteComment(e) {
    const commentId = e.currentTarget.dataset.commentId;
    const userId = e.currentTarget.dataset.userId;
    const isReply = e.currentTarget.dataset.reply === "1";
    if (!commentId || (!this.data.isAdmin && userId !== this.data.currentUserId)) return;
    if (this.data.deletingCommentIds[commentId]) return;
    wx.showModal({
      title: isReply ? "删除回复" : "删除评论",
      content: isReply ? "确认删除这条回复？" : "删除主评论时，其下全部回复也会被删除。",
      confirmText: "删除",
      confirmColor: "#B83A32",
      success: async (result) => {
        if (!result.confirm) return;
        this.setData({
          deletingCommentIds: { ...this.data.deletingCommentIds, [commentId]: true },
        });
        try {
          await callCloud("comments", {
            type: "delete",
            commentId,
          }, { loadingText: "正在删除" });
          await this.fetchDetail(false);
          wx.showToast({ title: "评论已删除", icon: "success" });
        } finally {
          const deletingCommentIds = { ...this.data.deletingCommentIds };
          delete deletingCommentIds[commentId];
          this.setData({ deletingCommentIds });
        }
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
          replyToCommentId: this.data.replyingTo && this.data.replyingTo.commentId || "",
        },
        { loadingText: "发送中" }
      );
      this.setData({
        commentText: "",
        replyingTo: null,
        commentPlaceholder: "写下友善的回应...",
        commentInputFocus: false,
      });
      await this.fetchDetail(false);
    } finally {
      this.setData({ submitting: false });
    }
  },

  onShareAppMessage() {
    return {
      title: (this.data.post && this.data.post.title) || "鹏宇优选校园圈",
      path: `/pages/post-detail/index?id=${this.data.id}`,
    };
  },

  onShareTimeline() {
    return {
      title: (this.data.post && this.data.post.title) || "鹏宇优选校园圈",
      query: `id=${this.data.id}`,
    };
  },
});
