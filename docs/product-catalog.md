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
| 生效日期／失效日期 | 包裝版本的歷史時間證據；不再用日期自動替換既有工作的指派 |
| 新訂單預設包裝版本 | 每個 Product SKU 明確指定一個已存在的版本；只供新工作與未碰過的建議使用 |
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
| 包裝版本／日期／新訂單預設 | 與 Product SKU 相同；每個 Alias 明確指定一個已存在的預設版本 |
| 箱入數／包裝模式／箱規／箱重 | FBA 依實際 Order SKU 出貨包裝讀取 |
| 箱／棧板 | 可留白，但該 Alias 只保留身分與歷史，不會供 Supply 新訂單使用 |
| 資料來源／備註／發布檢查 | 證據、未映射狀態與公式檢查 |

## 不變條件

- Product SKU、Order SKU 儲存前一律去除前後空白並轉成大寫。
- Product SKU 不得以 `7` 開頭；7 字頭必須建模為 Order SKU Alias。
- 一個 Order SKU 只能屬於一個 Product SKU。
- Product SKU 本身是 Standard Order 可用的 Order SKU；核准替代品號不得建立第二份產品需求。
- 非 7 字頭 Order SKU 依標準下單廠別歸入台灣或越南；7 字頭一律歸入委外。
- 實際產地未知時保留為 `null`，不得由標準下單廠別推測。
- 同一 Product SKU 的包裝版本名稱不得重複，且 `newOrderPackagingDefaultVersion` 必須明確指向其中一版。
- 同一 Order SKU Alias 的包裝版本名稱不得重複，且 `newOrderPackagingDefaultVersion` 必須明確指向其中一版。
- 已發布或已指派的包裝版本不可原地改寫；修正會建立新版本，日期欄只保留歷史證據，不會自動改派既有工作。
- `approved` alias 的 owner 必須存在且明列該 Order SKU；`unmapped-legacy` alias 的 owner 必須是 `null`。
- 正常產品必須有真實品名、標準下單廠別、真實包裝模式與完整 Supply 包裝資料。Raw Excel 沒有品名與包裝模式時，新 SKU 保留空品名與 `orderUnit: null`，不得用 SKU 或「單品 1」假裝成商業事實。資料待補產品可先供具備足夠欄位的 FBA adapter 使用，但不會自動進入 Supply 訂單清單。
- Alias owner 身分與包裝完整度分開。明確清空 Alias 的箱入數、箱規、棧板數或 FBA 必要箱重時，仍保留 owner 與不可變歷史，但不可產生新工作；舊指派仍可依舊版本讀取。
- 原始 Excel 的同一 SKU 若有多筆完整資料，只有欄位內容一致時才能合併；只要任一公開欄位互相衝突，發布計畫就會列出每個工作表、列號與競爭值並阻止套用，不得用第一列或最後一列猜值。Canonical 內的重複版本識別、已發布歷史遭改寫或 alias owner 衝突同樣會阻止生成；schema v2 仍禁止日期區間重疊，schema v3 則保留不可變歷史並由 `newOrderPackagingDefaultVersion` 明確指定新工作版本，因此歷史日期區間可重疊。

## 公開邊界

公開 catalog 只允許 Product SKU、品名、產地、標準下單廠別、核准 Order SKU、包裝版本、箱規、箱重、棧板數與生命週期。成本、報價、供應商、聯絡方式、庫存、銷速、open orders、Order Draft、憑證與原始 Excel 檔不得進入 GitHub Pages artifact。

## Jasper 的維護方式

1. 照原本方式更新產品資訊原始 Excel；不要新增額外工作表。
2. 產品資料真的有變更時，在 Supply 或 FBA 頁首按「更新產品資料」，直接選擇最新 raw Excel。網站只在目前分頁的記憶體解析，不寫入 localStorage、sessionStorage 或 IndexedDB；重新整理後原始檔、計畫與勾選狀態都會消失。
3. 畫面自動辨識三張工作表、保存已確認的 7 字頭 owner，並產生 signed Catalog Change Plan。安全項目預選、高風險項目等待明確勾選；同一 SKU 若有兩筆完整但互相衝突的資料，會列出工作表、列號與競爭值並阻擋套用，不以列的先後順序猜測。
4. Excel 普通空白永遠保留 canonical 既有值。只有在「明確清空空白欄位」逐一勾選的 Product SKU／Order SKU Alias 欄位，才會重建 signed plan 並列為未預選的高風險變更。
5. 審核後下載 signed plan 與 compact selection handoff，再交給本機發布流程；網頁本身沒有 GitHub token、repository 寫入或發布能力。
6. Supply 與 FBA 測試、發布完成後，所有瀏覽器直接取得新的內建資料。

原始 Excel 不會進入 GitHub Pages artifact。公開內建 catalog 只含允許發布的產品與包裝欄位；缺值不會清掉 canonical 既有完整值。

## 內建資料發布流程

1. 建議先在 Supply 或 FBA 的「更新產品資料」直接選擇 raw Excel；兩站使用由 Supply 產生、byte-identical 的本地 planner 與 public-sanitized baseline，不會在 runtime 向另一站抓取完整 catalog。也可用 `npm run catalog:release -- --input <raw.xlsx> --fba-repo ../FBA --report <plan.json>` 產生同一契約的計畫。
2. Catalog Change Plan 會列出每個 Product SKU／Order SKU Alias 的 old → new 、原始列與影響。安全變更預先勾選；廠別、生命週期、alias owner、明確清空等高風險變更不會預選；來源衝突無法勾選且阻擋整次發布。
3. 審核完成後，使用畫面下載的 signed plan 執行 `npm run catalog:release -- --input <raw.xlsx> --fba-repo ../FBA --apply --reviewed-plan <plan.json> --selection-handoff <selection.json> --verify`。本機工具會直接沿用 reviewed plan 的候選版本；Handoff 代表精確選取，因此不可與 `--select` 混用。純 CLI 審核仍可對每筆高風險條目加入 `--select <entry-id>`。
4. 不論從哪個網站審核，工具都會重新讀取同一份原始 Excel、核對 exact signed plan、public-sanitized baseline/candidate SHA-256、來源衝突證據與 handoff 的 `planSha256`／選取 ID；完整 canonical 仍另外接受 immutable history 與 schema 驗證。網站只在記憶體接觸原始 Excel，不保存檔案或 GitHub 權限，也不能直接發布。
5. 套用後會一次生成 Supply canonical/snapshot、兩站相同且不含 `packaging.source` 的 Catalog Update baseline/planner 投影、FBA snapshot/HTML，以及兩站各自的 compact `catalog-alignment.json`，完成兩站本機驗證，並保留不含原始 Excel、本機路徑或來源列的 Catalog Change Record。沒有公開欄位變更時不建立空版本。
6. `release-supply-fba-product-catalog` Skill 在使用者明確要求「發布／上線」時，接著建立兩個 PR、等候兩邊檢查、合併、等候 Pages，再驗證兩個公開站點的 `catalogVersion` 與各自實際內容 hash。兩站都通過本機、CI、部署、live hash 與 live browser 五段證據後，Catalog Alignment 才會標記完成。

## Catalog Alignment 失敗續跑

- 網站只讀取雙方的 compact `catalog-alignment.json`；不會下載或覆蓋對方完整產品資料。兩站版本或預期內容 hash 尚未一致時，狀態會持續顯示紅色。
- 任一站失敗會阻止開始下一個 catalog 版本，但不會回滾另一個已成功的站。先用 `npm run alignment:evidence -- --recover --site <supply|fba>` 重設該站從第一個失敗階段以後的證據，再只重跑失敗站。
- 每段結果使用 `npm run alignment:evidence -- --site <supply|fba> --stage <local|repositoryCi|deployment|liveHash|liveBrowser> --outcome <passed|failed>` 記錄。CI、部署與 live 階段需帶 `--revision <commit>`；live hash 通過時另帶 `--catalog-version <version> --public-content-hash <sha256>`。
- 每次更新會同步寫入該版本紀錄與 `latest.json`。既有證據不可覆寫；失敗證據必須先執行 recovery，避免把舊失敗直接改成成功。

兩個網站在 runtime 都使用各自已驗證的本地 snapshot，不會互相 fetch，因此其中一站暫時無法連線不會拖垮另一站。更新失敗時保留上一個已發布版本。

網站仍保留「Temporary Product Override」供發布前用原始檔做臨時測試。它不是日常流程，也不會改寫內建 catalog；當 Built-in Product Catalog 版本更新時，較舊的瀏覽器覆蓋會自動失效。
