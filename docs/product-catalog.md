# 共用產品資料規格

日常維護只使用既有產品資訊原始 Excel，不要求新增 `產品主檔` 或 `下單品號箱規`。把原始檔丟到 Supply 或 FBA 後，兩站會讀取 `AMZ 所有SKU`、`2026`、`罐頭`，將可公開的產品箱規保存在同一個瀏覽器的 `jspusa:shared-product-catalog:v1`，並共同套用到各自的內建備援。

下列 ProductMasterTable／OrderSkuPackagingTable 是內建版本發布與資料遷移的 canonical schema，不是 Jasper 平常要維護的 Excel 工作表。Canonical JSON、Supply 的 `product-data.js` 與 FBA snapshot 仍不得手動修改。

## 內建備援：ProductMasterTable

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

## 內建備援：OrderSkuPackagingTable

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

## 日常維護流程

1. 照原本方式更新產品資訊原始 Excel；不要新增額外工作表。
2. 在 Supply「資料」頁把它和 JAM／H10／JSP 一起丟入，或到 FBA「備用：更新產品資訊資料庫」單獨上傳。
3. 系統會自動辨識三張工作表、保存第一筆完整的重複 SKU，並顯示讀取 SKU 數量與衝突數。
4. 重新整理、切換 Supply／FBA 後仍會使用同一份資料；按「恢復內建備援」才會移除。

原始 Excel 不會上傳至 GitHub 或伺服器。瀏覽器共用資料只含 SKU、產地、箱入數、紙箱尺寸、箱／棧板、箱毛重、來源工作表與來源列；缺值不會清掉內建完整值。

## 內建備援發布流程

需要把新資料固化成所有瀏覽器的預設值時，才執行 canonical 匯入、old → new 差異檢查、`npm run catalog:build`、FBA 投影、兩站測試與 Pages 發布。平常上傳原始檔不需要走這套開發流程。

兩個網站在 runtime 都使用各自已驗證的本地 snapshot，不會互相 fetch，因此其中一站暫時無法連線不會拖垮另一站。更新失敗時保留上一個已發布版本。
