const { callCloud, normalizePost, requireLogin } = require("../../utils/cloud");

const decoratePost = (item) => {
  const post = normalizePost(item);
  return {
    ...post,
    category: post.category || "校园动态",
    previewImages: post.images.slice(0, 3),
    extraImageCount: Math.max(post.images.length - 3, 0),
  };
};

Page({
  data: {
    posts: [],
    displayPosts: [],
    weeklyHotPosts: [],
    weeklyHotAutoplay: false,
    showWeeklyRanking: false,
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false,
    keyword: "",
    activeCategory: "",
    activeCategoryText: "全部动态",
    activeSort: "latest",
    categories: [
      { key: "", text: "全部" },
      { key: "校园动态", text: "校园动态" },
      { key: "求助问答", text: "求助问答" },
      { key: "拼单搭子", text: "拼单搭子" },
      { key: "失物招领", text: "失物招领" },
      { key: "新生指南", text: "新生指南" },
      { key: "吐槽闲聊", text: "吐槽闲聊" },
    ],
    quickChannels: [
      { category: "求助问答", title: "求助", subtitle: "同学解答", icon: "/images/forum/quick-help.png" },
      { category: "拼单搭子", title: "找搭子", subtitle: "拼单同行", icon: "/images/forum/quick-partner.png" },
      { category: "失物招领", title: "失物", subtitle: "寻物招领", icon: "/images/forum/quick-lost.png" },
      { category: "新生指南", title: "新生", subtitle: "校园指南", icon: "/images/forum/quick-freshman.png" },
      { action: "campusMap", title: "校园地图", subtitle: "楼栋导航", icon: "/images/forum/quick-campus-map.png" },
    ],
    sorts: [
      { key: "latest", text: "最新" },
      { key: "hot", text: "热议" },
    ],
  },

  onLoad() {
    this.fetchPosts(true);
    this.fetchWeeklyHotPosts();
  },

  onShow() {
    if (this.data.posts.length) {
      this.fetchPosts(true);
      this.fetchWeeklyHotPosts();
    }
  },

  onPullDownRefresh() {
    Promise.all([this.fetchPosts(true), this.fetchWeeklyHotPosts()])
      .finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.fetchPosts(false);
    }
  },

  async fetchPosts(reset) {
    const page = reset ? 1 : this.data.page;
    const requestCategory = this.data.activeCategory;
    const requestSort = this.data.activeSort;
    const requestId = Number(this._feedRequestId || 0) + 1;
    this._feedRequestId = requestId;
    this.setData({ loading: true });
    try {
      const res = await callCloud(
        "posts",
        {
          type: "list",
          page,
          pageSize: this.data.pageSize,
          category: requestCategory,
          sort: requestSort,
        },
        { silent: !reset }
      );
      if (
        requestId !== this._feedRequestId
        || requestCategory !== this.data.activeCategory
        || requestSort !== this.data.activeSort
      ) return;

      const rawNextPosts = (res.data || []).map(decoratePost);
      // 云端负责减少查询量，前端仍强制校验分类，兼容尚未部署的旧版云函数。
      const nextPosts = requestCategory
        ? rawNextPosts.filter((post) => post.category === requestCategory)
        : rawNextPosts;
      const posts = reset ? nextPosts : this.data.posts.concat(nextPosts);
      this.setData({
        posts,
        displayPosts: this.filterPosts(posts, this.data.keyword, requestCategory),
        page: page + 1,
        hasMore: typeof res.hasMore === "boolean"
          ? res.hasMore
          : rawNextPosts.length === this.data.pageSize,
      });
    } finally {
      if (requestId === this._feedRequestId) {
        this.setData({ loading: false });
      }
    }
  },

  async fetchWeeklyHotPosts() {
    try {
      const res = await callCloud("posts", {
        type: "weeklyHot",
      }, { silent: true });
      const posts = (res.data || []).map(decoratePost);
      this.setData({
        weeklyHotPosts: posts,
        weeklyHotAutoplay: posts.length > 1,
      });
    } catch (error) {
      console.warn("本周热议加载失败", error);
      this.setData({ weeklyHotPosts: [], weeklyHotAutoplay: false });
    }
  },

  filterPosts(posts, keyword, category = this.data.activeCategory) {
    const text = String(keyword || "").trim().toLowerCase();
    return posts.filter((post) => {
      if (category && post.category !== category) return false;
      if (!text) return true;
      return [
        post.title,
        post.content,
        post.category,
        post.author && post.author.displayName,
      ].some((value) => String(value || "").toLowerCase().includes(text));
    });
  },

  onSearchInput(e) {
    const keyword = e.detail.value || "";
    this.setData({
      keyword,
      displayPosts: this.filterPosts(this.data.posts, keyword, this.data.activeCategory),
    });
  },

  clearSearch() {
    this.setData({
      keyword: "",
      displayPosts: this.filterPosts(this.data.posts, "", this.data.activeCategory),
    });
  },

  tapQuickChannel(e) {
    if (e.currentTarget.dataset.action === "campusMap") {
      this.openCampusMap();
      return;
    }
    this.selectCategory(e);
  },

  openCampusMap() {
    wx.navigateTo({ url: "/campus-map/pages/index" });
  },

  selectCategory(e) {
    const activeCategory = e.currentTarget.dataset.category || "";
    if (activeCategory === this.data.activeCategory) return;
    const selected = this.data.categories.find((item) => item.key === activeCategory);
    this.setData({
      activeCategory,
      activeCategoryText: selected && selected.key ? selected.text : "全部动态",
      keyword: "",
      posts: [],
      displayPosts: [],
      hasMore: true,
    }, () => {
      this.fetchPosts(true);
    });
  },

  selectSort(e) {
    const activeSort = e.currentTarget.dataset.sort === "hot" ? "hot" : "latest";
    if (activeSort === this.data.activeSort) return;
    this.setData({ activeSort, posts: [], displayPosts: [], hasMore: true }, () => {
      this.fetchPosts(true);
    });
  },

  goPublish(e) {
    if (!requireLogin()) return;
    const category = e && e.currentTarget && e.currentTarget.dataset.category || "";
    const suffix = category ? `?category=${encodeURIComponent(category)}` : "";
    wx.navigateTo({ url: `/pages/publish-post/index${suffix}` });
  },

  goWeeklyHotPost(e) {
    const id = e && e.currentTarget && e.currentTarget.dataset.id;
    if (!id) return;
    wx.navigateTo({ url: `/pages/post-detail/index?id=${id}` });
  },

  openWeeklyRanking() {
    if (!this.data.weeklyHotPosts.length) return;
    this.setData({ showWeeklyRanking: true });
  },

  closeWeeklyRanking() {
    this.setData({ showWeeklyRanking: false });
  },

  stopRankingTap() {},

  goRankingPost(e) {
    const id = e && e.currentTarget && e.currentTarget.dataset.id;
    if (!id) return;
    this.setData({ showWeeklyRanking: false }, () => {
      wx.navigateTo({ url: `/pages/post-detail/index?id=${id}` });
    });
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/pages/post-detail/index?id=${e.currentTarget.dataset.id}`,
    });
  },

  onShareAppMessage() {
    return {
      title: "鹏宇优选校园圈",
      path: "/pages/forum/index",
    };
  },

  onShareTimeline() {
    return {
      title: "鹏宇优选校园圈",
      query: "",
    };
  },
});
