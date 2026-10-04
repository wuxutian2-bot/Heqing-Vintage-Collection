const FEATURE_DISABLED = Object.freeze({
  success: false,
  errMsg: "私信功能已关闭",
  errorCode: "FEATURE_DISABLED",
});

// 保留同名云函数只为覆盖已部署的旧版本，防止旧版小程序继续创建或读取私信。
exports.main = async () => ({ ...FEATURE_DISABLED });
