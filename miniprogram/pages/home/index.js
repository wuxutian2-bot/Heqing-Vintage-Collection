const { callCloud, normalizeGoods } = require("../../utils/cloud");

const categories = ["全部", "数码", "教材", "生活", "服饰", "运动", "其他"];

Page({
  data: {
    categories,
    activeCategory: "全部",
    keyword: "",
    goodsList: [],
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false,
  },

  onLoad() {
    this.fetchGoods(true);
  },

  onShow() {
    if (this.data.goodsList.length) {
      this.fetchGoods(true);
    }
  },

  onPullDownRefresh() {
    this.fetchGoods(true).finally(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading) {
      this.fetchGoods(false);
    }
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearch() {
    this.fetchGoods(true);
  },

  onCategoryTap(e) {
    const category = e.currentTarget.dataset.category;
    this.setData({ activeCategory: category }, () => this.fetchGoods(true));
  },

  async fetchGoods(reset) {
    const page = reset ? 1 : this.data.page;
    this.setData({ loading: true });
    try {
      const res = await callCloud(
        "goods",
        {
          type: "list",
          page,
          pageSize: this.data.pageSize,
          keyword: this.data.keyword.trim(),
          category: this.data.activeCategory === "全部" ? "" : this.data.activeCategory,
        },
        { silent: !reset }
      );
      const list = (res.data || []).map(normalizeGoods);
      this.setData({
        goodsList: reset ? list : this.data.goodsList.concat(list),
        page: page + 1,
        hasMore: list.length === this.data.pageSize,
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  goDetail(e) {
    wx.navigateTo({
      url: `/pages/goods-detail/index?id=${e.currentTarget.dataset.id}`,
    });
  },

  goPublish() {
    wx.switchTab({
      url: "/pages/publish-goods/index",
    });
  },
});
