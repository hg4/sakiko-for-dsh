@echo off
setlocal
chcp 65001 >nul
title SAKIKO 数据目录切换（Kurisu 存档 → Sakiko 全新开始）

echo ==============================================
echo   SAKIKO 数据目录一键切换
echo   用途：把旧的牧濑红莉栖记忆数据 (~/.dsh/amadeus)
echo         改名存档，让 SAKIKO（白祥）从全新记忆开始
echo   原理：先停止 DSH，再改目录名，再启动 DSH
echo ==============================================
echo.

rem 1. 停止占用 3080 端口的 DSH 进程
echo [1/3] 停止 DSH（占用 3080 端口的进程）...
powershell -NoProfile -Command "$ids = Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($ids) { $ids | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }; Write-Host ('已停止: PID ' + ($ids -join ', ')) } else { Write-Host '未发现运行中的 DSH' }"

rem 2. 等端口释放
echo [2/3] 等待端口释放...
timeout /t 2 /nobreak >nul

rem 3. 数据目录改名（原目录已不存在则跳过）
echo [3/3] 处理数据目录...
if exist "%USERPROFILE%\.dsh\amadeus" (
  if not exist "%USERPROFILE%\.dsh\amadeus-kurisu-20260906" (
    ren "%USERPROFILE%\.dsh\amadeus" "amadeus-kurisu-20260906"
    if errorlevel 1 (
      echo [!] 改名失败（目录可能仍被占用），请手动执行：
      echo     ren "%USERPROFILE%\.dsh\amadeus" amadeus-kurisu-20260906
    ) else (
      echo [OK] 旧数据已存档为 amadeus-kurisu-20260906
    )
  ) else (
    echo [OK] 存档目录已存在，跳过改名（当前 amadeus 目录将被原样保留）
  )
) else (
  echo [OK] 无 ~/.dsh/amadeus 目录（可能已切换过），无需处理
)

echo.
echo ----------------------------------------------
echo   启动 DSH Web（SAKIKO 将自动以全新记忆运行）
echo   关闭本窗口即停止 DSH
echo ----------------------------------------------
timeout /t 2 /nobreak >nul
cd /d "G:\deepseek-harness"
start "" cmd /c "timeout /t 6 /nobreak >nul & start http://127.0.0.1:3080"
call node_modules\.bin\dsh web

echo.
echo DSH 已退出，窗口将在 3 秒后自动关闭。
timeout /t 3 /nobreak >nul
endlocal
