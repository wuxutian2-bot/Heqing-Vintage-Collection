const { callCloud, normalizePost, requireLogin } = require("../../utils/cloud");

Page({
  data: {
    posts: [],
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false,
  },

  onLoad() {
    this.fetchPosts(true);
  },

  onShow() {
    if (this.data.posts.length) {
      this.fetchPosts(true);
    }
  },

  onPullDownRefresh() {
    this.fetchPosts(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.fetchPosts(false);
    }
  },

  async fetchPosts(reset) {
    const page = reset ? 1 : this.data.page;
    this.setData({ loading: true });
    try {
      const res = await callCloud(
        "posts",
        {
          type: "list",
          page,
          pageSize: this.data.pageSize,
        },
        { silent: !reset }
      );
      const posts = (res.data || []).map(normalizePost);
      this.setData({
        posts: reset ? posts : this.data.posts.concat(posts),
        page: page + 1,
        hasMore: posts.length === this.data.pageSize,
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  goPublish() {
    if (!requireLogin()) return;
    wx.navigateTo({ url: "/pages/publish-post/index" });
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/pages/post-detail/index?id=${e.currentTarget.dataset.id}`,
    });
  },
});
