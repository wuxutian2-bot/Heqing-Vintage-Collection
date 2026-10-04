# 鹏宇优选微信支付接入

本目录只保存业务安全钩子，不保存商户号、APIv3 密钥、私钥或证书。

本目录 `orderService.js` 与 `cloudfunctions/pengyu-pay-fj7pei2f-demo-scfweb/services/orderService.js` 保持一致。已接入的项目应更新当前支付云函数，不能用旧版模板覆盖回缺少可信调用者校验、退款意图或退款终态保护的版本。这套钩子服务代售点订单，尚不具备校园市场钱包与提现能力。

用户于 2026-09-05 选择按平台真实回收后销售的路线申请商家转账 1010；当前不把分账作为该方案的必开产品。配置准备、回收/销售订单与应付回收款的实施计划见 [二手回收转账接入](../docs/plans/2026-09-05-recovery-transfer-integration.md)。转账基础参数校验修正不代表业务钩子、正式权限或真实提现已经完成，不能直接解除转账服务的关闭保护。

## 必做配置

1. 在云开发控制台的集成中心创建“小程序微信支付”，取得自动生成的 HTTP 云函数名。
2. 下载或打开该函数源码，将本目录 `orderService.js` 放到生成函数的 `services/orderService.js`，并完成以下控制器和服务调用链适配。不能只替换这一个文件就启用付款。
3. 给生成函数安装 `wx-server-sdk` 依赖，沿用当前项目已经验证的版本与锁文件；完成适配和测试后再部署。
4. 在生成函数 `services/payService.js` 的 `unifiedOrder(params, payType = 'jsapi')` 中，进入 `try` 后、调用任何微信支付接口前加入：

   ```js
   params = await this.orderService.beforeUnified(params);
   ```

   这一行不能省略。它会从 `orders` 集合读取真实订单，核对付款人和金额，并用服务端金额覆盖请求参数。

   控制器必须从验证过的登录态/可信云开发网关获取 OpenID，并覆盖写入内部字段 `_callerOpenId`。不得接受请求 body 自报的 `_callerOpenId`、角色或付款人作为鉴权依据。部署接入参考当前函数的 `controllers/payController.js` 和配套鉴权中间件。

   查单、关单、退款和管理员查询分别在渠道调用前执行 `beforeQuery`、`beforeClose`、`beforeRefund`、`beforeAdminQuery`。`beforeRefund` 会在事务中先保存退款意图和固定退款单号，再允许调用渠道；退款请求重试须使用原单号和原金额。完整调用顺序参考当前函数的 `services/payService.js`。商家转账继续显式关闭。
5. 将集成中心给出的支付回调 URL 配置到微信支付商户平台。回调业务钩子会进行订单号、金额、付款人和状态的幂等校验。
6. 检查生成函数的回调处理：支付和退款分别 `await handlerUnifiedTrigger`、`await handlerRefundTrigger`，并且只有验签/可信网关验证及数据库业务钩子成功后才返回成功。钩子失败时应返回失败以便重试；本项目没有持久化异步回调队列，不能异步触发钩子后立即确认成功。
7. 在 `miniprogram/app.js` 填写 `paymentFunctionName`，完成真机 1 分钱支付和回调验证后，将 `paymentBusinessHookReady` 改为 `true`。

## 验收

- 修改前端金额后，下单必须被支付函数拒绝。
- 重放同一支付回调，不得重复增加销量或重复改状态。
- 前端取消支付，业务订单仍为待支付；超过 15 分钟后库存释放。
- 支付成功但回调延迟时，前端只显示“确认中”；最终状态由回调改为 `paid`。
- 已取消或已释放库存的订单如果意外收到成功回调，订单进入 `payment_exception` 并标记 `needsRefund`，不得自动配送。
- 已退款或退款中的订单收到原支付重复回调，不得回退到已支付或待退款异常状态。
- 退款成功回调先于申请响应到达，后到响应不得将 `refunded` 改回 `refunding`；错误退款单号、非整单退款金额必须拒绝自动记为整单已退款。
- 退款请求超时保留已记录的退款意图，使用原单号查单和重试，不能换单重退。当前自动查单补偿尚未完成；确定失败/异常单由管理员在渠道核对，不直接恢复为可履约状态。
- 在商户平台直接发起、且本地没有对应退款意图的退款，不能由回调自动匹配入账；需要管理员核验商户退款单号、金额和状态后对账处理。正式更新前检查历史在途退款，避免漏处理。

本地验证：

```powershell
node --test tests/*.test.js cloudfunctions/pengyu-pay-fj7pei2f-demo-scfweb/tests/*.test.js
```

校园市场新交易流程与支付产品适配审查见 [市场交易与提现审查](../docs/plans/2026-09-04-market-payment-settlement-review.md)。

官方接入依据：<https://docs.cloudbase.net/integration/wechat-pay-miniprogram>
