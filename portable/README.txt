IPMS 用戶端（Windows）
================================================

【開始使用】
  安裝版：執行 IPMS-Setup.exe（不需要系統管理員權限），之後從開始功能表或桌面捷徑開啟。
  免安裝版：
1. 把整個 ToolTable 資料夾解壓縮到任何地方（桌面、D 槽、隨身碟都可以）
2. 點兩下 IPMS.cmd
3. 入口頁會用 Chrome（沒有就用 Edge）以「獨立視窗」打開，像一般程式一樣，
   沒有網址列和分頁；管理後台是 http://127.0.0.1:8080/admin

  * 沒有黑色主控台視窗；關掉 IPMS 的視窗，程式約 5 秒後自動結束。
    執行紀錄寫在 data\ipms.log；要看即時紀錄可用「IPMS.cmd --console」啟動。
  * 程式以 python.org 官方、有數位簽章的 pythonw.exe／python.exe 執行（python\ 資料夾），
    程式碼在 app\ 資料夾；套件裡沒有自製的 exe，不會被防毒誤判刪除。

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

  只有執行 IPMS.cmd 的這台電腦能新增、啟動程式；
  用 --lan 開放給其他電腦時，他們看得到卡片但無法啟動。

【安裝成 App（開始功能表 / 工作列 / 桌面圖示）】
  在 Chrome 或 Edge 開啟入口頁，按頁首右上角的「下載」圖示（安裝為應用程式），
  或網址列右邊的「安裝」圖示 → 安裝。之後就能從開始功能表開啟、釘選到工作列。
  注意：App 只是視窗，資料仍由 IPMS.cmd 提供，使用前要先執行 IPMS.cmd。
  （小技巧：把 IPMS.cmd 的捷徑放進「啟動」資料夾 shell:startup，開機就自動執行，
    搭配 --no-browser 就不會每次開機都跳出視窗）

【升級】
  安裝版：直接執行新版 IPMS-Setup.exe（資料保留）。
  免安裝版：下載新版 zip，解壓後把舊版的 data 資料夾複製過去覆蓋即可。
  改名前的版本（Tool Table）：啟動檔從 ToolTable.cmd 改名為 IPMS.cmd，資料夾名稱不變；
    自己建立的捷徑請改指向 IPMS.cmd。安裝版會自動換成新的「IPMS」捷徑。
  從舊版（ToolTable.exe）升級：把舊資料夾的 data 複製到新版的 ToolTable 資料夾
  （安裝版是 %LOCALAPPDATA%\Programs\ToolTable\data）。

【進階：從命令列啟動】
  IPMS.cmd --port 9000        改用其他埠（預設 8080，被占用會自動換）
  IPMS.cmd --lan              讓同網段其他電腦也能連線
                                   （Windows 防火牆會詢問，請按「允許」）
  IPMS.cmd --no-browser       不自動開瀏覽器
  IPMS.cmd --tab              用一般瀏覽器分頁開啟（不要獨立視窗）
  IPMS.cmd --data-dir D:\tt   資料改存到指定資料夾

  已經在執行時再點一次 IPMS.cmd，只會再打開瀏覽器，不會重複啟動。

【注意】
  單機版預設只有這台電腦連得到。使用 --lan 時後台沒有登入保護，
  同網段的人都能修改內容，請只在信任的網路使用。
  要給多人長期使用，建議改用 Linux 正式部署（HTTPS、每日備份）：
  https://github.com/nox913106/net-tool-table/blob/main/docs/INSTALL.md
