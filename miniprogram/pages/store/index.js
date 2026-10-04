const { callCloud, formatPrice } = require("../../utils/cloud");
const cart = require("../../utils/cart");

const categories = [
  "全部",
  "速食泡面类",
  "膨化食品类",
  "辣条面筋调味面制品",
  "卤味肉食类",
  "蛋类",
  "饼干糕点类",
  "魔芋素肉",
  "瓜子炒货坚果",
  "香肠类",
];

const buildingOptions = Array.from({ length: 16 }, (_, index) => `${index + 1}号楼`);
const outletIdForBuilding = (buildingNo) => `building_${String(buildingNo).padStart(2, "0")}_outlet`;
const normalizeBuildingNo = (value) => {
  const buildingNo = Number(value);
  return Number.isInteger(buildingNo) && buildingNo >= 1 && buildingNo <= 16
    ? buildingNo
    : 1;
};

Page({
  data: {
    categories,
    activeCategory: "全部",
    keyword: "",
    defaultAddress: null,
    selectedOutlet: null,
    products: [],
    loading: true,
    setupRequired: false,
    canManageStore: false,
    isGuest: true,
    buildingOptions,
    currentBuildingNo: 1,
    browseBuildingIndex: 0,
    cartCount: 0,
  },

  onLoad() {
    const user = wx.getStorageSync("user");
    this.setData({ canManageStore: !!user && ["admin", "outlet_admin"].includes(user.role) });
  },

  onShow() {
    const user = wx.getStorageSync("user");
    const addressBuildingNo = user && user.defaultAddress
      ? Number(user.defaultAddress.buildingNo)
      : 0;
    const localBuildingNo = Number(wx.getStorageSync("browseBuildingNo"));
    const buildingNo = normalizeBuildingNo(addressBuildingNo || localBuildingNo || 1);
    if (addressBuildingNo) wx.setStorageSync("browseBuildingNo", buildingNo);

    this.setData({
      defaultAddress: user && user.defaultAddress ? user.defaultAddress : null,
      canManageStore: !!user && ["admin", "outlet_admin"].includes(user.role),
      isGuest: !user,
      currentBuildingNo: buildingNo,
      browseBuildingIndex: buildingNo - 1,
      cartCount: cart.getCount(),
    });
    this.loadOutletForBuilding(
      buildingNo,
      user && user.schoolId ? user.schoolId : getApp().globalData.schoolId
    );
  },

  onPullDownRefresh() {
    const user = wx.getStorageSync("user");
    const schoolId = user && user.schoolId
      ? user.schoolId
      : getApp().globalData.schoolId;
    this.loadOutletForBuilding(this.data.currentBuildingNo, schoolId)
      .finally(() => wx.stopPullDownRefresh());
  },

  async loadOutletForBuilding(buildingNo, schoolId) {
    const normalizedBuildingNo = normalizeBuildingNo(buildingNo);
    this.setData({ loading: true });
    try {
      const res = await callCloud("store", {
        type: "listOutlets",
        schoolId: schoolId || getApp().globalData.schoolId,
      });
      const expectedId = outletIdForBuilding(normalizedBuildingNo);
      const outlets = (res.data || []).map((item) => ({
        ...item,
        deliveryFeeText: formatPrice(item.deliveryFeeFen),
        minimumOrderText: formatPrice(item.minimumOrderFen),
      }));
      const selectedOutlet = outlets.find((item) => item._id === expectedId)
        || outlets.find((item) => Number(item.buildingNo) === normalizedBuildingNo)
        || null;
      if (selectedOutlet) wx.setStorageSync("selectedOutletId", selectedOutlet._id);
      this.setData({
        selectedOutlet,
        setupRequired: !!res.setupRequired,
      });
      if (selectedOutlet) {
        await this.loadProducts();
      } else {
        this.setData({ products: [] });
      }
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadProducts() {
    if (!this.data.selectedOutlet) return;
    this.setData({ loading: true });
    try {
      const res = await callCloud("store", {
        type: "listProducts",
        outletId: this.data.selectedOutlet._id,
        category: this.data.activeCategory === "全部" ? "" : this.data.activeCategory,
        keyword: this.data.keyword.trim(),
      });
      this.setData({
        products: (res.data || []).map((item) => ({
          ...item,
          priceText: formatPrice(item.priceFen),
          stockText: Number(item.stock) > 0 ? `仅剩${item.stock}件` : "已售罄",
        })),
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  onCategoryTap(e) {
    const category = e.currentTarget.dataset.category;
    if (!category || category === this.data.activeCategory) return;
    this.setData({ activeCategory: category }, () => this.loadProducts());
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearch() {
    this.loadProducts();
  },

  applyBrowseBuilding(buildingNo) {
    const normalizedBuildingNo = normalizeBuildingNo(buildingNo);
    wx.setStorageSync("browseBuildingNo", normalizedBuildingNo);
    this.setData({
      currentBuildingNo: normalizedBuildingNo,
      browseBuildingIndex: normalizedBuildingNo - 1,
      selectedOutlet: null,
      products: [],
      cartCount: cart.getCount(),
    });
    return this.loadOutletForBuilding(normalizedBuildingNo, getApp().globalData.schoolId);
  },

  onBrowseBuildingChange(e) {
    const buildingNo = normalizeBuildingNo(Number(e.detail.value) + 1);
    if (buildingNo === this.data.currentBuildingNo) return;

    const currentCart = cart.getCart();
    const targetOutletId = outletIdForBuilding(buildingNo);
    if (currentCart.items.length && currentCart.outletId && currentCart.outletId !== targetOutletId) {
      wx.showModal({
        title: "切换浏览楼栋",
        content: "不同楼栋库存独立，切换后将清空当前购物车。是否继续？",
        confirmText: "继续切换",
        success: (result) => {
          if (!result.confirm) {
            this.setData({ browseBuildingIndex: this.data.currentBuildingNo - 1 });
            return;
          }
          cart.clearCart();
          this.applyBrowseBuilding(buildingNo);
        },
      });
      return;
    }
    this.applyBrowseBuilding(buildingNo);
  },

  goAddress() {
    if (!wx.getStorageSync("user")) {
      wx.navigateTo({ url: "/pages/login/index" });
      return;
    }
    wx.navigateTo({ url: "/pages/address/index" });
  },

  goProduct(e) {
    wx.navigateTo({ url: `/pages/store-product/index?id=${e.currentTarget.dataset.id}` });
  },

  addProductToCart(product, replaceOutlet = false) {
    const result = cart.addItem(product, replaceOutlet);
    if (result.conflict) return false;
    this.setData({ cartCount: cart.getCount() });
    wx.showToast({ title: "已加入购物车", icon: "success" });
    return true;
  },

  addToCart(e) {
    const product = this.data.products.find((item) => item._id === e.currentTarget.dataset.id);
    if (!product || Number(product.stock) <= 0) {
      wx.showToast({ title: "商品已售罄", icon: "none" });
      return;
    }
    if (this.addProductToCart(product)) return;
    wx.showModal({
      title: "切换代售点商品",
      content: "购物车中有其他楼栋的商品，继续将清空原购物车。",
      confirmText: "继续",
      success: (result) => {
        if (result.confirm) this.addProductToCart(product, true);
      },
    });
  },

  goAdmin() {
    wx.navigateTo({ url: "/pages/admin-store/index" });
  },

  goCart() {
    wx.navigateTo({ url: "/pages/cart/index" });
  },

  onShareAppMessage() {
    return {
      title: "鹏宇优选 · 宿舍好物送到门",
      path: "/pages/store/index",
    };
  },
});
