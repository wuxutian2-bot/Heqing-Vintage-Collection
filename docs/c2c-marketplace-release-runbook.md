# C2C 闲置市场：测试与上线操作手册

本文用于将“平台代结算”C2C 闲置交易部署到**测试环境**并完成两账号联调。请先完整看完，再开始操作；尤其不要把 `payoutEnabled` 打开。

## 1. 这次到底上线什么

一件个人闲置对应一笔交易订单，流程为：

```text
商品在售
  → 买家创建订单（商品锁定 15 分钟）
  → 买家微信付款
  → 支付服务端回调确认
  → 卖家确认当面交付
  → 买家确认收货
  → 生成卖方待结算账本记录
```

付款后，买卖双方任一方都可发起争议；争议会冻结结算。退款成功后，商品保持“等待实物退回”的交易状态，不会自动重新上架。

本次**没有**上线“自动向卖家微信零钱转账”。`payoutEnabled` 即使被误设为 `true`，代码仍会拒绝操作，不会伪造“已转账”。本次的可交付终点是：卖家获得一条可人工对账的待结算记录。

## 2. 开始前确认（5 分钟）

1. 在微信开发者工具打开本项目，并将 `your-cloud-env-id` 替换为你自己的云环境 ID。
2. 确认本地完整回归已通过：`241 pass / 0 fail`。不要只上传前端页面。
3. 准备两个**不同**的测试账号：账号 A 作为卖家，账号 B 作为买家。不能用同一个账号买自己的商品。
4. 本次先用测试环境，不要改线上集合里的 `checkoutEnabled`。
5. 当前小程序若仍显示“由于小程序违规，支付功能暂时无法使用”，先保留该问题记录。代码可以继续部署和验证“创建订单/锁定商品”，但不能把“真实付款成功”勾为已验收。

## 3. 部署云函数（按此顺序）

在微信开发者工具左侧的 `cloudfunctions` 目录中操作。每个函数均选择“上传并部署：云端安装依赖”。

1. 部署 `c2c-market`。
   - 作用：创建订单、锁定商品、交付确认、买家确认、争议冻结、待结算账本。
2. 部署 `pengyu-pay-fj7pei2f-demo-scfweb`。
   - 作用：微信付款、关单和退款的服务端状态回调。
   - 这一步不能遗漏；不部署它，付款成功后商品不会从“锁定”推进到“交易中”。
3. 部署后分别在云函数列表确认状态为“部署成功”，日志中没有 `Cannot find module` 或环境错误。
4. 最后重新编译小程序前端，并上传一个**开发版**。不要先提交审核或发布正式版。

> 付款函数已有商户配置时，不要把商户号、证书、APIv3 密钥复制到小程序代码或数据库配置文档中；它们只能留在支付云函数受控环境变量中。

## 4. 创建数据库集合和权限

打开云开发控制台 → 数据库。依次创建下面 7 个集合：

| 集合 | 用途 | 是否允许客户端读写 |
| --- | --- | --- |
| `market_c2c_orders` | C2C 订单与状态机 | 否 |
| `market_c2c_ledger` | 卖方待结算账本 | 否 |
| `market_c2c_idempotency` | 防止重复下单/重复确认 | 否 |
| `market_c2c_disputes` | 争议记录 | 否 |
| `market_c2c_payouts` | 未来转账记录预留 | 否 |
| `market_c2c_config` | 功能开关和服务费规则 | 否 |
| `market_c2c_audit` | 关键动作审计 | 否 |

数据库权限应保持“仅云函数可读写”。项目提供的 [database-private-rule.json](../deployment/database-private-rule.json) 是全库 `read: false`、`write: false` 的参考。用户只能通过云函数查看自己的脱敏订单，不能直接改状态、金额、卖家或账本。

## 5. 创建索引

打开云开发控制台 → 数据库 → 对应集合 → 索引，手动创建以下索引。`recommended-indexes.json` 是清单参考；控制台是否支持导入因界面版本而异，所以请以这个表为准逐条核对。

| 集合 | 字段顺序 | 唯一 |
| --- | --- | --- |
| `market_c2c_orders` | `outTradeNo` | 是 |
| `market_c2c_orders` | `buyerUserId`, `createdAt` | 否 |
| `market_c2c_orders` | `sellerUserId`, `createdAt` | 否 |
| `market_c2c_orders` | `status`, `expiresAt` | 否 |
| `market_c2c_ledger` | `orderId` | 是 |
| `market_c2c_ledger` | `sellerUserId`, `createdAt` | 否 |
| `market_c2c_disputes` | `orderId` | 是 |
| `market_c2c_disputes` | `status`, `createdAt` | 否 |
| `market_c2c_payouts` | `orderId` | 是 |
| `market_c2c_payouts` | `sellerUserId`, `status`, `createdAt` | 否 |
| `market_c2c_idempotency` | `actorUserId`, `action`, `createdAt` | 否 |

索引全部创建完成后再进行付款测试，尤其是三个唯一索引不能省略：订单商户单号、账本订单号、争议订单号。

## 6. 建立测试环境开关

在 `market_c2c_config` 集合新建一条文档，文档 ID 必须是 `settlement`。先使用下面的安全初始值：

```json
{
  "checkoutEnabled": false,
  "payoutEnabled": false,
  "feeRuleVersion": "fee-disabled-v1",
  "feeRateBps": 0,
  "minFeeFen": 0,
  "maxFeeFen": 0
}
```

这份模板也在 [c2c-settlement-config.example.json](../deployment/c2c-settlement-config.example.json)。

先编译小程序并进入一件个人闲置详情：此时应该看到“担保购买暂不可用”，且没有私信或站外联系入口。这一步证明开关关闭时不会绕过平台交易。

确认支付云函数、商户号、AppID、支付回调地址和订单发货管理均已在测试环境核验后，才把同一文档改为：

```json
{
  "checkoutEnabled": true,
  "payoutEnabled": false,
  "feeRuleVersion": "fee-disabled-v1",
  "feeRateBps": 0,
  "minFeeFen": 0,
  "maxFeeFen": 0
}
```

重新进入商品详情后，非卖家应看到“担保购买”。`payoutEnabled` 必须始终为 `false`。

## 7. 两账号完整主流程验收

### 7.1 卖家账号 A：发布商品

1. 使用账号 A 登录，进入“市场” → “发布闲置”。
2. 发布一件带图片、价格大于 0 的普通商品；不要选“求购”。
3. 记住商品标题，确认其状态为“在售”。

### 7.2 买家账号 B：创建并付款

1. 使用账号 B 登录，打开该商品详情。
2. 确认页面显示“平台担保交易流程”和“担保购买”。
3. 点击“担保购买”，应跳转到“交易详情”；此时数据库中：
   - `market_c2c_orders` 新增 1 条订单，`status = pending_payment`；
   - `goods` 内该商品变为 `status = locked`，且 `c2cOrderId` 等于订单 ID；
   - 其他买家再次点击同一商品时应被提示商品不可用。
4. 点击“微信支付”。付款页弹出后完成测试付款。
5. 返回订单页并刷新；只有支付云函数收到并处理成功回调后，订单才会变为 `paid`，商品变为 `trading`。单纯看到支付页返回不能当作付款成功。

若真机仍出现支付违规提示：停止在此处，记录截图、订单号、时间和支付函数日志；不要人工把订单改成 `paid`，也不要把测试结果标为通过。

### 7.3 卖家账号 A：确认当面交付

1. 使用账号 A 进入“我的” → “担保交易”。
2. 打开对应订单，在状态为“等待卖家交付”时点击“确认交付”。
3. 订单应变为 `seller_delivered`，买家账号 B 应看到“请确认收货”。

### 7.4 买家账号 B：确认收货

1. 使用账号 B 打开对应订单，确认实物无误后点击“确认收货”。
2. 订单应变为 `settlement_available`，`settlementStatus = available`。
3. 数据库 `market_c2c_ledger` 应新增一条记录：
   - `_id` 为 `settlement_订单ID`；
   - `type = seller_settlement_available`；
   - `amountFen` 等于订单的 `sellerAmountFen`；
   - `immutable = true`。
4. 商品状态应为 `sold`；卖家无法再通过“标记已售”或“删除”绕过已完成交易。

### 7.5 卖家结算按钮

卖家可在交易详情看到“申请结算”，但点击后会提示结算通道尚未开放。这是预期行为：本次通过账本实现人工对账，不会自动把钱转给卖家。

## 8. 必测异常流程

| 场景 | 操作 | 预期结果 |
| --- | --- | --- |
| 未付款取消 | 创建订单但未调起付款，点击取消 | 订单变 `cancelled`，商品回到 `on_sale` |
| 支付中取消 | 已调起付款后取消/关闭支付页 | 先核对微信支付单；不能直接释放商品 |
| 订单超时 | 等待超过 15 分钟后让定时器执行 | 未发起付款的订单变 `expired`，商品回到 `on_sale` |
| 商品重复购买 | 买家 B 创建订单后，账号 C 再购买 | 账号 C 被拒绝，商品只能锁给一人 |
| 买家确认前争议 | 付款成功后任一方点击“争议” | 订单变 `disputed`，`settlementStatus = frozen` |
| 退款成功 | 由管理员经支付后台发起整单退款并等待回调 | 商品为 `trading/refunded_pending_return`，绝不自动重新上架 |

定时器需等待 5 分钟周期；如控制台支持直接调用云函数，可调用 `c2c-market` 并传入 `{"type":"expirePendingOrders","limit":50}`，只用于测试环境。

## 9. 上线前放行标准

以下每项均为“是”才可以考虑将测试环境的 `checkoutEnabled` 同步到生产：

- [ ] 两个不同账号的主流程已完整通过。
- [ ] 真机付款成功、服务端回调到单、刷新订单状态均通过。
- [ ] 未付款取消、支付中取消、商品锁定、争议、退款回调至少各测一次。
- [ ] 数据库中不存在客户端可直接改写 C2C 集合的权限。
- [ ] `payoutEnabled` 仍是 `false`。
- [ ] 支付云函数、`c2c-market`、小程序前端来自同一版代码。
- [ ] 微信支付限制已解除；支付云函数日志和订单发货管理无异常。

## 10. 失败时如何止损与回滚

1. 发现支付异常、状态不一致或商品无法恢复时，立即把生产 `market_c2c_config/settlement.checkoutEnabled` 改为 `false`。这会停止创建和支付新的 C2C 订单。
2. 不要删除 `market_c2c_orders`、`market_c2c_ledger`、`market_c2c_disputes` 或支付日志；它们是排查和对账依据。
3. 已付款订单不要手动改为取消或已完成。保留订单号，通过微信支付查单/退款和服务端日志处理。
4. 记录订单 ID、`outTradeNo`、付款微信单号（如有）、时间、买卖双方账号编号和错误截图，再排查支付回调日志。

## 11. 真实自动结算不属于本次上线

后续若要把待结算款自动转入卖家微信零钱，需单独完成商户业务场景、个人收款授权、商户资金充值、商家转账回调、风控、账务对账和人工异常处理的验收，再开发转账适配器。在此之前，运营只应以 `market_c2c_ledger` 的 `seller_settlement_available` 记录做人工对账。
