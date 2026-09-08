from pathlib import Path

path = Path("migration/Registro-de-avance.md")
path.write_text(path.read_text().rstrip() + "\n")
