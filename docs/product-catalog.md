# 共用產品主檔規格

Supply 與 FBA 使用同一份 Excel 的 `產品主檔` 與 `下單品號箱規` 工作表作為唯一人工維護來源。Canonical JSON、Supply 的 `product-data.js` 與 FBA 的 snapshot 都是生成檔，不得手動修改。

## ProductMasterTable

表頭固定在第 5 列；每一列代表一個 Product SKU 的一個包裝版本。

| 欄位 | 用途 |
| --- | --- |
| Product SKU | 擁有需求、庫存、產品規格與 coverage 的品號 |
| 品名 | Supply 顯示名稱 |
| 實際產地 | 台灣、越南、柬埔寨、其他或待補 |
| 標準下單廠別 | 台灣、越南、其他或待補；與實際產地分開 |
| 核准替代下單品號 | 以分號分隔；7 字頭會歸入委外 |
| 包裝版本 | Product SKU 內唯一的版本名稱 |
| 生效日期／失效日期 | 包裝有效期間；現行版本的失效日期留白 |
| 現行版本 | 是或否；每個 Product SKU 必須恰有一筆「是」 |
| 包裝模式 | 單品、包裝或盒裝 |
| 箱入數／每包單位數／每盒單位數 | Supply 與 FBA 的數量換算來源 |
| 箱／棧板 | Supply 訂單與棧板計算來源 |
| 箱長／箱寬／箱高 | 公分 |
| 箱毛重 | 公斤與磅可同時保存 |
| 產品狀態 | 正常、資料待補或停產 |
| 資料來源工作表／來源列 | 初次轉換與衝突稽核證據 |
| 備註／發布檢查 | 維護說明與公式檢查結果；只有 `⚠` 會阻止發布，未知產地與資料待補會誠實標示但不假造資料 |

## OrderSkuPackagingTable

`下單品號箱規` 表頭同樣固定在第 5 列；每列代表一個 7 字頭 Order SKU Alias 的一個包裝版本。箱入數、尺寸與重量只有在 Order SKU 層級真實不同時才放這裡；不會複製需求、庫存或 coverage。

| 欄位 | 用途 |
| --- | --- |
| Order SKU | 必須是唯一、正規化的 7 字頭品號 |
| 對應 Product SKU | `核准` 時必填且必須在產品主檔的核准清單；`未映射舊品號` 必須留白 |
| Alias 狀態 | `核准` 或 `未映射舊品號` |
| 包裝版本／日期／現行版本 | 與 Product SKU 相同的版本規則，必須恰有一筆現行版本 |
| 箱入數／包裝模式／箱規／箱重 | FBA 依實際 Order SKU 出貨包裝讀取 |
| 箱／棧板 | 可留白；Supply 棧板建議仍使用 Product SKU 現行包裝 |
| 資料來源／備註／發布檢查 | 證據、未映射狀態與公式檢查 |

## 不變條件

- Product SKU、Order SKU 儲存前一律去除前後空白並轉成大寫。
- Product SKU 不得以 `7` 開頭；7 字頭必須建模為 Order SKU Alias。
- 一個 Order SKU 只能屬於一個 Product SKU。
- Product SKU 本身是 Standard Order 可用的 Order SKU；核准替代品號不得建立第二份產品需求。
- 非 7 字頭 Order SKU 依標準下單廠別歸入台灣或越南；7 字頭一律歸入委外。
- 實際產地未知時保留為 `null`，不得由標準下單廠別推測。
- 同一 Product SKU 的包裝有效期間不得重疊，且必須恰有一個現行版本。
- 同一 Order SKU Alias 的包裝有效期間不得重疊，且必須恰有一個現行版本。
- `approved` alias 的 owner 必須存在且明列該 Order SKU；`unmapped-legacy` alias 的 owner 必須是 `null`。
- 正常產品必須有品名、標準下單廠別與完整 Supply 包裝資料；資料待補產品可先供具備足夠欄位的 FBA adapter 使用，但不會自動進入 Supply 訂單清單。
- 任一重複、欄位不完整、版本重疊或 alias 衝突都會阻止生成；不得 first-row-wins、last-row-wins 或猜值。

## 公開邊界

公開 catalog 只允許 Product SKU、品名、產地、標準下單廠別、核准 Order SKU、包裝版本、箱規、箱重、棧板數與生命週期。成本、報價、供應商、聯絡方式、庫存、銷速、open orders、Order Draft、憑證與原始 Excel 檔不得進入 GitHub Pages artifact。

## 發布流程

1. 在 Excel 的 `ProductMasterTable` 維護產品包裝，並在 `OrderSkuPackagingTable` 維護 7 字頭專屬箱規；新增資料列時使用 Excel 表格列，發布檢查會以動態表格範圍計算。
2. 執行 `npm run catalog:import -- --input <xlsx> --output catalog/product-catalog.json`。
3. 確認兩張表的發布檢查都沒有 `⚠`，再檢查 old → new 差異與 catalog 測試；`可發布 · 產地待補` 與 `資料待補（僅 FBA）` 是允許發布的誠實狀態。
4. 執行 `npm run catalog:build` 生成 Supply 的同步 legacy adapter。
5. 在 FBA 專案執行 `npm run generate:catalog -- --source ../Supply/catalog/product-catalog.json`。
6. 兩站各自完成測試、build、Pages 部署與 live catalogVersion/hash 驗證後，才可宣稱同步發布完成。

兩個網站在 runtime 都使用各自已驗證的本地 snapshot，不會互相 fetch，因此其中一站暫時無法連線不會拖垮另一站。更新失敗時保留上一個已發布版本。
