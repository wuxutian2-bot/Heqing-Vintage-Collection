const { callCloud, normalizeGoods } = require("../../utils/cloud");

const categories = ["全部", "零食", "饮料", "数码", "教材", "学习用品", "生活用品", "服饰鞋包", "运动健身", "美妆护理", "票券卡类", "求购", "其他"];
const sorts = [
  { key: "latest", text: "最新发布" },
  { key: "hot", text: "最多浏览" },
  { key: "price_asc", text: "价格从低到高" },
  { key: "price_desc", text: "价格从高到低" },
];
const quickCategories = [
  { category: "数码", label: "数码", icon: "/images/market/category-digital.png" },
  { category: "教材", label: "教材", icon: "/images/market/category-textbook.png" },
  { category: "生活用品", label: "生活", icon: "/images/market/category-life.png" },
  { category: "服饰鞋包", label: "服饰", icon: "/images/market/category-clothing.png" },
  { category: "运动健身", label: "运动", icon: "/images/market/category-sports.png" },
  { category: "求购", label: "求购", icon: "/images/market/category-wanted.png" },
];
const skeletons = [1, 2, 3, 4];

const presentGoods = (item) => {
  const goods = normalizeGoods(item);
  const platformOwned = goods.platformOwned === true;
  const platformPriceFen = Number(goods.platformSalePriceFen || goods.salePriceFen || 0);
  return {
    ...goods,
    platformOwned,
    priceText: platformOwned && Number.isInteger(platformPriceFen) && platformPriceFen > 0
      ? (platformPriceFen / 100).toFixed(2)
      : goods.priceText,
    pricePrefix: goods.category === "求购" ? "预算 ￥" : "￥",
  };
};

Page({
  data: {
    categories,
    sorts,
    quickCategories,
    skeletons,
    activeCategory: "全部",
    activeSort: "latest",
    keyword: "",
    goodsList: [],
    page: 1,
    pageSize: 12,
    hasMore: true,
    loading: false,
  },

  onLoad() {
    this.fetchGoods(true);
  },

  onShow() {
    if (!this.data.loading) {
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

  clearKeyword() {
    this.setData({ keyword: "" }, () => this.fetchGoods(true));
  },

  onCategoryTap(e) {
    const category = e.currentTarget.dataset.category;
    this.setData({ activeCategory: category }, () => this.fetchGoods(true));
  },

  onQuickCategoryTap(e) {
    const category = e.currentTarget.dataset.category;
    this.setData({ activeCategory: category }, () => this.fetchGoods(true));
  },

  onSortTap(e) {
    this.setData({ activeSort: e.currentTarget.dataset.sort }, () => this.fetchGoods(true));
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
          sort: this.data.activeSort,
        },
        { silent: !reset }
      );
      const list = (res.data || []).map(presentGoods);
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
    wx.navigateTo({
      url: "/pages/publish-goods/index",
    });
  },

  onShareAppMessage() {
    return {
      title: "宿院集",
      path: "/pages/home/index",
    };
  },

  onShareTimeline() {
    return {
      title: "宿院集",
      query: "",
    };
  },
});
