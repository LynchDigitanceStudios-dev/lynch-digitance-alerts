@echo off
REM ============================================================================
REM  Lynch Digitance Alerts — server launcher
REM
REM  Starts one Chrome window per Fiverr account, each on its own profile, with
REM  background throttling turned OFF.
REM
REM  WHY THE FLAGS MATTER: Chrome aggressively throttles tabs in windows that
REM  aren't in the foreground, and on a server NOTHING is ever in the foreground.
REM  Timers get slowed to about one tick a minute and tabs get discarded to save
REM  memory, so alerts arrive late or stop entirely. These flags disable that.
REM
REM  SETUP: edit the PROFILES line below to your account names, then run once.
REM  To start it automatically at boot, see SERVER-SETUP.md.
REM ============================================================================

setlocal enabledelayedexpansion

REM --- your Fiverr accounts: one word per profile, space separated ------------
set PROFILES=main patrick joint lency

REM --- where Chrome lives -----------------------------------------------------
set CHROME="C:\Program Files\Google Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% (
  echo [ERROR] Chrome not found. Edit the CHROME line in this file.
  pause
  exit /b 1
)

REM --- where profiles are stored ----------------------------------------------
set PROFILEROOT=%USERPROFILE%\FiverrWatchers
if not exist "%PROFILEROOT%" mkdir "%PROFILEROOT%"

REM --- keep the server awake ---------------------------------------------------
powercfg /change standby-timeout-ac 0 >nul 2>&1
powercfg /change hibernate-timeout-ac 0 >nul 2>&1
powercfg /change monitor-timeout-ac 0 >nul 2>&1

REM --- anti-throttling flags ---------------------------------------------------
set FLAGS=--disable-background-timer-throttling ^
 --disable-backgrounding-occluded-windows ^
 --disable-renderer-backgrounding ^
 --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,HighEfficiencyModeAvailable ^
 --no-default-browser-check ^
 --no-first-run ^
 --restore-last-session

for %%P in (%PROFILES%) do (
  echo Starting watcher: %%P
  start "" %CHROME% %FLAGS% ^
    --user-data-dir="%PROFILEROOT%\%%P" ^
    "https://www.fiverr.com/inbox"
  timeout /t 4 /nobreak >nul
)

echo.
echo All watchers started.
echo.
echo FIRST RUN ONLY, in each window:
echo   1. Log into that Fiverr account
echo   2. chrome://extensions - enable Developer mode - Load unpacked - pick this folder
echo   3. Set up Telegram in the extension, and name the account
echo   4. Pin the Fiverr tab (right-click the tab - Pin)
echo.
echo After that this script just reopens everything.
timeout /t 20 /nobreak >nul
