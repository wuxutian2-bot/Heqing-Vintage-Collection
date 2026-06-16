const showError = (error, fallback) => {
  const message = error && (error.errMsg || error.message || error);
  wx.showToast({
    title: String(message || fallback || "操作失败").slice(0, 20),
    icon: "none",
  });
};

const callCloud = async (name, data = {}, options = {}) => {
  if (options.loadingText) {
    wx.showLoading({
      title: options.loadingText,
      mask: true,
    });
  }

  try {
    const res = await wx.cloud.callFunction({ name, data });
    const result = res.result || {};
    if (result.success === false) {
      throw new Error(result.errMsg || "操作失败");
    }
    return result;
  } catch (error) {
    if (!options.silent) {
      showError(error, options.errorText);
    }
    throw error;
  } finally {
    if (options.loadingText) {
      wx.hideLoading();
    }
  }
};

const requireLogin = () => {
  const user = wx.getStorageSync("user");
  if (!user || !user._openid) {
    wx.navigateTo({
      url: "/pages/login/index",
    });
    return null;
  }
  return user;
};

const formatTime = (value) => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${month}-${day} ${hour}:${minute}`;
};

const normalizeGoods = (item) => ({
  ...item,
  priceText: Number(item.price || 0).toFixed(2),
  images: Array.isArray(item.images) ? item.images : [],
  cover: item.images && item.images.length ? item.images[0] : "/images/default-goods-image.png",
  statusText: { on_sale: "在售", sold: "已售出", removed: "已下架" }[item.status] || "在售",
  createdText: formatTime(item.createdAt),
});

const normalizePost = (item) => ({
  ...item,
  images: Array.isArray(item.images) ? item.images : [],
  createdText: formatTime(item.createdAt),
  cover: item.images && item.images.length ? item.images[0] : "",
});

module.exports = {
  callCloud,
  formatTime,
  normalizeGoods,
  normalizePost,
  requireLogin,
  showError,
};
