@echo off
chcp 65001 >nul
REM ============================================================
REM  매일 자동 실행되는 파일 (윈도우 작업 스케줄러에 등록해서 쓴다)
REM
REM  ★ 평소 수집은 이 파일이 아니라 .github/workflows/collect.yml 이 한다
REM    (한국 시간 00:10 / 07:00 / 13:00, 자동). 이 파일은 **급할 때 손으로 돌리는 길**이다.
REM
REM  ★ 예전에 여기 적혀 있던 "EIASS 가 해외 IP 를 막는다"는 **사실이 아니다.**
REM    전 세계 20개 노드 중 17곳에서 정상으로 붙었다(미국 LA 0.49초 포함).
REM    GitHub 러너에서만 유독 안 붙던 것이고, 그건 2026-08-15 에 **서울 중계**로 풀었다.
REM    이 PC 에서 돌리는 이유는 '차단' 때문이 아니라 **직접 붙어서 더 빠르기** 때문이다.
REM
REM  하는 일:
REM    1) EIASS 에서 자료 수집  -> data\projects.json + data\cal\*.ics
REM    2) 바뀐 게 있으면 GitHub 에 올린다
REM    3) 올리면 GitHub 이 알아서 사이트를 다시 배포한다
REM
REM  기록은 data\build_log.txt 에 쌓인다. 문제가 생기면 이 파일을 본다.
REM
REM  ※ 이 파일은 반드시 CRLF 줄바꿈으로 저장해야 한다.
REM    LF 로 저장하면 윈도우 cmd 가 읽다 말고 조용히 끝난다(창이 깜빡이고 닫힌다).
REM    .gitattributes 에서 *.bat 를 CRLF 로 고정해 두었다.

REM
REM  ※ echo 같은 내장 명령은 ERRORLEVEL 을 0 으로 되돌리지 않는다.
REM    그래서 명령마다 바로 다음 줄에서 %ERRORLEVEL% 을 확인한다.
REM ============================================================

cd /d "%~dp0.."
set "LOG=data\build_log.txt"

echo [1/3] EIASS 에서 자료를 받는 중입니다... (몇 분 걸립니다)
echo. >> "%LOG%"
echo ==================== %date% %time% ==================== >> "%LOG%"

REM ---------- 1) 수집 ----------
python tools\build_data.py >> "%LOG%" 2>&1
if %ERRORLEVEL% neq 0 (
  call :fail "수집이 실패했습니다."
  goto :done
)

REM ---------- 2) 올릴 것을 담고, 바뀐 게 있는지 확인 ----------
echo [2/3] 바뀐 자료가 있는지 확인 중...
git add data/projects.json >> "%LOG%" 2>&1
if %ERRORLEVEL% neq 0 (
  call :fail "git add 에 실패했습니다."
  goto :done
)

REM  ★ 지역별 캘린더(.ics)도 반드시 함께 올린다 — collect.yml 과 같아야 한다.
REM    빠뜨리면 주민이 구독한 주소의 내용이 **영영 안 바뀐다.** 새 사업이 떠도
REM    캘린더에는 안 들어오는데, 화면에는 아무 표시도 안 나서 아무도 모른다.
REM    (collect.yml 에서 이미 한 번 빠뜨려 겪은 함정이다)
REM    -A 를 쓰는 이유: 사업이 끝나 **없어진 지역 파일까지** 반영해야 한다.
git add -A data/cal >> "%LOG%" 2>&1
if %ERRORLEVEL% neq 0 (
  call :fail "캘린더(data\cal) 를 담는 데 실패했습니다."
  goto :done
)

REM  git diff --cached --quiet 은 '담긴 것이 없으면 0, 있으면 1' 로 끝난다.
REM  ★ projects.json 하나만 보지 않는다 — 캘린더만 바뀌는 날이 있을 수 있다.
git diff --cached --quiet
if %ERRORLEVEL% equ 0 (
  echo [안내] 바뀐 자료가 없어 올리지 않습니다. >> "%LOG%"
  echo.
  echo [안내] 바뀐 자료가 없습니다. 오늘은 올릴 것이 없습니다.
  goto :done
)

REM ---------- 3) GitHub 에 올리기 ----------
echo [3/3] GitHub 에 올리는 중...
git commit -m "데이터 갱신 %date%" >> "%LOG%" 2>&1
if %ERRORLEVEL% neq 0 (
  call :fail "커밋에 실패했습니다."
  goto :done
)

git push >> "%LOG%" 2>&1
if %ERRORLEVEL% neq 0 (
  call :fail "올리기에 실패했습니다. GitHub Desktop 에서 로그인 상태를 확인하세요."
  goto :done
)

echo [완료] 자료를 올렸습니다. 잠시 뒤 사이트에 반영됩니다. >> "%LOG%"
echo.
echo [완료] 자료를 올렸습니다. 1~2분 뒤 사이트에 반영됩니다.
goto :done

REM ---------- 실패했을 때 한 곳에서 알린다 ----------
:fail
echo [중단] %~1 >> "%LOG%"
echo.
echo [중단] %~1
echo        자세한 내용은 data\build_log.txt 를 보세요.
goto :eof

REM ---------- 끝. 더블클릭으로 연 창이 바로 닫히지 않게 잠시 둔다 ----------
REM  timeout 은 아무 키나 누르면 바로 넘어가고, 30초 뒤 저절로 닫힌다.
REM  작업 스케줄러처럼 화면이 없는 곳에서는 그냥 지나간다(멈추지 않는다).
:done
echo.
echo 창을 닫으려면 아무 키나 누르세요. (30초 뒤 저절로 닫힙니다)
timeout /t 30 >nul 2>&1
exit /b 0
