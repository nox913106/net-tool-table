Tool Table 單機版（Windows，免安裝）
================================================

【開始使用】
1. 把整個 ToolTable 資料夾解壓縮到任何地方（桌面、D 槽、隨身碟都可以）
2. 點兩下 ToolTable.exe
3. 瀏覽器會自動打開入口頁；管理後台在網址後面加 /admin

  * 那個黑色視窗就是伺服器本身，關掉它就會停止服務。
  * 第一次執行時 Windows 可能顯示「Windows 已保護您的電腦」：
    按「其他資訊」→「仍要執行」即可（程式沒有數位簽章才會出現）。

【資料存在哪裡】
  ToolTable\data\tool-table.db   所有資料夾、連結、設定
  ToolTable\data\icons\          圖示（含後台上傳的）

  整個 ToolTable 資料夾複製到別台電腦，資料就跟著過去。
  備份：複製 data 資料夾，或在後台「備份與匯入」下載 JSON。
  （如果放在無法寫入的位置，例如 Program Files，資料會改存到
    %LOCALAPPDATA%\ToolTable）

【加入電腦上的程式】
  把程式拖進入口頁面就能新增，之後點卡片即可啟動：
    * 桌面或開始功能表的捷徑（.lnk）─ 最方便，會帶入參數與圖示
    * 執行檔（.exe）─ 會在 Program Files 等常見位置自動找出它；
      找不到時，請在檔案總管對它按 Shift + 右鍵 →「複製為路徑」貼上
    * 網址捷徑（.url）─ 變成一般網址卡片，並自動抓網站圖示
  也可以在管理後台的「網址或程式路徑」直接貼上 C:\... 路徑（文件、資料夾也行）。

  只有執行 ToolTable.exe 的這台電腦能新增、啟動程式；
  用 --lan 開放給其他電腦時，他們看得到卡片但無法啟動。

【升級】
  下載新版 zip，解壓後把舊版的 data 資料夾複製過去覆蓋即可。

【進階：從命令列啟動】
  ToolTable.exe --port 9000        改用其他埠（預設 8080，被占用會自動換）
  ToolTable.exe --lan              讓同網段其他電腦也能連線
                                   （Windows 防火牆會詢問，請按「允許」）
  ToolTable.exe --no-browser       不自動開瀏覽器
  ToolTable.exe --data-dir D:\tt   資料改存到指定資料夾

  已經在執行時再點一次 ToolTable.exe，只會再打開瀏覽器，不會重複啟動。

【注意】
  單機版預設只有這台電腦連得到。使用 --lan 時後台沒有登入保護，
  同網段的人都能修改內容，請只在信任的網路使用。
  要給多人長期使用，建議改用 Linux 正式部署（HTTPS、每日備份）：
  https://github.com/nox913106/net-tool-table/blob/main/docs/INSTALL.md
