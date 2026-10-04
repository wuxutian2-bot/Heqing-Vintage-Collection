const { callCloud, formatPrice } = require("../../utils/cloud");

const categories = [
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
const SYSTEM_PRODUCT_IMAGE = "/images/default-goods-image.png";
const blankOutlet = () => ({
  id: "",
  buildingNo: "1",
  name: "",
  buildingName: "",
  notice: "",
  businessHours: "",
  deliveryFeeYuan: "0",
  minimumOrderYuan: "0",
  sort: "0",
  isActive: true,
});
const blankProduct = () => ({
  id: "",
  outletId: "",
  sku: "",
  sourceType: "catalog",
  productGroupId: "",
  title: "",
  category: categories[0],
  priceYuan: "",
  stock: "0",
  image: "",
  desc: "",
  status: "on_sale",
});
const yuanToFen = (value) => Math.round(Number(value || 0) * 100);
const outletLabel = (outlet) => outlet ? `${outlet.buildingName} · ${outlet.name}` : "请选择代售点";

Page({
  data: {
    mode: "outlets",
    isSuperAdmin: false,
    isOutletAdmin: false,
    managedOutletId: "",
    managerRoleText: "",
    categories,
    outlets: [],
    outletNames: [],
    products: [],
    activeOutletId: "",
    outletForm: blankOutlet(),
    productForm: blankProduct(),
    productOutletLabel: "请选择代售点",
    productCreateMode: "catalog",
    catalogItems: [],
    catalogMatches: [],
    catalogKeyword: "",
    selectedOutletIds: [],
    productOutletOptions: [],
    selectedOutletCount: 0,
    productImagePreview: SYSTEM_PRODUCT_IMAGE,
    productImageHint: "当前使用系统默认商品图，可按需更换",
    defaultProductImage: SYSTEM_PRODUCT_IMAGE,
    loading: false,
    uploading: false,
    batchUpdatingImage: false,
    bootstrapLoading: false,
    bootstrapProgress: "",
    setupRequired: false,
  },

  onShow() {
    const user = wx.getStorageSync("user");
    const isSuperAdmin = !!user && user.role === "admin";
    const isOutletAdmin = !!user && user.role === "outlet_admin";
    if (!isSuperAdmin && !isOutletAdmin) {
      wx.showToast({ title: "无管理员权限", icon: "none" });
      setTimeout(() => wx.navigateBack(), 300);
      return;
    }
    if (isOutletAdmin && !user.managedOutletId) {
      wx.showToast({ title: "尚未分配代售点", icon: "none" });
      setTimeout(() => wx.navigateBack(), 500);
      return;
    }
    this.setData({
      isSuperAdmin,
      isOutletAdmin,
      managedOutletId: user.managedOutletId || "",
      managerRoleText: isSuperAdmin ? "代售点总管理员" : "普通代售点管理员",
      mode: isSuperAdmin ? this.data.mode : "products",
    }, () => this.loadAll());
  },

  async loadAll() {
    this.setData({ loading: true });
    try {
      const outletRes = await callCloud("store", { type: "adminListOutlets" });
      const outlets = (outletRes.data || []).map((item) => ({
        ...item,
        deliveryFeeText: formatPrice(item.deliveryFeeFen),
        minimumOrderText: formatPrice(item.minimumOrderFen),
      }));
      const scope = outletRes.scope || {};
      const isSuperAdmin = scope.isSuperAdmin !== undefined ? Boolean(scope.isSuperAdmin) : this.data.isSuperAdmin;
      const managedOutletId = scope.managedOutletId || this.data.managedOutletId;
      const activeOutletId = isSuperAdmin
        ? (this.data.activeOutletId || (outlets[0] && outlets[0]._id) || "")
        : managedOutletId;
      const tasks = [callCloud("store", { type: "adminListProducts", outletId: activeOutletId })];
      if (isSuperAdmin) tasks.push(callCloud("store", { type: "adminListCatalog" }));
      const [productRes, catalogRes = {}] = await Promise.all(tasks);
      const defaultProductImage = catalogRes.defaultImage || SYSTEM_PRODUCT_IMAGE;
      const selectedOutletIds = this.data.selectedOutletIds.filter((id) => outlets.some((item) => item._id === id));
      if (!selectedOutletIds.length && activeOutletId) selectedOutletIds.push(activeOutletId);
      this.setData({
        outlets,
        outletNames: outlets.map(outletLabel),
        products: (productRes.data || []).map((item) => ({ ...item, priceText: formatPrice(item.priceFen) })),
        activeOutletId,
        "productForm.outletId": activeOutletId,
        productOutletLabel: outletLabel(outlets.find((item) => item._id === activeOutletId)),
        catalogItems: (catalogRes.data || []).map((item) => ({ ...item, priceText: formatPrice(item.priceFen) })),
        defaultProductImage,
        setupRequired: !!outletRes.setupRequired || !!productRes.setupRequired,
        isSuperAdmin,
        isOutletAdmin: !isSuperAdmin,
        managedOutletId,
        managerRoleText: isSuperAdmin ? "代售点总管理员" : "普通代售点管理员",
        mode: isSuperAdmin ? this.data.mode : "products",
      });
      this.setSelectedOutlets(selectedOutletIds);
      this.refreshCatalogMatches();
    } finally {
      this.setData({ loading: false });
    }
  },

  switchMode(e) {
    if (!this.data.isSuperAdmin && e.currentTarget.dataset.mode !== "products") return;
    this.setData({ mode: e.currentTarget.dataset.mode });
  },

  onOutletInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`outletForm.${field}`]: e.detail.value });
  },

  onProductInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [`productForm.${field}`]: e.detail.value });
  },

  onProductOutletChange(e) {
    const outlet = this.data.outlets[Number(e.detail.value)];
    if (!outlet) return;
    const wasEditing = Boolean(this.data.productForm.id);
    this.setData({
      activeOutletId: outlet._id,
      "productForm.outletId": outlet._id,
      productOutletLabel: outletLabel(outlet),
    }, () => {
      if (wasEditing) this.resetProductForm();
      else this.setSelectedOutlets([outlet._id]);
      this.loadProducts(outlet._id);
    });
  },

  onCategoryChange(e) {
    const category = this.data.categories[Number(e.detail.value)] || this.data.categories[0];
    const updates = { "productForm.category": category };
    if (this.data.productCreateMode === "catalog" && !this.data.productForm.id) {
      Object.assign(updates, {
        "productForm.sku": "",
        "productForm.title": "",
        "productForm.priceYuan": "",
        "productForm.image": "",
        productImagePreview: this.data.defaultProductImage,
        productImageHint: "当前使用系统默认商品图，可按需更换",
      });
    }
    this.setData(updates, () => this.refreshCatalogMatches());
  },

  switchProductCreateMode(e) {
    if (this.data.productForm.id) return;
    const productCreateMode = e.currentTarget.dataset.mode === "custom" ? "custom" : "catalog";
    const form = blankProduct();
    form.outletId = this.data.activeOutletId;
    form.sourceType = productCreateMode;
    this.setData({
      productCreateMode,
      productForm: form,
      catalogKeyword: "",
      productImagePreview: this.data.defaultProductImage,
      productImageHint: "当前使用系统默认商品图，可按需更换",
    }, () => this.refreshCatalogMatches());
  },

  onCatalogKeywordInput(e) {
    this.setData({ catalogKeyword: e.detail.value }, () => this.refreshCatalogMatches());
  },

  refreshCatalogMatches() {
    const keyword = String(this.data.catalogKeyword || "").trim().toLowerCase();
    const category = this.data.productForm.category;
    const candidates = keyword
      ? this.data.catalogItems
      : this.data.catalogItems.filter((item) => item.category === category);
    const matches = candidates
      .filter((item) => !keyword || item.title.toLowerCase().includes(keyword))
      .slice(0, 12);
    this.setData({ catalogMatches: matches });
  },

  selectCatalogProduct(e) {
    const item = this.data.catalogItems.find((entry) => entry.sku === e.currentTarget.dataset.sku);
    if (!item) return;
    this.setData({
      "productForm.sku": item.sku,
      "productForm.sourceType": "catalog",
      "productForm.title": item.title,
      "productForm.category": item.category,
      "productForm.priceYuan": formatPrice(item.priceFen),
      "productForm.image": item.hasDefaultImage ? item.image : "",
      catalogKeyword: item.title,
      productImagePreview: item.image || this.data.defaultProductImage,
      productImageHint: item.hasDefaultImage
        ? "已采用该商品的默认图片，无需重新上传"
        : "该商品暂无专属图片，保存时使用系统默认图",
    }, () => this.refreshCatalogMatches());
  },

  setSelectedOutlets(ids) {
    const selectedOutletIds = Array.from(new Set(ids)).filter((id) => this.data.outlets.some((item) => item._id === id));
    this.setData({
      selectedOutletIds,
      selectedOutletCount: selectedOutletIds.length,
      productOutletOptions: this.data.outlets.map((item) => ({
        ...item,
        label: outletLabel(item),
        selected: selectedOutletIds.includes(item._id),
      })),
    });
  },

  toggleProductOutlet(e) {
    if (this.data.productForm.id) return;
    const id = e.currentTarget.dataset.id;
    const ids = this.data.selectedOutletIds.includes(id)
      ? this.data.selectedOutletIds.filter((item) => item !== id)
      : [...this.data.selectedOutletIds, id];
    this.setSelectedOutlets(ids);
  },

  selectAllProductOutlets() {
    if (!this.data.productForm.id) this.setSelectedOutlets(this.data.outlets.map((item) => item._id));
  },

  clearProductOutlets() {
    if (!this.data.productForm.id) this.setSelectedOutlets([]);
  },

  async loadProducts(outletId) {
    const res = await callCloud("store", { type: "adminListProducts", outletId });
    this.setData({ products: (res.data || []).map((item) => ({ ...item, priceText: formatPrice(item.priceFen) })) });
  },

  resetOutletForm() {
    if (!this.data.isSuperAdmin) return;
    this.setData({ outletForm: blankOutlet() });
  },

  editOutlet(e) {
    if (!this.data.isSuperAdmin) return;
    const item = this.data.outlets.find((outlet) => outlet._id === e.currentTarget.dataset.id);
    if (!item) return;
    this.setData({
      outletForm: {
        id: item._id,
        buildingNo: String(item.buildingNo || 1),
        name: item.name,
        buildingName: item.buildingName,
        notice: item.notice || "",
        businessHours: item.businessHours || "",
        deliveryFeeYuan: formatPrice(item.deliveryFeeFen),
        minimumOrderYuan: formatPrice(item.minimumOrderFen),
        sort: String(item.sort || 0),
        isActive: item.isActive !== false,
      },
    });
  },

  async submitOutlet() {
    if (!this.data.isSuperAdmin) return;
    const form = this.data.outletForm;
    await callCloud("store", {
      type: "saveOutlet",
      id: form.id,
      buildingNo: Number(form.buildingNo),
      name: form.name,
      buildingName: form.buildingName,
      notice: form.notice,
      businessHours: form.businessHours,
      deliveryFeeFen: yuanToFen(form.deliveryFeeYuan),
      minimumOrderFen: yuanToFen(form.minimumOrderYuan),
      sort: Number(form.sort || 0),
      isActive: form.isActive,
    }, { loadingText: "保存中" });
    wx.showToast({ title: "代售点已保存", icon: "success" });
    this.resetOutletForm();
    this.loadAll();
  },

  async bootstrapCatalog() {
    if (this.data.bootstrapLoading) return;
    const managedOutlet = this.data.outlets.find((item) => item._id === this.data.managedOutletId) || this.data.outlets[0];
    if (!this.data.isSuperAdmin && !managedOutlet) {
      wx.showToast({ title: "尚未分配代售点", icon: "none" });
      return;
    }
    const buildingNumbers = this.data.isSuperAdmin
      ? Array.from({ length: 16 }, (_, index) => index + 1)
      : [Number(managedOutlet.buildingNo)];
    const confirmed = await new Promise((resolve) => {
      wx.showModal({
        title: this.data.isSuperAdmin ? "初始化全部代售点" : "初始化本代售点",
        content: this.data.isSuperAdmin
          ? "将按商品表为1-16号楼分别补齐27款商品，每款初始库存1。已有商品不会重复创建或重置库存。"
          : `仅为${managedOutlet.name}补齐商品表，已有商品和库存不会被重置。`,
        confirmText: "开始",
        success: (result) => resolve(result.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) return;
    this.setData({ bootstrapLoading: true, bootstrapProgress: "准备初始化..." });
    let createdProducts = 0;
    try {
      for (let index = 0; index < buildingNumbers.length; index += 1) {
        const buildingNo = buildingNumbers[index];
        this.setData({
          bootstrapProgress: this.data.isSuperAdmin
            ? `正在处理 ${index + 1}/${buildingNumbers.length} 个代售点`
            : `正在初始化 ${managedOutlet.name}`,
        });
        const result = await callCloud("store", { type: "bootstrapCatalog", buildingNo }, { silent: true });
        createdProducts += Number(result.createdProducts || 0);
      }
      this.setData({ bootstrapProgress: `完成：新增 ${createdProducts} 条商品库存` });
      wx.showToast({ title: "初始化完成", icon: "success" });
      await this.loadAll();
    } catch (error) {
      wx.showToast({ title: error.message || "初始化中断", icon: "none" });
    } finally {
      this.setData({ bootstrapLoading: false });
    }
  },

  async toggleOutlet(e) {
    if (!this.data.isSuperAdmin) return;
    const item = this.data.outlets.find((outlet) => outlet._id === e.currentTarget.dataset.id);
    if (!item) return;
    await callCloud("store", {
      type: "saveOutlet",
      id: item._id,
      name: item.name,
      buildingName: item.buildingName,
      buildingNo: item.buildingNo,
      notice: item.notice,
      businessHours: item.businessHours,
      deliveryFeeFen: item.deliveryFeeFen,
      minimumOrderFen: item.minimumOrderFen,
      sort: item.sort,
      isActive: !item.isActive,
    }, { loadingText: "更新中" });
    this.loadAll();
  },

  resetProductForm() {
    const form = blankProduct();
    form.outletId = this.data.activeOutletId;
    const outlet = this.data.outlets.find((item) => item._id === form.outletId);
    this.setData({
      productCreateMode: "catalog",
      productForm: form,
      catalogKeyword: "",
      productOutletLabel: outletLabel(outlet),
      productImagePreview: this.data.defaultProductImage,
      productImageHint: "当前使用系统默认商品图，可按需更换",
    }, () => {
      this.setSelectedOutlets(form.outletId ? [form.outletId] : []);
      this.refreshCatalogMatches();
    });
  },

  editProduct(e) {
    const item = this.data.products.find((product) => product._id === e.currentTarget.dataset.id);
    if (!item) return;
    const outlet = this.data.outlets.find((entry) => entry._id === item.outletId);
    const catalogItem = item.sku && this.data.catalogItems.find((entry) => entry.sku === item.sku);
    const productCreateMode = catalogItem ? "catalog" : "custom";
    this.setData({
      productCreateMode,
      productForm: {
        id: item._id,
        outletId: item.outletId,
        sku: item.sku || "",
        sourceType: productCreateMode,
        productGroupId: item.productGroupId || "",
        title: item.title,
        category: item.category,
        priceYuan: formatPrice(item.priceFen),
        stock: String(item.stock),
        image: item.storedImage || "",
        desc: item.desc || "",
        status: item.status,
      },
      catalogKeyword: item.title,
      productImagePreview: item.image || this.data.defaultProductImage,
      productImageHint: item.storedImage ? "当前商品已有图片，需要时可更换" : "当前使用系统默认商品图，可按需更换",
      productOutletLabel: outletLabel(outlet),
    }, () => {
      this.setSelectedOutlets([item.outletId]);
      this.refreshCatalogMatches();
    });
  },

  async chooseProductImage() {
    if (!this.data.isSuperAdmin || this.data.uploading) return;
    const media = await new Promise((resolve, reject) => {
      wx.chooseMedia({ count: 1, mediaType: ["image"], success: resolve, fail: reject });
    }).catch(() => null);
    if (!media || !media.tempFiles || !media.tempFiles[0]) return;
    const filePath = media.tempFiles[0].tempFilePath;
    const extensionMatch = filePath.match(/\.[a-zA-Z0-9]+$/);
    const extension = extensionMatch ? extensionMatch[0] : ".jpg";
    this.setData({ uploading: true });
    try {
      const upload = await wx.cloud.uploadFile({
        cloudPath: `store-products/${Date.now()}-${Math.random().toString(36).slice(2, 8)}${extension}`,
        filePath,
      });
      this.setData({
        "productForm.image": upload.fileID,
        productImagePreview: upload.fileID,
        productImageHint: this.data.productForm.id
          ? "新图片已上传：可保存当前代售点，或统一应用到全部代售点"
          : "已选择新图片，保存后应用到所选代售点",
      });
    } finally {
      this.setData({ uploading: false });
    }
  },

  async applyImageToAllOutlets() {
    const form = this.data.productForm;
    if (!this.data.isSuperAdmin || !form.id || this.data.uploading || this.data.batchUpdatingImage) return;
    if (!String(form.image || "").startsWith("cloud://")) {
      wx.showToast({ title: "请先点击上方更换图片", icon: "none" });
      return;
    }

    this.setData({ batchUpdatingImage: true });
    try {
      const scope = await callCloud("store", {
        type: "previewProductGroupImageUpdate",
        id: form.id,
      }, { loadingText: "检查商品范围" });
      const modal = await new Promise((resolve) => {
        wx.showModal({
          title: "统一更换商品图片",
          content: `将“${scope.title || form.title}”的图片同步到${scope.affectedCount}个代售点。只修改图片，不改变价格、库存和上下架状态。是否继续？`,
          confirmText: "统一更换",
          confirmColor: "#16784b",
          success: resolve,
          fail: () => resolve({ confirm: false }),
        });
      });
      if (!modal.confirm) return;
      const result = await callCloud("store", {
        type: "updateProductGroupImage",
        id: form.id,
        image: form.image,
        expectedCount: scope.affectedCount,
      }, { loadingText: "统一更新中" });
      wx.showToast({ title: `已更新${result.updatedCount}个代售点`, icon: "success" });
      const outletId = form.outletId || this.data.activeOutletId;
      this.resetProductForm();
      await this.loadProducts(outletId);
    } catch (error) {
      // callCloud 已向用户显示具体错误，这里只负责恢复按钮状态。
    } finally {
      this.setData({ batchUpdatingImage: false });
    }
  },

  async submitProduct() {
    const form = this.data.productForm;
    if (this.data.isSuperAdmin) {
      if (form.id) {
        await callCloud("store", {
          type: "saveProduct",
          id: form.id,
          outletId: form.outletId,
          title: form.title,
          category: form.category,
          priceFen: yuanToFen(form.priceYuan),
          stock: Number(form.stock),
          image: form.image,
          desc: form.desc,
          status: form.status,
        }, { loadingText: "保存中" });
      } else {
        if (!this.data.selectedOutletIds.length) {
          wx.showToast({ title: "请至少选择一个代售点", icon: "none" });
          return;
        }
        const isCatalog = this.data.productCreateMode === "catalog";
        if (isCatalog && !form.sku) {
          wx.showToast({ title: "请从商品库选择商品", icon: "none" });
          return;
        }
        await callCloud("store", {
          type: isCatalog ? "saveCatalogProductBatch" : "saveCustomProductBatch",
          outletIds: this.data.selectedOutletIds,
          sku: form.sku,
          title: form.title,
          category: form.category,
          priceFen: yuanToFen(form.priceYuan),
          stock: Number(form.stock),
          image: form.image,
          desc: form.desc,
          status: form.status,
        }, { loadingText: this.data.selectedOutletIds.length > 1 ? "批量上架中" : "保存中" });
      }
      wx.showToast({ title: form.id ? "商品已保存" : `已应用到${this.data.selectedOutletIds.length}个代售点`, icon: "success" });
    } else {
      if (!form.id) {
        wx.showToast({ title: "请选择要调整的商品", icon: "none" });
        return;
      }
      await callCloud("store", { type: "updateProductStock", id: form.id, stock: Number(form.stock) }, { loadingText: "更新库存" });
      wx.showToast({ title: "库存已更新", icon: "success" });
    }
    const outletId = form.outletId || this.data.activeOutletId;
    this.resetProductForm();
    this.loadProducts(outletId);
  },

  async toggleProduct(e) {
    const item = this.data.products.find((product) => product._id === e.currentTarget.dataset.id);
    if (!item) return;
    await callCloud("store", {
      type: "updateProductStatus",
      id: item._id,
      status: item.status === "on_sale" ? "off_shelf" : "on_sale",
    }, { loadingText: "更新中" });
    this.loadProducts(item.outletId);
  },
});
