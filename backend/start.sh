#!/bin/bash
cd "$(dirname "$0")"
echo "======================================"
echo "  Deduplicador RIS — Backend Masivo"
echo "======================================"
echo ""

# Crear entorno virtual si no existe
if [ ! -d "venv" ]; then
  echo "Creando entorno virtual..."
  python3 -m venv venv
fi

# Activar entorno virtual
source venv/bin/activate

echo "Instalando dependencias..."
pip install -r requirements.txt --quiet

echo ""
echo "Iniciando servidor en http://localhost:8000"
echo "Abre tu navegador en esa dirección."
echo "(Ctrl+C para detener)"
echo ""
python main.py

