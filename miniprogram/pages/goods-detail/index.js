const { callCloud, formatTime, normalizeGoods, requireLogin } = require("../../utils/cloud");

const createIdempotencyKey = (prefix, id) => `${prefix}_${id}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

Page({
  data: {
    id: "",
    goods: null,
    favorite: false,
    loading: true,
    currentUserId: "",
    isAdmin: false,
    isOwner: false,
    isPlatformGoods: false,
    platformAvailable: false,
    c2cCheckoutEnabled: false,
    canApplyRecovery: false,
    recovering: false,
    creatingOrder: false,
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
    // 从市场订单页返回时重新读取库存，避免已锁定或已售商品仍显示购买按钮。
    if (this.data.id && this.data.goods) this.fetchDetail();
  },

  async fetchDetail() {
    if (!this.data.id) return;
    this.setData({ loading: true });
    try {
      const res = await callCloud("goods", { type: "detail", id: this.data.id });
      const goods = normalizeGoods(res.data || {});
      goods.updatedText = formatTime(goods.updatedAt);
      const isPlatformGoods = goods.platformOwned === true;
      const isOwner = !isPlatformGoods
        && !!goods.author
        && goods.author.userId === this.data.currentUserId;
      const platformPriceFen = Number(goods.platformSalePriceFen || goods.salePriceFen || 0);
      goods.displayPriceText = isPlatformGoods && Number.isInteger(platformPriceFen) && platformPriceFen > 0
        ? (platformPriceFen / 100).toFixed(2)
        : goods.priceText;
      goods.inventoryId = goods.inventoryId || goods.marketInventoryId || "";
      let platformAvailable = false;
      let c2cCheckoutEnabled = false;
      if (isPlatformGoods && goods.status === "on_sale" && goods.inventoryId) {
        try {
          const inventoryResult = await callCloud("market", {
            type: "catalogGet",
            inventoryId: goods.inventoryId,
          }, { silent: true });
          const inventory = inventoryResult.data && inventoryResult.data.item
            ? inventoryResult.data.item
            : null;
          platformAvailable = Boolean(
            inventory
            && inventory._id === goods.inventoryId
            && inventory.goodsId === goods._id
            && inventory.status === "on_sale"
          );
          const inventoryPriceFen = Number(inventory && inventory.priceFen);
          if (platformAvailable && Number.isInteger(inventoryPriceFen) && inventoryPriceFen > 0) {
            goods.displayPriceText = (inventoryPriceFen / 100).toFixed(2);
          }
        } catch (error) {
          // 库存查不到、已锁定或请求失败时均按不可购买处理，最终仍由 saleCreate 原子校验。
          console.warn("[market inventory] unavailable", { code: error && error.code });
        }
      }
      if (!isPlatformGoods && !isOwner && goods.status === "on_sale" && goods.category !== "求购") {
        try {
          const readiness = await callCloud("c2c-market", { type: "readiness" }, { silent: true });
          c2cCheckoutEnabled = Boolean(readiness && readiness.data && readiness.data.policy && readiness.data.policy.checkoutEnabled);
        } catch (error) {
          // 未部署或未配置时保持担保购买关闭，不提供绕过平台的站内交易入口。
          console.warn("[c2c-market] readiness unavailable", { code: error && error.code });
        }
      }
      this.setData({
        goods,
        isOwner,
        isPlatformGoods,
        platformAvailable,
        c2cCheckoutEnabled,
        canApplyRecovery: isOwner && goods.status === "on_sale" && goods.category !== "求购",
      });
      this.checkFavorite();
    } finally {
      this.setData({ loading: false });
    }
  },

  async checkFavorite() {
    if (!wx.getStorageSync("user")) return;
    const res = await callCloud(
      "favorites",
      {
        type: "check",
        targetType: "goods",
        targetId: this.data.id,
      },
      { silent: true }
    );
    this.setData({ favorite: !!res.favorite });
  },

  previewImage(e) {
    const current = e.currentTarget.dataset.src;
    wx.previewImage({
      current,
      urls: this.data.goods.images || [],
    });
  },

  applyRecovery() {
    const user = requireLogin();
    if (!user || !this.data.canApplyRecovery || this.data.recovering) return;
    wx.showModal({
      title: "申请平台回收",
      content: "提交后平台会报价并验收实物。你确认最终报价、平台确认收购后，才会生成可领取的回收款。",
      confirmText: "提交申请",
      confirmColor: "#174c3b",
      success: async (modal) => {
        if (!modal.confirm) return;
        this.setData({ recovering: true });
        try {
          await callCloud("market", {
            type: "recoverySubmit",
            goodsId: this.data.id,
            idempotencyKey: createIdempotencyKey("recovery", this.data.id),
          }, { loadingText: "正在提交" });
          wx.showToast({ title: "回收申请已提交", icon: "success" });
          setTimeout(() => wx.navigateTo({ url: "/pages/recovery-list/index" }), 450);
        } finally {
          this.setData({ recovering: false });
        }
      },
    });
  },

  async buyPlatformGoods() {
    const user = requireLogin();
    if (!user || !this.data.platformAvailable || this.data.creatingOrder) return;
    this.setData({ creatingOrder: true });
    try {
      const res = await callCloud("market", {
        type: "saleCreate",
        inventoryId: this.data.goods.inventoryId,
        idempotencyKey: createIdempotencyKey("sale", this.data.goods.inventoryId),
      }, { loadingText: "正在创建订单" });
      const order = res.data && res.data.order ? res.data.order : (res.data || {});
      const orderId = order._id || order.id || order.saleOrderId || res.id;
      if (!orderId) throw new Error("市场订单创建成功，但未返回订单编号");
      wx.navigateTo({ url: `/pages/market-order-detail/index?id=${orderId}` });
    } catch (error) {
      if (error && error.message) {
        wx.showToast({ title: error.message.slice(0, 20), icon: "none" });
      }
    } finally {
      this.setData({ creatingOrder: false });
    }
  },

  async buyC2CGoods() {
    const user = requireLogin();
    if (!user || !this.data.c2cCheckoutEnabled || this.data.creatingOrder || !this.data.goods) return;
    this.setData({ creatingOrder: true });
    try {
      const res = await callCloud("c2c-market", {
        type: "createOrder",
        goodsId: this.data.goods._id,
        idempotencyKey: createIdempotencyKey("c2c", this.data.goods._id),
      }, { loadingText: "正在锁定商品" });
      const order = res.data && res.data.order ? res.data.order : {};
      const orderId = order._id || order.id;
      if (!orderId) throw new Error("担保订单创建成功，但未返回订单编号");
      wx.navigateTo({ url: `/pages/c2c-order-detail/index?id=${orderId}` });
    } catch (error) {
      if (error && error.message) wx.showToast({ title: error.message.slice(0, 20), icon: "none" });
    } finally {
      this.setData({ creatingOrder: false });
    }
  },

  async toggleFavorite() {
    if (!requireLogin()) return;
    const res = await callCloud(
      "favorites",
      {
        type: "toggle",
        targetType: "goods",
        targetId: this.data.id,
      },
      { loadingText: "处理中" }
    );
    this.setData({ favorite: res.favorite });
    wx.showToast({
      title: res.favorite ? "已收藏" : "已取消",
      icon: "success",
    });
  },

  adminRemoveGoods() {
    if (!this.data.isAdmin || !this.data.goods) return;
    wx.showModal({
      title: "管理员下架商品",
      content: "下架后该商品将从校园市场隐藏。确认继续？",
      confirmText: "确认下架",
      confirmColor: "#B83A32",
      success: async (result) => {
        if (!result.confirm) return;
        await callCloud("goods", {
          type: "updateStatus",
          id: this.data.id,
          status: "removed",
        }, { loadingText: "正在下架" });
        wx.showToast({ title: "商品已下架", icon: "success" });
        setTimeout(() => wx.navigateBack(), 500);
      },
    });
  },

  onShareAppMessage() {
    return {
      title: (this.data.goods && this.data.goods.title) || "鹏宇优选校园市场",
      path: `/pages/goods-detail/index?id=${this.data.id}`,
    };
  },

  onShareTimeline() {
    return {
      title: (this.data.goods && this.data.goods.title) || "鹏宇优选校园市场",
      query: `id=${this.data.id}`,
    };
  },
});
