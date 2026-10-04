# 市场回收与平台销售云函数

该云函数实现“平台真实收购二手物品，再由平台销售”的业务状态机。它与旧的个人信息发布分开记账。当前代码会创建商家转账领取意图，但**不会调用微信商家转账接口，也不会把任何记录写成已到账**。

所有调用返回以下格式：

```json
{ "success": true, "data": {} }
```

失败时返回：

```json
{ "success": false, "errMsg": "可展示的错误", "errorCode": "ERROR_CODE" }
```

## 上线前准备

部署函数名建议固定为 `market`，运行时使用 Node.js 18 或以上。需创建以下云数据库集合，并将小程序端直接读写权限设为拒绝；所有业务读写只经过本云函数或受信任的支付服务：

- `market_recovery_orders`
- `market_inventory`
- `market_sale_orders`
- `market_claims`
- `market_finance_entries`
- `market_idempotency`
- `market_audit_logs`

建议索引：

| 集合 | 索引字段 |
| --- | --- |
| `market_recovery_orders` | `ownerUserId + createdAt`、`status + createdAt`；`sourceGoodsId` 唯一 |
| `market_inventory` | `status + createdAt`；`sourceGoodsId` 唯一；`recoveryOrderId` 唯一 |
| `market_sale_orders` | `buyerUserId + createdAt`、`status + expiresAt + stockReleased`；`outTradeNo` 唯一 |
| `market_claims` | `ownerUserId + createdAt`、`status + createdAt`；`recoveryOrderId` 唯一；`outBillNo` 唯一 |
| `market_finance_entries` | `businessType + businessId + createdAt` |
| `market_idempotency` | `actorUserId + action + requestId` |
| `market_audit_logs` | `actorUserId + createdAt`、`targetType + targetId + createdAt` |

函数配置包含每 5 分钟执行一次的 `expire-market-sale-orders` 定时器。定时器只释放**从未发起微信预支付**的超时订单；已有 `paymentRequestedAt` 或 `paymentStatus != 'unpaid'` 的订单会进入 `payment_exception` 并保持库存锁定，等待支付服务查单。

## 身份、金额与幂等规则

- 用户身份只读取 `cloud.getWXContext().OPENID`，再精确匹配 `users._openid`；不接受客户端提交 openid、用户 ID 或角色。
- 管理接口只允许 `users.role === 'admin'`。`outlet_admin` 没有市场定价、收购或财务权限。
- 所有金额均为整数分。报价、库存价格、销售订单价格和领取金额都由服务端持久化后再读取。
- 所有变更接口要求 `requestId`，格式为 8–64 位字母、数字、下划线或短横线。同一用户、操作和 `requestId` 只能绑定同一份输入。
- 管理员修改回收状态时必须提交当前 `expectedVersion`，旧页面不能覆盖新状态。
- 当前费用规则关闭，`feeAmountFen` 只能是 `0`；配置正式费率、用户确认文案和版本规则前不能收费。
- 领取为“一张已完成收购单，全额领取一次”，金额至少 10 分且严格小于 200000 分，不允许自动拆单。

## API 列表

调用方式：

```js
wx.cloud.callFunction({
  name: "market",
  data: { type: "recoverySubmit", goodsId, requestId }
})
```

snake_case 名称也提供兼容映射；新页面应统一使用下表的 canonical `type`。

| `type` | 权限 | 主要输入 | 作用 |
| --- | --- | --- | --- |
| `recoverySubmit` | 登录用户 | `goodsId, requestId` | 快照本人的在售商品并提交回收；拒绝求购、平台商品和重复申请 |
| `recoveryList` | 登录用户 | `status?, page?, pageSize?` | 本人的回收单 |
| `recoveryGet` | 本人 | `recoveryId` | 本人的回收详情 |
| `adminRecoveryList` | 管理员 | `status?, page?, pageSize?` | 回收工作台列表 |
| `adminRecoveryGet` | 管理员 | `recoveryId` | 管理回收详情 |
| `adminQuote` | 管理员 | `recoveryId, grossAmountFen, feeAmountFen:0, platformSalePriceFen, quoteExpiresAt?, remark?, expectedVersion, requestId` | 新建报价版本 |
| `quoteAccept` | 本人 | `recoveryId, quoteVersion, requestId` | 接受仍有效的准确报价版本 |
| `adminInspect` | 管理员 | `recoveryId, result, note?, condition?, evidenceImages?, expectedVersion, requestId` | `result` 为 `passed/reprice/rejected`；改价时还需提交完整报价字段 |
| `adminConfirmAcquisition` | 管理员 | `recoveryId, quoteVersion, expectedVersion, requestId` | 同一事务确认应付款、生成唯一库存并将原 `goods` 标为平台持有 |
| `catalogList` | 可公开读 | `category?, keyword?, page?, pageSize?` | 只返回 `market_inventory.status='on_sale'` 的公开字段 |
| `catalogGet` | 可公开读 | `inventoryId` 或 `goodsId` | 平台库存商品详情 |
| `saleCreate` | 登录用户 | `inventoryId` 或 `goodsId, note?, requestId` | 按服务端售价锁定唯一库存并创建 15 分钟订单 |
| `saleList` | 登录用户 | `status?, page?, pageSize?` | 本人的市场购物订单 |
| `saleGet` | 本人 | `orderId` | 本人的市场订单详情 |
| `saleCancel` | 本人 | `orderId, requestId` | 仅取消从未创建微信预支付单的待支付订单 |
| `salePreparePayment` | 本人 | `orderId` | 返回受信任的 `outTradeNo/description/totalAmountFen`，不调用微信 |
| `claimCreate` | 本人 | `recoveryId, requestId` | 从已确认应付款创建领取意图；拒绝客户端金额、openid、场景和转账单号 |
| `claimList` | 登录用户 | `status?, page?, pageSize?` | 本人的领取列表 |
| `claimGet` | 本人 | `claimId` | 本人的领取状态；仅待用户确认时返回 `packageInfo` |
| `adminSaleList` | 管理员 | `status?, page?, pageSize?` | 市场销售订单列表 |
| `adminClaimList` | 管理员 | `status?, page?, pageSize?` | 领取状态列表，不返回 openid 和商户转账单号 |
| `adminInventoryList` | 管理员 | `status?, page?, pageSize?` | 平台库存列表 |
| `adminStock` / `admin_market_stock` | 管理员 | `inventoryId, status:on_sale\|off_sale, expectedVersion, requestId` | 在同一事务中上下架库存并同步平台商品；锁定或已售库存禁止修改 |
| `expirePendingSales` | 管理员 | 无 | 手动执行安全的超时扫描 |

## 状态流程

回收单：

```text
submitted -> quoted -> quote_accepted -> inspected -> acquisition_completed
                         |                  |
                         +-- reprice ------> quoted
                         +-- rejected ------> closed
```

平台库存：

```text
off_sale <-> on_sale -> locked -> sold
             |
             +-- 从未发起支付且取消/超时 -> on_sale
             +-- 已发起支付但结果未知 -> 保持 locked
```

领取单由本函数创建为 `reserved / NOT_STARTED`。后续受信任的支付 HTTP 服务可以更新：

```text
reserved -> dispatching -> wait_user_confirm -> accepted/processing -> success
                         -> fail/canceling/cancelled/needs_review
```

小程序端的 `wx.requestMerchantTransfer` success 只表示确认收款页面交互完成，不能直接把领取单更新为 `success`。到账只能由验签后的微信通知或服务端查单确认。

## 领取意图的内部字段

支付 HTTP 服务必须只接收 `claimId`，直接读取 `market_claims`。不得让调用方覆盖下列字段：

| 字段 | 约束 |
| --- | --- |
| `_id` | 固定领取单 ID |
| `recoveryOrderId` | 已完成收购且属于收款人的回收单 |
| `ownerUserId` | 内部用户 ID |
| `ownerOpenId` | 从可信登录身份及回收单继承 |
| `transferAmountFen` | 从已接受报价的净回收款继承，整数分 |
| `outBillNo` | 固定 32 位以内字母数字；重试和查单始终复用 |
| `sceneId` | 固定为字符串 `1010` |
| `goodsTitleSnapshot` | 1–32 字符的回收商品名快照 |
| `transferRemark` | 固定为“二手回收货款” |
| `transferSceneReportInfos` | 恰好一项：`回收商品名称` + 商品名快照 |
| `status` | 初始 `reserved`，代表已预留但未发起转账 |
| `channelStatus` | 初始 `NOT_STARTED` |

`claimList/claimGet/adminClaimList` 的响应不会返回 `ownerOpenId` 或 `outBillNo`。只有本人调用 `claimGet` 且记录处于 `wait_user_confirm` 时，才返回支付服务保存的 `packageInfo`。

## 与微信支付服务的边界

市场销售支付服务只应接收市场 `orderId`，从 `market_sale_orders` 读取 `buyerOpenId`、`outTradeNo`、`description` 和 `totalAmountFen`。调用微信前，必须先在数据库事务中写入 `paymentRequestedAt` 并把 `paymentStatus` 置为 `preparing`，以关闭自动释放库存的窗口；不能等拿到预支付单后才写。回调必须按 `outTradeNo` 精确绑定订单和金额；取消或过期后的付款进入 `payment_exception` 并安排查单或退款，不能把库存直接重新上架。

商家转账服务只应接收 `claimId`。发送前必须在事务中取得执行权，并从领取意图构造 1010 请求；网络超时或未知结果必须按同一 `outBillNo` 查单，不得换号重付。真实转账还需要固定出口 IP、商户私钥签名、微信平台证书/公钥验签、APIv3 通知验签解密和正式额度配置，这些均不在本云函数中启用。

## 现有 `goods` 的联调要求

确认收购后，原商品按页面兼容要求写入：

```js
{
  status: "on_sale",
  platformOwned: true,
  inventoryId,
  recoveryOrderId,
  platformSalePriceFen
}
```

现有 `goods.list` 必须按 `platformOwned` 分流，避免同一物品同时作为“个人闲置”和“平台库存”重复展示。平台付款按钮只能读取 `platformOwned === true` 的商品，并通过 `catalogGet` 核验仍为 `on_sale` 的唯一库存后创建市场订单。平台商品禁止通过 `goods.updateStatus/delete` 修改；上下架必须调用 `adminStock`，由市场事务同步 `market_inventory` 与 `goods`。
