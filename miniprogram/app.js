// app.js
App({
  onLaunch: function () {
    this.globalData = {
      productName: "鹏宇优选",
      schoolId: "default-school",
      // 在云开发集成中心创建「小程序微信支付」后，填写自动生成的 HTTP 云函数名。
      // 未配置时支付按钮会给出明确提示，不会创建金额不可控的支付单。
      paymentFunctionName: "pengyu-pay-fj7pei2f-demo-scfweb",
      // 仅在已将 payment-integration 中的金额校验与回调钩子部署到支付函数后改为 true。
      paymentBusinessHookReady: true,
      // env 参数说明：
      // env 参数决定接下来小程序发起的云开发调用（wx.cloud.xxx）会请求到哪个云环境的资源
      // 此处请填入环境 ID, 环境 ID 可在微信开发者工具右上顶部工具栏点击云开发按钮打开获取
      env: "your-cloud-env-id",
    };
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true,
      });
    }
  },
});
