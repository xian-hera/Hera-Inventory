# 任务说明：清理 main_sku/bundle 变通方案 + 升级 Shopify API + 适配多 barcode

## 背景

这是 Hera Beauté 内部另一个 Shopify 相关 App，和 Hera Inventory 是不同的代码库。它目前也用了
和 Hera Inventory 之前一样的变通方案来处理"一个商品有多个历史条码"的问题：

- 保留一个"主"barcode，对应"主" SKU；
- 其余的历史条码，各自建成独立的 **bundle 产品**；
- 每个 bundle 产品上有一个 `custom.main_sku`（或类似命名，需要在这个代码库里确认实际的
  namespace/key）metafield，值是主 SKU；
- App 查询/扫码流程里，查到某个 variant 后，如果它所属的 product 有这个 main_sku metafield，
  就会重定向去查 main_sku 对应的那个 variant，实际操作（改库存、改价格等等）都发生在主 SKU 上。

这套方案是因为 Shopify **以前不支持一个 variant 挂多个 barcode**才需要的变通。Shopify 已经在
**2026-09-08** 上线了原生多 barcode 支持（一个 variant 最多可挂 20 个 barcode），所以这套
bundle + metafield 的变通方案不再需要，应该清理掉，改成依赖 Shopify 原生的多 barcode 能力。

Hera Inventory（另一个仓库）已经完成了同样的清理和升级，可以作为参考，但**不要直接照抄代码**——
这是不同的代码库，字段命名、metafield namespace/key、涉及的接口都可能不一样，需要重新在这个
代码库里定位一遍。

## 需要确认的前提（先问 Hera，不要自己假设）

1. 这个 App 里，SKU 是否也是"永远等于 barcode，或者 barcode 中的一个"？
2. 实际需求是不是也是"同一个商品有几个历史遗留条码，扫哪个/查哪个都应该识别成同一个 SKU"？
   还是这个 App 里 barcode 有别的用途（比如不同渠道用不同条码、需要分别记录）？

这两点在 Hera Inventory 那边已经确认过一次，但两个 App 的业务场景不一定完全一样，务必重新问
一遍，不要直接套用之前的结论。

## 任务清单

### 1. 定位并清理 main_sku / bundle 重定向逻辑

- 在这个代码库的后端（以及前端，如果前端也有类似逻辑）里，全局搜索 metafield 相关的关键词
  （具体 namespace/key 需要先确认，可能不是 `custom.main_sku`，先搜 `main_sku`、`mainSku`、
  `bundle`、`redirect` 之类的关键词定位）。
- 找到所有"查到 variant 后，检查 product 是否有这个 metafield，有就重定向查另一个 SKU"的代码
  位置，逐一记录文件路径和大致逻辑（不要边找边改，先列清单）。
- 确认这些 metafield 和对应的 bundle 产品是否已经在 Shopify 后台清空/不再使用（如果 Hera
  确认这批 bundle 产品已经/将要下架，这些重定向分支就是安全可删的死代码；如果还有 bundle
  产品在用，不能直接删，需要先跟 Hera 确认清理计划和时间点）。
- 删除前先跟 Hera 说明要删的是什么（这段逻辑的用途），拿到确认后再动手，删除时代码里留一句
  注释说明这段逻辑曾经的作用和被删除的原因，方便以后查历史。

### 2. 升级 Shopify Admin API 版本

- 找到这个代码库初始化 Shopify SDK 的地方（类似 Hera Inventory 里 `server/shopify.js` 的
  `apiVersion` 配置），确认当前写死的版本号。
- 查一下 Shopify 当前最新稳定版本号是什么（发布时间是每年 1/4/7/10 月，按当前日期推算最近的
  一个季度版本，或者直接查 `https://shopify.dev/docs/api/admin-graphql/latest` 页面标注的
  版本号）。
- 确认这个代码库用的 Shopify Node SDK（`@shopify/shopify-api` 或其他）版本，检查它对
  `apiVersion` 这个配置项是不是纯字符串透传、还是会做校验限制只能填枚举里已知的版本——如果
  是纯字符串透传（Hera Inventory 那边是这样，但不能假设这个 App 也一样，需要重新查一遍这个
  库的源码或文档），改版本号不需要连带升级 SDK 包；如果有校验，需要先升级 SDK 包本身。
- 查 Shopify 官方 changelog / release notes，确认从当前版本升级到目标版本之间，有没有影响到
  这个 App 实际用到的 query/mutation 的破坏性变更。重点检查这几类（Hera Inventory 那边踩到的
  坑，这个 App 大概率也会用到）：
  - `InventoryItem.inventoryLevels`（复数，connection）和 `InventoryItem.inventoryLevel`
    （单数，按 locationId 查单条）这两个字段，2026-04 版本新增了 `includeInactive` 参数，
    **默认 `false`**——也就是说升级后，如果某个 location 对某个商品停用过库存追踪，查询会
    静默不返回这条记录。这个 App 里所有用到这两个字段的地方，都要检查一遍，需要的话统一加上
    `includeInactive: true`，保证升级前后行为一致。
  - 其他破坏性变更看这个 App 实际用没用到：Checkout metafields 迁移、`DraftOrderLineItem.grams`
    移除、Discount API 重构（2026-07）、Metaobject 部分枚举移除、Shopify Scripts 停用
    （2026-06-30 停止执行）——如果代码库没有 draft order/discount/metaobject/scripts 相关
    功能，这几项可以跳过，但要先确认"没用到"而不是直接假设。
  - metafield JSON 大小上限从 2MB 降到 128KB——只影响新创建的 App，老 App 按 Shopify 说法
    保留原有额度，一般不用特别处理，但如果这个 App 有大量写 JSON metafield 的地方，最好确认
    一下。

### 3. 确认并验证多 barcode 搜索行为

- 用 Shopify GraphiQL App（在目标商店后台的 Apps 里找），先确认界面上选的 API 版本是刚升级
  到的那个版本（不是默认值，很多时候默认停在旧版本）。
- 找 Hera 要一个真实的、有多个 barcode 的商品样品（在 Shopify 后台 variant 编辑页能看到
  "Barcodes"这一栏，点开会显示所有条码）。
- 用类似下面这样的查询，把样品的每个 barcode 各查一次，确认是否都命中同一个 variant：

  ```graphql
  query TestMultiBarcodeMatch {
    byBarcode1: productVariants(first: 5, query: "barcode:第一个barcode") {
      edges { node { id sku barcode product { id title status } } }
    }
    byBarcode2: productVariants(first: 5, query: "barcode:第二个barcode") {
      edges { node { id sku barcode product { id title status } } }
    }
    # ...每个 barcode 各加一个 alias
  }
  ```

- 如果所有 barcode 都命中同一个 variant id，说明这个代码库里所有"按 barcode/SKU 查 variant"
  的地方，理论上已经能自动支持"扫哪个条码都认成同一个 SKU"，不需要另外写代码维护映射关系。
  这个结论同样需要拿这个 App 实际连的商店重新测一遍，不能直接套用 Hera Inventory 那次的测试
  结果（不同商店、不同数据）。
- 如果测出来不是这样（比如只匹配主 barcode），需要重新评估方案，可能要退回到"读取 variant 的
  完整 barcode 列表"这条路——但注意 Shopify 目前（2026-09）完整的多 barcode 读取字段
  （`barcodes` connection）还只在 `unstable` schema 里，稳定版 API 读不到，这一点需要用当前
  最新的 `latest`/目标版本文档重新确认一遍，因为这个功能刚上线不久，进展可能很快。

### 4. 收尾

- 所有改动之前，找 Hera 确认这个代码库是不是也用 git 管理，方便改完之后 `git diff` review、
  必要时回退。
- 分批做，读操作（查询、搜索）优先，涉及写库存/改价格/改 cost 的 mutation 相关代码放最后改，
  改完建议用非关键的测试数据走一遍完整流程再上生产。
- 完成后，建议把这次的排查结果和改动记录写一份类似的总结文档，方便以后回溯（可以参考 Hera
  Hub 项目里 `claude/OLD_SKU_INCIDENT_FIX.md` 的格式）。
