const showError = (error, fallback) => {
  const rawMessage = String((error && (error.errMsg || error.message || error)) || fallback || "操作失败");
  let message = rawMessage;
  if (rawMessage.includes("FunctionName parameter could not be found")) {
    message = "云函数未部署";
  } else if (rawMessage.includes("collection not exists")) {
    message = "数据库集合未创建";
  } else if (rawMessage.includes("Environment not found") || rawMessage.includes("Env Not Exists")) {
    message = "云环境ID错误";
  } else if (rawMessage.includes("cloud.callFunction:fail")) {
    message = "云函数调用失败";
  }
  wx.showToast({
    title: message.slice(0, 20),
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
      const businessError = new Error(result.errMsg || "操作失败");
      businessError.code = result.errCode || "BUSINESS_ERROR";
      throw businessError;
    }
    return result;
  } catch (error) {
    console.error(`[cloud:${name}]`, data, error);
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
  if (!user || (!user._id && !user._openid)) {
    wx.navigateTo({
      url: "/pages/login/index",
    });
    return null;
  }
  return user;
};

const formatPrice = (valueFen) => (Number(valueFen || 0) / 100).toFixed(2);

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
  statusText: {
    on_sale: "在售",
    locked: "交易锁定中",
    trading: "交易进行中",
    sold: "已售出",
    removed: "已下架",
  }[item.status] || "在售",
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
  formatPrice,
  formatTime,
  normalizeGoods,
  normalizePost,
  requireLogin,
  showError,
};
