@echo off
chcp 65001 >nul
REM ============================================================
REM  매일 자동 실행되는 파일 (윈도우 작업 스케줄러에 등록해서 쓴다)
REM
REM  왜 GitHub 서버가 아니라 이 PC 에서 도는가:
REM    EIASS 가 해외 IP 를 막고 있어서 GitHub 서버(미국)에서는
REM    www.eiass.go.kr 에 아예 연결이 안 된다(ConnectTimeout, 확인함).
REM    그래서 한국에 있는 이 컴퓨터가 자료를 받아 GitHub 에 올려 준다.
REM
REM  하는 일:
REM    1) EIASS 에서 자료 수집  -> data\projects.json
REM    2) 바뀐 게 있으면 GitHub 에 올린다
REM    3) 올리면 GitHub 이 알아서 사이트를 다시 배포한다
REM
REM  기록은 data\build_log.txt 에 쌓인다. 문제가 생기면 이 파일을 본다.
REM
REM  배치 파일 주의: echo 같은 내장 명령은 ERRORLEVEL 을 0 으로 되돌리지 않는다.
REM  그래서 명령마다 바로 다음 줄에서 %ERRORLEVEL% 을 확인한다.
REM ============================================================

cd /d "%~dp0\.."
set "LOG=data\build_log.txt"

echo. >> "%LOG%"
echo ==================== %date% %time% ==================== >> "%LOG%"

REM ---------- 1) 수집 ----------
python tools\build_data.py >> "%LOG%" 2>&1
if %ERRORLEVEL% neq 0 (
  call :fail "수집이 실패했습니다."
  exit /b 1
)

REM ---------- 2) 바뀐 게 있는지 확인 ----------
REM  git diff --quiet 은 '다른 게 없으면 0, 있으면 1' 로 끝난다.
git diff --quiet -- data/projects.json
if %ERRORLEVEL% equ 0 (
  echo [안내] 바뀐 자료가 없어 올리지 않습니다. >> "%LOG%"
  echo [안내] 바뀐 자료가 없습니다.
  exit /b 0
)

REM ---------- 3) GitHub 에 올리기 ----------
git add data/projects.json >> "%LOG%" 2>&1
if %ERRORLEVEL% neq 0 (
  call :fail "git add 에 실패했습니다."
  exit /b 1
)

git commit -m "데이터 갱신 %date%" >> "%LOG%" 2>&1
if %ERRORLEVEL% neq 0 (
  call :fail "커밋에 실패했습니다."
  exit /b 1
)

git push >> "%LOG%" 2>&1
if %ERRORLEVEL% neq 0 (
  call :fail "올리기에 실패했습니다. GitHub Desktop 에서 로그인 상태를 확인하세요."
  exit /b 1
)

echo [완료] 자료를 올렸습니다. 잠시 뒤 사이트에 반영됩니다. >> "%LOG%"
echo [완료] 자료를 올렸습니다. 잠시 뒤 사이트에 반영됩니다.
exit /b 0

REM ---------- 실패했을 때 한 곳에서 알린다 ----------
:fail
echo [중단] %~1 >> "%LOG%"
echo [중단] %~1
echo        자세한 내용은 data\build_log.txt 를 보세요.
goto :eof
