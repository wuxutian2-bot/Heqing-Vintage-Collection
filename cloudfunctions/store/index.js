const cloud = require("wx-server-sdk");
const crypto = require("crypto");
const {
  PRODUCT_CATALOG,
  PRODUCT_CATEGORIES,
  outletDocId,
  productDocId,
} = require("./catalog");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const DEFAULT_SCHOOL_ID = "default-school";
const SUPER_ADMIN_ROLE = "admin";
const OUTLET_ADMIN_ROLE = "outlet_admin";
const DEFAULT_PRODUCT_IMAGE = "/images/default-goods-image.png";
const MAX_BATCH_OUTLETS = 16;
const DATABASE_PAGE_SIZE = 100;
const MAX_CATALOG_IMAGE_SCAN = 1000;
const CATALOG_IMAGE_BY_SKU = new Map(PRODUCT_CATALOG
  .filter((item) => item.image)
  .map((item) => [item.sku, item.image]));

const ok = (data = {}) => ({ success: true, ...data });
const fail = (errMsg) => ({ success: false, errMsg });
const getOpenId = () => cloud.getWXContext().OPENID;
const text = (value, maxLength) => String(value || "").trim().slice(0, maxLength);
const integer = (value, min, max) => {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) return null;
  return number;
};
const errorMessage = (error) => String(error && (error.errMsg || error.message) || error).toLowerCase();
const isCollectionMissing = (error) => {
  const message = errorMessage(error);
  return message.includes("collection") && (
    message.includes("not exist")
    || message.includes("not_exist")
    || message.includes("does not exist")
  );
};
const isDocumentMissing = (error) => {
  const message = errorMessage(error);
  return message.includes("document") && (
    message.includes("not exist")
    || message.includes("not_exist")
    || message.includes("does not exist")
  );
};
const catalogProductImage = (item) => CATALOG_IMAGE_BY_SKU.get(String(item && item.sku || "").trim()) || "";
const preferredProductImage = (...values) => {
  const candidates = values
    .map((value) => text(value, 500))
    .filter((value) => value && value !== DEFAULT_PRODUCT_IMAGE);
  return candidates.find((value) => value.startsWith("cloud://")) || candidates[0] || "";
};

const publicOutlet = (item) => ({
  _id: item._id,
  schoolId: item.schoolId,
  buildingNo: Number(item.buildingNo || 0),
  name: item.name,
  buildingName: item.buildingName,
  notice: item.notice || "",
  deliveryFeeFen: item.deliveryFeeFen || 0,
  minimumOrderFen: item.minimumOrderFen || 0,
  businessHours: item.businessHours || "",
  isActive: item.isActive !== false,
  sort: item.sort || 0,
});

const publicProduct = (item) => ({
  _id: item._id,
  outletId: item.outletId,
  title: item.title,
  category: item.category,
  priceFen: item.priceFen,
  stock: item.stock,
  image: preferredProductImage(item.image, catalogProductImage(item)) || DEFAULT_PRODUCT_IMAGE,
  storedImage: item.image || "",
  sku: item.sku || "",
  sourceType: item.sourceType || (item.sku ? "catalog" : "custom"),
  productGroupId: item.productGroupId || "",
  desc: item.desc || "",
  status: item.status,
  salesCount: item.salesCount || 0,
  sort: Number(item.sort || 9999),
  updatedAt: item.updatedAt,
});

const requireStoreManager = async () => {
  const userRes = await db.collection("users").where({ _openid: getOpenId() }).limit(1).get();
  const user = userRes.data[0];
  if (!user || ![SUPER_ADMIN_ROLE, OUTLET_ADMIN_ROLE].includes(user.role)) {
    throw new Error("无管理员权限");
  }
  const isSuperAdmin = user.role === SUPER_ADMIN_ROLE;
  const managedOutletId = text(user.managedOutletId, 64);
  if (!isSuperAdmin && !managedOutletId) {
    throw new Error("尚未分配代售点");
  }
  return { user, isSuperAdmin, managedOutletId };
};

const requireSuperAdmin = async () => {
  const manager = await requireStoreManager();
  if (!manager.isSuperAdmin) throw new Error("仅代售点总管理员可执行此操作");
  return manager;
};

const assertOutletAccess = (manager, outletId) => {
  if (!outletId) throw new Error("请选择代售点");
  if (!manager.isSuperAdmin && manager.managedOutletId !== outletId) {
    throw new Error("无权管理该代售点");
  }
};

const managementScope = (manager) => ({
  role: manager.isSuperAdmin ? SUPER_ADMIN_ROLE : OUTLET_ADMIN_ROLE,
  isSuperAdmin: manager.isSuperAdmin,
  managedOutletId: manager.managedOutletId || "",
});

const getOutlet = async (outletId) => {
  const result = await db.collection("outlets").doc(outletId).get();
  if (!result.data) throw new Error("代售点不存在");
  return result.data;
};

const getProduct = async (id) => {
  const result = await db.collection("store_products").doc(id).get();
  if (!result.data) throw new Error("商品不存在");
  return result.data;
};

const listOutlets = async (event) => {
  try {
    const res = await db.collection("outlets").where({
      schoolId: text(event.schoolId, 40) || DEFAULT_SCHOOL_ID,
      isActive: true,
    }).limit(100).get();
    const data = res.data.sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0)).map(publicOutlet);
    return ok({ data });
  } catch (error) {
    if (isCollectionMissing(error)) return ok({ data: [], setupRequired: true });
    throw error;
  }
};

const listProducts = async (event, adminMode = false) => {
  const outletId = text(event.outletId, 64);
  if (!outletId && !adminMode) return fail("请选择代售点");
  const where = {};
  if (outletId) where.outletId = outletId;
  if (!adminMode) where.status = "on_sale";
  if (event.category && PRODUCT_CATEGORIES.includes(event.category)) where.category = event.category;
  if (event.keyword) {
    const escaped = text(event.keyword, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    where.title = db.RegExp({ regexp: escaped, options: "i" });
  }

  try {
    const res = await db.collection("store_products").where(where).limit(100).get();
    const data = res.data.sort((a, b) => Number(a.sort || 9999) - Number(b.sort || 9999));
    return ok({ data: data.map(publicProduct) });
  } catch (error) {
    if (isCollectionMissing(error)) return ok({ data: [], setupRequired: true });
    throw error;
  }
};

const detailProduct = async (event) => {
  const id = text(event.id, 64);
  if (!id) return fail("缺少商品 ID");
  const res = await db.collection("store_products").doc(id).get();
  if (!res.data || res.data.status !== "on_sale") return fail("商品已下架");
  return ok({ data: publicProduct(res.data) });
};

const adminListOutlets = async () => {
  const manager = await requireStoreManager();
  try {
    if (!manager.isSuperAdmin) {
      const outlet = await getOutlet(manager.managedOutletId);
      if ((outlet.schoolId || DEFAULT_SCHOOL_ID) !== (manager.user.schoolId || DEFAULT_SCHOOL_ID)) {
        throw new Error("无权管理该代售点");
      }
      return ok({ data: [publicOutlet(outlet)], scope: managementScope(manager) });
    }
    const res = await db.collection("outlets").where({ schoolId: DEFAULT_SCHOOL_ID }).limit(100).get();
    const data = res.data.sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0)).map(publicOutlet);
    return ok({ data, scope: managementScope(manager) });
  } catch (error) {
    if (isCollectionMissing(error)) return ok({ data: [], setupRequired: true, scope: managementScope(manager) });
    throw error;
  }
};

const adminListProducts = async (event) => {
  const manager = await requireStoreManager();
  const requestedOutletId = text(event.outletId, 64);
  const outletId = manager.isSuperAdmin ? requestedOutletId : manager.managedOutletId;
  if (!manager.isSuperAdmin && requestedOutletId && requestedOutletId !== manager.managedOutletId) {
    throw new Error("无权管理该代售点");
  }
  if (manager.isSuperAdmin && !outletId) {
    return ok({ data: [], scope: managementScope(manager) });
  }
  assertOutletAccess(manager, outletId);
  const result = await listProducts({ ...event, outletId }, true);
  return { ...result, scope: managementScope(manager) };
};

const adminListCatalog = async () => {
  await requireSuperAdmin();
  const imageBySku = new Map();
  try {
    let offset = 0;
    while (offset < MAX_CATALOG_IMAGE_SCAN) {
      const result = await db.collection("store_products")
        .skip(offset)
        .limit(DATABASE_PAGE_SIZE)
        .get();
      result.data.forEach((item) => {
        const sku = text(item.sku, 20);
        const image = text(item.image, 500);
        if (sku && image && image !== DEFAULT_PRODUCT_IMAGE) {
          imageBySku.set(sku, preferredProductImage(imageBySku.get(sku), image));
        }
      });
      if (result.data.length < DATABASE_PAGE_SIZE) break;
      offset += DATABASE_PAGE_SIZE;
    }
  } catch (error) {
    if (!isCollectionMissing(error)) throw error;
  }
  return ok({
    data: PRODUCT_CATALOG.map((item) => ({
      ...item,
      image: preferredProductImage(imageBySku.get(item.sku), item.image) || DEFAULT_PRODUCT_IMAGE,
      hasDefaultImage: Boolean(preferredProductImage(imageBySku.get(item.sku), item.image)),
    })),
    categories: PRODUCT_CATEGORIES,
    defaultImage: DEFAULT_PRODUCT_IMAGE,
  });
};

const saveOutlet = async (event) => {
  await requireSuperAdmin();
  const inputBuildingName = text(event.buildingName, 30);
  const buildingMatch = inputBuildingName.match(/\d+/);
  const buildingNo = integer(event.buildingNo, 1, 16)
    || integer(buildingMatch && buildingMatch[0], 1, 16);
  const name = text(event.name, 30);
  const buildingName = buildingNo ? `${buildingNo}号楼` : inputBuildingName;
  const deliveryFeeFen = integer(event.deliveryFeeFen, 0, 100000);
  const minimumOrderFen = integer(event.minimumOrderFen, 0, 1000000);
  const sort = integer(event.sort || 0, 0, 9999);
  if (!buildingNo || !name || !buildingName) return fail("请选择1-16号宿舍楼并填写代售点名称");
  if (deliveryFeeFen === null || minimumOrderFen === null || sort === null) return fail("金额或排序不合法");
  const now = new Date();
  const data = {
    schoolId: DEFAULT_SCHOOL_ID,
    buildingNo,
    name,
    buildingName,
    notice: text(event.notice, 100),
    businessHours: text(event.businessHours, 40),
    deliveryFeeFen,
    minimumOrderFen,
    isActive: event.isActive !== false,
    sort,
    updatedAt: now,
  };
  const id = text(event.id, 64);
  if (id) {
    await db.collection("outlets").doc(id).update({ data });
    return ok({ id });
  }
  const res = await db.collection("outlets").add({ data: { ...data, createdAt: now } });
  return ok({ id: res._id });
};

const documentExists = async (collectionName, id) => {
  try {
    const result = await db.collection(collectionName).doc(id).get();
    return !!result.data;
  } catch (error) {
    if (isDocumentMissing(error)) return false;
    throw error;
  }
};

const normalizeOutletIds = (value) => {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => text(item, 64)).filter(Boolean))).slice(0, MAX_BATCH_OUTLETS + 1);
};

const loadBatchOutlets = async (outletIds, schoolId = DEFAULT_SCHOOL_ID) => {
  if (!outletIds.length) throw new Error("请至少选择一个适用代售点");
  if (outletIds.length > MAX_BATCH_OUTLETS) throw new Error(`一次最多选择${MAX_BATCH_OUTLETS}个代售点`);
  const outlets = await Promise.all(outletIds.map((id) => getOutlet(id)));
  const invalid = outlets.find((outlet) => (outlet.schoolId || DEFAULT_SCHOOL_ID) !== schoolId);
  if (invalid) throw new Error("包含无权管理的代售点");
  if (outlets.some((outlet) => integer(outlet.buildingNo, 1, 16) === null)) {
    throw new Error("所选代售点的楼栋配置不合法");
  }
  return outlets;
};

const getTransactionDocument = async (transaction, collectionName, id) => {
  try {
    const result = await transaction.collection(collectionName).doc(id).get();
    return result.data || null;
  } catch (error) {
    if (isDocumentMissing(error)) return null;
    throw error;
  }
};

const saveCatalogProductBatch = async (event) => {
  const manager = await requireSuperAdmin();
  const sku = text(event.sku, 20);
  const catalogItem = PRODUCT_CATALOG.find((item) => item.sku === sku);
  if (!catalogItem) return fail("请选择商品库中的商品");
  const outletIds = normalizeOutletIds(event.outletIds);
  const outlets = await loadBatchOutlets(outletIds, manager.user.schoolId || DEFAULT_SCHOOL_ID);
  const requestedPrice = event.priceFen === undefined || event.priceFen === null || event.priceFen === ""
    ? catalogItem.priceFen
    : integer(event.priceFen, 1, 10000000);
  const stock = integer(event.stock, 0, 99999);
  if (requestedPrice === null || stock === null) return fail("价格或库存不合法");
  const requestedImage = text(event.image, 500);
  const sameSkuRes = await db.collection("store_products").where({ sku: catalogItem.sku }).limit(100).get();
  const reusableImage = sameSkuRes.data.reduce(
    (selected, item) => preferredProductImage(selected, item.image),
    text(catalogItem.image, 500),
  );
  const now = new Date();

  const ids = outlets.map((outlet) => productDocId(outlet.buildingNo, catalogItem.sku));
  if (new Set(ids).size !== ids.length) return fail("所选代售点存在重复楼栋，无法批量上架");

  await db.runTransaction(async (transaction) => {
    for (let index = 0; index < outlets.length; index += 1) {
      const outlet = outlets[index];
      const id = ids[index];
      const existing = await getTransactionDocument(transaction, "store_products", id);
      if (existing && existing.outletId && existing.outletId !== outlet._id) {
        throw new Error("该楼栋已有其他代售点占用标准商品，请先检查代售点配置");
      }
      await transaction.collection("store_products").doc(id).set({
        data: {
          outletId: outlet._id,
          sku: catalogItem.sku,
          sourceType: "catalog",
          title: catalogItem.title,
          category: catalogItem.category,
          priceFen: requestedPrice,
          stock,
          image: preferredProductImage(
            requestedImage,
            existing && existing.image,
            reusableImage,
            catalogItem.image,
          ),
          desc: text(event.desc, 500),
          status: event.status === "off_shelf" ? "off_shelf" : "on_sale",
          salesCount: Number(existing && existing.salesCount || 0),
          sort: Number(catalogItem.sku),
          createdAt: existing && existing.createdAt || now,
          updatedAt: now,
          importSource: "2.0商品分类表_含进销利润.xlsx",
        },
      });
    }
  });
  return ok({ ids, createdCount: ids.length, sku: catalogItem.sku });
};

const customProductDocId = (groupId, outletId) => {
  const outletHash = crypto.createHash("sha256").update(outletId).digest("hex").slice(0, 12);
  return `c_${groupId}_${outletHash.slice(0, 8)}`;
};

const saveCustomProductBatch = async (event) => {
  const manager = await requireSuperAdmin();
  const outletIds = normalizeOutletIds(event.outletIds);
  const outlets = await loadBatchOutlets(outletIds, manager.user.schoolId || DEFAULT_SCHOOL_ID);
  const title = text(event.title, 60);
  const category = PRODUCT_CATEGORIES.includes(event.category) ? event.category : "";
  const priceFen = integer(event.priceFen, 1, 10000000);
  const stock = integer(event.stock, 0, 99999);
  if (!title || !category) return fail("请填写商品名称并选择分类");
  if (priceFen === null || stock === null) return fail("价格或库存不合法");
  const now = new Date();
  const groupId = `${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
  const ids = outlets.map((outlet) => customProductDocId(groupId, outlet._id));

  await db.runTransaction(async (transaction) => {
    for (let index = 0; index < outlets.length; index += 1) {
      await transaction.collection("store_products").doc(ids[index]).set({
        data: {
          outletId: outlets[index]._id,
          sku: "",
          sourceType: "custom",
          productGroupId: groupId,
          title,
          category,
          priceFen,
          stock,
          image: text(event.image, 500),
          desc: text(event.desc, 500),
          status: event.status === "off_shelf" ? "off_shelf" : "on_sale",
          salesCount: 0,
          sort: 9999,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  });
  return ok({ ids, createdCount: ids.length, productGroupId: groupId });
};

const bootstrapCatalog = async (event) => {
  const manager = await requireStoreManager();
  let buildingNo;
  let outletId;
  let createdOutlet = false;

  if (manager.isSuperAdmin) {
    buildingNo = integer(event.buildingNo, 1, 16);
    if (!buildingNo) return fail("楼栋必须为1-16号楼");
    const existingOutletRes = await db.collection("outlets").where({
      schoolId: DEFAULT_SCHOOL_ID,
      buildingNo,
    }).limit(1).get();
    outletId = existingOutletRes.data[0] && existingOutletRes.data[0]._id || outletDocId(buildingNo);
  } else {
    outletId = manager.managedOutletId;
    const outlet = await getOutlet(outletId);
    if ((outlet.schoolId || DEFAULT_SCHOOL_ID) !== (manager.user.schoolId || DEFAULT_SCHOOL_ID)) {
      throw new Error("无权管理该代售点");
    }
    buildingNo = integer(outlet.buildingNo, 1, 16);
    if (!buildingNo) throw new Error("代售点楼栋配置不合法");
  }
  assertOutletAccess(manager, outletId);

  const now = new Date();
  if (!await documentExists("outlets", outletId)) {
    if (!manager.isSuperAdmin) throw new Error("代售点不存在，请联系总管理员");
    await db.collection("outlets").doc(outletId).set({
      data: {
        schoolId: DEFAULT_SCHOOL_ID,
        buildingNo,
        buildingName: `${buildingNo}号楼`,
        name: `鹏宇优选${buildingNo}号楼代售点`,
        notice: "本楼商品送到宿舍门口",
        businessHours: "",
        deliveryFeeFen: 0,
        minimumOrderFen: 0,
        isActive: true,
        sort: buildingNo,
        createdAt: now,
        updatedAt: now,
        importSource: "2.0商品分类表_含进销利润.xlsx",
      },
    });
    createdOutlet = true;
  }

  const existingRes = await db.collection("store_products").where({ outletId }).limit(100).get();
  const existingIds = new Set(existingRes.data.map((item) => item._id));
  const missingProducts = PRODUCT_CATALOG.filter((item) => !existingIds.has(productDocId(buildingNo, item.sku)));
  await Promise.all(missingProducts.map((item) => db.collection("store_products")
    .doc(productDocId(buildingNo, item.sku))
    .set({
      data: {
        outletId,
        sku: item.sku,
        sourceType: "catalog",
        title: item.title,
        category: item.category,
        priceFen: item.priceFen,
        stock: 1,
        image: item.image || "",
        desc: "",
        status: "on_sale",
        salesCount: 0,
        sort: Number(item.sku),
        createdAt: now,
        updatedAt: now,
        importSource: "2.0商品分类表_含进销利润.xlsx",
      },
    })));
  const createdProducts = missingProducts.length;
  const skippedProducts = PRODUCT_CATALOG.length - createdProducts;

  return ok({
    buildingNo,
    outletId,
    createdOutlet,
    createdProducts,
    skippedProducts,
    catalogCount: PRODUCT_CATALOG.length,
  });
};

const saveProduct = async (event) => {
  await requireSuperAdmin();
  const id = text(event.id, 64);
  const existing = id ? await getProduct(id) : null;
  const outletId = existing ? existing.outletId : text(event.outletId, 64);
  const catalogItem = existing && existing.sku
    ? PRODUCT_CATALOG.find((item) => item.sku === existing.sku)
    : null;
  const title = catalogItem ? catalogItem.title : text(event.title, 60);
  const category = catalogItem
    ? catalogItem.category
    : (PRODUCT_CATEGORIES.includes(event.category) ? event.category : PRODUCT_CATEGORIES[0]);
  const priceFen = integer(event.priceFen, 1, 10000000);
  const stock = integer(event.stock, 0, 99999);
  if (!outletId || !title) return fail("请选择代售点并填写商品名称");
  if (priceFen === null || stock === null) return fail("价格或库存不合法");
  await db.collection("outlets").doc(outletId).get();
  const now = new Date();
  const data = {
    outletId,
    title,
    category,
    priceFen,
    stock,
    image: event.image === undefined && existing ? text(existing.image, 500) : text(event.image, 500),
    desc: text(event.desc, 500),
    status: event.status === "off_shelf" ? "off_shelf" : "on_sale",
    updatedAt: now,
  };
  if (id) {
    await db.collection("store_products").doc(id).update({ data });
    return ok({ id });
  }
  const res = await db.collection("store_products").add({
    data: { ...data, salesCount: 0, createdAt: now },
  });
  return ok({ id: res._id });
};

const loadProductGroupScope = async (manager, id) => {
  if (!id) throw new Error("缺少商品 ID");
  const product = await getProduct(id);
  const schoolId = manager.user.schoolId || DEFAULT_SCHOOL_ID;
  const sourceOutlet = await getOutlet(product.outletId);
  if ((sourceOutlet.schoolId || DEFAULT_SCHOOL_ID) !== schoolId) {
    throw new Error("无权管理该商品");
  }

  const outletRes = await db.collection("outlets").limit(100).get();
  const outletIds = outletRes.data
    .filter((outlet) => (outlet.schoolId || DEFAULT_SCHOOL_ID) === schoolId)
    .map((outlet) => outlet._id);
  if (!outletIds.length || outletIds.length > MAX_BATCH_OUTLETS) {
    throw new Error(`当前学校代售点数量异常，请确认不超过${MAX_BATCH_OUTLETS}个`);
  }

  const sku = text(product.sku, 20);
  const productGroupId = text(product.productGroupId, 64);
  let selector;
  let groupType;
  let groupKey;
  if (sku) {
    selector = { outletId: db.command.in(outletIds), sku };
    groupType = "catalog";
    groupKey = sku;
  } else if (productGroupId) {
    selector = { outletId: db.command.in(outletIds), productGroupId };
    groupType = "custom";
    groupKey = productGroupId;
  } else {
    throw new Error("该商品缺少统一标识，只能保存当前代售点");
  }

  const matchesRes = await db.collection("store_products").where(selector).limit(MAX_BATCH_OUTLETS + 1).get();
  const records = matchesRes.data || [];
  if (!records.length) throw new Error("未找到可统一更新的商品记录");
  if (records.length > MAX_BATCH_OUTLETS) {
    throw new Error("匹配记录超过安全上限，请先检查重复数据");
  }
  return { product, selector, records, groupType, groupKey };
};

const previewProductGroupImageUpdate = async (event) => {
  const manager = await requireSuperAdmin();
  const id = text(event.id, 64);
  const scope = await loadProductGroupScope(manager, id);
  return ok({
    id,
    title: scope.product.title,
    groupType: scope.groupType,
    groupKey: scope.groupKey,
    affectedCount: scope.records.length,
  });
};

const updateProductGroupImage = async (event) => {
  const manager = await requireSuperAdmin();
  const id = text(event.id, 64);
  const image = text(event.image, 500);
  const expectedCount = integer(event.expectedCount, 1, MAX_BATCH_OUTLETS);
  if (!image.startsWith("cloud://")) return fail("请先选择并上传新的商品图片");
  if (expectedCount === null) return fail("请先确认统一更新范围");

  const scope = await loadProductGroupScope(manager, id);
  if (scope.records.length !== expectedCount) {
    return fail("商品组数量已变化，请重新确认后再操作");
  }
  const result = await db.collection("store_products").where(scope.selector).update({
    data: { image, updatedAt: new Date() },
  });
  const updatedCount = Number(result && result.stats && result.stats.updated || 0);
  if (updatedCount !== expectedCount) {
    throw new Error("部分商品图片未更新，请刷新后重试");
  }
  return ok({ id, updatedCount, affectedCount: expectedCount });
};

const updateProductStatus = async (event) => {
  const manager = await requireStoreManager();
  const id = text(event.id, 64);
  if (!id) return fail("缺少商品 ID");
  if (!["on_sale", "off_shelf"].includes(event.status)) return fail("商品状态不合法");
  const status = event.status;
  const product = await getProduct(id);
  assertOutletAccess(manager, product.outletId);
  await db.collection("store_products").doc(id).update({ data: { status, updatedAt: new Date() } });
  return ok({ id, status, outletId: product.outletId });
};

const updateProductStock = async (event) => {
  const manager = await requireStoreManager();
  const id = text(event.id, 64);
  const stock = integer(event.stock, 0, 99999);
  if (!id) return fail("缺少商品 ID");
  if (stock === null) return fail("库存数量不合法");
  const product = await getProduct(id);
  assertOutletAccess(manager, product.outletId);
  await db.collection("store_products").doc(id).update({ data: { stock, updatedAt: new Date() } });
  return ok({ id, stock, outletId: product.outletId });
};

exports.main = async (event = {}) => {
  try {
    switch (event.type) {
      case "listOutlets":
        return await listOutlets(event);
      case "listProducts":
        return await listProducts(event);
      case "detailProduct":
        return await detailProduct(event);
      case "adminListOutlets":
        return await adminListOutlets();
      case "adminListProducts":
        return await adminListProducts(event);
      case "adminListCatalog":
        return await adminListCatalog();
      case "saveOutlet":
        return await saveOutlet(event);
      case "saveProduct":
        return await saveProduct(event);
      case "saveCatalogProductBatch":
        return await saveCatalogProductBatch(event);
      case "saveCustomProductBatch":
        return await saveCustomProductBatch(event);
      case "previewProductGroupImageUpdate":
        return await previewProductGroupImageUpdate(event);
      case "updateProductGroupImage":
        return await updateProductGroupImage(event);
      case "updateProductStatus":
        return await updateProductStatus(event);
      case "updateProductStock":
        return await updateProductStock(event);
      case "bootstrapCatalog":
        return await bootstrapCatalog(event);
      default:
        return fail("未知操作");
    }
  } catch (error) {
    return fail(error.message || "代售点服务异常");
  }
};
