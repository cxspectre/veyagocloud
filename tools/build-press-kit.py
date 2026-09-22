#!/usr/bin/env python3
"""Rebuild the downloadable press kit from the committed notes and images.
Run: python3 tools/build-press-kit.py
"""
from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED

ROOT = Path(__file__).resolve().parent.parent
FILES = {
    'ABOUT.txt': 'veyago-press-notes.txt',
    'Veyago-Press-Kit.pdf': 'veyago-press-kit.pdf',
    'brand/veyago-icon.png': 'veyago-icon.png',
    'brand/favicon.svg': 'favicon.svg',
    'brand/provisum-icon.png': 'provisum-icon.png',
    'brand/og-studio.png': 'og-studio.png',
    'people/cassian-drefke.png': 'cassian-drefke.png',
    'provisum/provisum-binder-home.png': 'provisum-binder-home.png',
    'provisum/provisum-emergency-card.png': 'provisum-emergency-card.png',
    'provisum/provisum-er-packet.png': 'provisum-er-packet.png',
    'veyago/veyago-discover.jpg': 'veyago-discover.jpg',
    'veyago/veyago-bracket.jpg': 'veyago-bracket.jpg',
    'veyago/veyago-wellbeing.jpg': 'veyago-wellbeing.jpg',
}

def main():
    # Read everything before replacing the existing archive.
    entries = [(name, (ROOT / 'assets' / source).read_bytes()) for name, source in FILES.items()]
    target = ROOT / 'assets/veyago-press-kit.zip'
    with ZipFile(target, 'w', compression=ZIP_DEFLATED) as archive:
        for name, content in entries:
            info = ZipInfo(name, date_time=(2026, 9, 22, 0, 0, 0))
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            archive.writestr(info, content)
    print(f'Built {target.name}: {len(entries)} files, {target.stat().st_size / 1048576:.1f} MB')

if __name__ == '__main__':
    main()
