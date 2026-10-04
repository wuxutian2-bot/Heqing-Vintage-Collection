# C2C 闲置市场结算域

此云函数实现一件商品一笔、校内当面交付的受控 C2C 流程：商品锁定 → 买家付款 → 卖家确认交付 → 买家确认收货 → 卖方生成待结算记录。付款与退款的最终状态只能由 `pengyu-pay-fj7pei2f-demo-scfweb` 的已验签回调写入。

默认配置是关闭的。请在 `market_c2c_config` 集合创建 `_id: settlement` 文档后，才可在**测试环境**验证付款流程：

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

`payoutEnabled` 即使误设为 `true`，当前代码也会因未配置经核验的转账适配器而拒绝请求；不会把订单伪造为“转账中”。上线真钱结算前，必须完成商户业务场景、个人收款授权、支付/退款回调和账务对账的联合验收。
