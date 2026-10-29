"""程序图标 assets/icon/desk-pet.ico（快捷方式、开机启动项用；2026-10-29）。

  python scripts/make-icon.py

取魔法师待机第一帧的上半截（帽子和脸，和托盘图标同一块），补成正方形：
大尺寸按整数倍最近邻放大（像素不糊），小尺寸平滑缩小。图集换了重跑一次。用 Pillow 存多尺寸 ico。自写。
"""
import json
import pathlib

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
SHEET = ROOT / 'packs/mage/sprites/r120-full/clothed/idle-right'
OUT = ROOT / 'assets/icon/desk-pet.ico'

meta = json.loads(SHEET.with_suffix('.json').read_text(encoding='utf8'))
cw, ch = meta['cell']
frame = Image.open(SHEET.with_suffix('.png')).convert('RGBA').crop((0, 0, cw, ch))
box = frame.getbbox()                      # 只留有像素的部分，再从顶上取一个正方形（帽尖到脸）
body = frame.crop(box)
side = body.width
head = body.crop((0, 0, side, side))
canvas = Image.new('RGBA', (128, 128), (0, 0, 0, 0))
k = max(1, 128 // side)                    # 整数倍放大
big = head.resize((side * k, side * k), Image.NEAREST)
canvas.alpha_composite(big, ((128 - big.width) // 2, (128 - big.height) // 2))
sizes = [16, 24, 32, 48, 64, 128, 256]
images = [canvas.resize((s, s), Image.NEAREST if s >= 128 else Image.LANCZOS) for s in sizes]
OUT.parent.mkdir(parents=True, exist_ok=True)
images[-1].save(OUT, format='ICO', sizes=[(s, s) for s in sizes], append_images=images[:-1])
print(f'{OUT.relative_to(ROOT)}：{len(sizes)} 个尺寸，取自 {SHEET.relative_to(ROOT)} 第 0 帧')
