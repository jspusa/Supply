# 共用產品資料規格

日常使用直接讀取 Supply 與 FBA 各自內建的產品資料，不需要上傳產品資訊 Excel。Jasper 只維護既有產品資訊原始 Excel，不要求新增 `產品主檔` 或 `下單品號箱規`；發布工具直接讀取 `AMZ 所有SKU`、`2026`、`罐頭`，更新 canonical catalog，再生成兩站的內建版本。

下列 ProductMasterTable／OrderSkuPackagingTable 是發布內部與資料遷移的 canonical schema，不是 Jasper 平常要維護的 Excel 工作表。Canonical JSON、Supply 的 `product-data.js` 與 FBA snapshot 仍不得手動修改。

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
- 原始 Excel 的重複 SKU 保留第一筆完整資料；較晚的完整衝突列會列入報告但不覆蓋。Canonical 內的重複、版本重疊或 alias owner 衝突則會阻止生成，不得猜值。

## 公開邊界

公開 catalog 只允許 Product SKU、品名、產地、標準下單廠別、核准 Order SKU、包裝版本、箱規、箱重、棧板數與生命週期。成本、報價、供應商、聯絡方式、庫存、銷速、open orders、Order Draft、憑證與原始 Excel 檔不得進入 GitHub Pages artifact。

## Jasper 的維護方式

1. 照原本方式更新產品資訊原始 Excel；不要新增額外工作表。
2. 產品資料真的有變更時，將最新 raw Excel 交給發布流程；平常開啟網站不需上傳它。
3. 發布工具自動辨識三張工作表、保留第一筆完整的重複 SKU、保存已確認的 7 字頭 owner，並產生新 catalog 版本。
4. Supply 與 FBA 測試、發布完成後，所有瀏覽器直接取得新的內建資料。

原始 Excel 不會進入 GitHub Pages artifact。公開內建 catalog 只含允許發布的產品與包裝欄位；缺值不會清掉 canonical 既有完整值。

## 內建資料發布流程

1. 先執行不寫檔的發布計畫：`npm run catalog:release -- --input <raw.xlsx> --fba-repo ../FBA --report <report.json>`。版本未指定時，會以台北日期接續目前版本號。
2. 計畫會列出每個 Product SKU／Order SKU Alias 的 old → new 箱入數、箱／棧板、紙箱尺寸（in）、箱重（lb）、生命週期與 owner。沒有公開欄位變更時不建立空版本。
3. 確認沒有移除、alias owner 變更、資料倒退或其他阻擋項目後，執行同一命令並加入 `--apply --verify`；它會一次生成 Supply canonical/snapshot 與 FBA snapshot/HTML，並完成兩站本機驗證。
4. `release-supply-fba-product-catalog` Skill 在使用者明確要求「發布／上線」時，接著建立兩個 PR、等候兩邊檢查、合併、等候 Pages，再驗證兩個公開站點的相同 `catalogVersion` 與實際內容。

兩個網站在 runtime 都使用各自已驗證的本地 snapshot，不會互相 fetch，因此其中一站暫時無法連線不會拖垮另一站。更新失敗時保留上一個已發布版本。

網站仍保留「Temporary Product Override」供發布前用原始檔做臨時測試。它不是日常流程，也不會改寫內建 catalog；當 Built-in Product Catalog 版本更新時，較舊的瀏覽器覆蓋會自動失效。
