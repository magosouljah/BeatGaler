from pathlib import Path
import shutil, subprocess, sys

root = Path.cwd()
server = root / 'cloud-server' / 'server.js'
rust = root / 'src-tauri' / 'src' / 'commands.rs'
server_bak = server.with_suffix(server.suffix + '.topics-pass.bak')
rust_bak = rust.with_suffix(rust.suffix + '.topics-pass.bak')

missing = [str(p) for p in (server_bak, rust_bak) if not p.exists()]
if missing:
    print('[ERROR] Missing backup(s):')
    for p in missing:
        print('  ', p)
    sys.exit(1)

shutil.copy2(server_bak, server)
shutil.copy2(rust_bak, rust)
print('[OK] Restored cloud-server/server.js from pre-Topics backup')
print('[OK] Restored src-tauri/src/commands.rs from pre-Topics backup')

check = subprocess.run(['node', '--check', str(server)], capture_output=True, text=True)
if check.returncode != 0:
    print(check.stdout)
    print(check.stderr)
    print('[ERROR] Restored server.js still fails node --check.')
    sys.exit(check.returncode)

print('[OK] node --check cloud-server/server.js')
print('\nTopics Pass rolled back safely. Earlier Stability/Storage changes remain.')
