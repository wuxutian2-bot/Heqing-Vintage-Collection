const STORAGE_KEY = "pengyuStoreCart";

const normalizeCart = (value) => {
  if (!value || typeof value !== "object") return { outletId: "", items: [] };
  const items = Array.isArray(value.items)
    ? value.items.filter((item) => item && item.productId && Number(item.quantity) > 0)
    : [];
  return { outletId: String(value.outletId || ""), items };
};

const getCart = () => normalizeCart(wx.getStorageSync(STORAGE_KEY));

const saveCart = (cart) => {
  const normalized = normalizeCart(cart);
  if (!normalized.items.length) {
    wx.removeStorageSync(STORAGE_KEY);
    return { outletId: "", items: [] };
  }
  wx.setStorageSync(STORAGE_KEY, normalized);
  return normalized;
};

const addItem = (product, replaceOutlet = false) => {
  const cart = getCart();
  if (cart.items.length && cart.outletId !== product.outletId && !replaceOutlet) {
    return { conflict: true, cart };
  }
  const next = cart.outletId === product.outletId && !replaceOutlet
    ? cart
    : { outletId: product.outletId, items: [] };
  const index = next.items.findIndex((item) => item.productId === product._id);
  if (index >= 0) {
    const current = next.items[index];
    next.items[index] = {
      ...current,
      stock: Number(product.stock || current.stock || 0),
      quantity: Math.min(Number(current.quantity || 0) + 1, Number(product.stock || 0)),
    };
  } else {
    next.items.push({
      productId: product._id,
      outletId: product.outletId,
      title: product.title,
      image: product.image,
      priceFen: Number(product.priceFen || 0),
      stock: Number(product.stock || 0),
      quantity: 1,
    });
  }
  return { conflict: false, cart: saveCart(next) };
};

const updateQuantity = (productId, quantity) => {
  const cart = getCart();
  const item = cart.items.find((entry) => entry.productId === productId);
  if (!item) return cart;
  const nextQuantity = Math.max(0, Math.min(Number(quantity || 0), Number(item.stock || 0), 99));
  item.quantity = nextQuantity;
  cart.items = cart.items.filter((entry) => entry.quantity > 0);
  return saveCart(cart);
};

const removeItem = (productId) => {
  const cart = getCart();
  cart.items = cart.items.filter((item) => item.productId !== productId);
  return saveCart(cart);
};

const clearCart = () => {
  wx.removeStorageSync(STORAGE_KEY);
  return { outletId: "", items: [] };
};

const getCount = () => getCart().items.reduce((sum, item) => sum + Number(item.quantity || 0), 0);

module.exports = {
  addItem,
  clearCart,
  getCart,
  getCount,
  removeItem,
  updateQuantity,
};
