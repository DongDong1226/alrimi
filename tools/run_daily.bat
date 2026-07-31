@echo off
REM 작업 스케줄러가 매일 이 파일을 실행하도록 등록해서 자동으로 데이터를 갱신한다.
cd /d "%~dp0\.."
echo ==================== %date% %time% ==================== >> data\build_log.txt
python tools\build_data.py >> data\build_log.txt 2>&1
