@echo off
cd /d "%~dp0"
echo ======================================
echo   Deduplicador RIS — Backend Masivo
echo ======================================
echo.
echo Instalando dependencias Python...
pip install -r requirements.txt --quiet
echo.
echo Iniciando servidor en http://localhost:8000
echo Abre tu navegador en esa direccion.
echo (Ctrl+C para detener)
echo.
python main.py
pause
