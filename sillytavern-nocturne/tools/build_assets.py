#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
夜笺 Nocturne · 素材生成脚本
=================================

把原始拼贴素材（黑底 JPG / 幻灯片截图）处理成主题可用的贴图：

1. 黑底素材 -> 用亮度反解出 alpha，得到干净的透明 PNG（去背）
2. 幻灯片截图 -> 裁掉水印 / 标题字 / 徽章，只保留可平铺的纹理
3. 程序化生成两张无缝纹理（羊皮纸 / 暗夜亚麻），体积很小，避免大图拖慢手机

用法:
    python3 tools/build_assets.py --src <素材目录> --out assets/nocturne

素材目录里需要有下列文件名（与作者本地素材一致；缺失的会跳过）:
    mat-crane.jpg      格纸 + 纸鹤 + 回形针（黑底）
    mat-butterfly.jpg  乐谱 + 蝴蝶 + 白花（黑底）
    mat-words.jpg      水彩 + 打字机纸条（黑底）
    mat-letter.jpg     手写信纸拼贴 + 试管花（黑底）
    mat-news.jpg       撕边报纸（黑底）
    ref-parchment.jpg  羊皮纸幻灯片（蝴蝶版画 + 四角花纹）
    ref-night.jpg      暗棕色蝴蝶草地幻灯片

没有原始素材时，脚本仍会生成两张程序化纹理，主题不会缺图（只是少了拼贴装饰）。
"""

import argparse
import os

import numpy as np
from PIL import Image, ImageFilter

# --------------------------------------------------------------------------
# 通用工具
# --------------------------------------------------------------------------


def unblack(img, lo=14, hi=150, gamma=1.0):
    """黑底素材去背：亮度当 alpha，再反预乘还原颜色。

    黑底拼贴本质上就是 “内容 screen 在黑色上”，所以
        alpha = 亮度归一化, color = 原色 / alpha
    能得到可以叠在任何底色上的干净 PNG。
    """
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    lum = a.max(axis=2)
    al = np.clip((lum - lo) / (hi - lo), 0, 1) ** gamma
    rgb = np.zeros_like(a)
    safe = np.maximum(al, 0.02)
    for c in range(3):
        rgb[:, :, c] = np.where(al > 0.02, np.clip(a[:, :, c] / safe, 0, 255), 0)
    return Image.fromarray(np.dstack([rgb, al * 255]).astype(np.uint8), "RGBA")


def ink_alpha(img, lo=70, hi=185, tint=(58, 46, 34)):
    """浅底上的深色版画去背：越黑越不透明，得到单色墨线贴图。"""
    a = np.asarray(img.convert("RGB")).astype(np.float32)
    lum = a.mean(axis=2)
    al = np.clip((hi - lum) / (hi - lo), 0, 1)
    h, w = al.shape
    rgb = np.zeros((h, w, 3), np.float32)
    rgb[:, :] = tint
    return Image.fromarray(np.dstack([rgb, al * 255]).astype(np.uint8), "RGBA")


def trim(img, thr=8, pad=2):
    """按 alpha 裁掉四周空白。"""
    a = np.asarray(img)[:, :, 3]
    ys, xs = np.where(a > thr)
    if len(xs) == 0:
        return img
    box = (max(int(xs.min()) - pad, 0), max(int(ys.min()) - pad, 0),
           min(int(xs.max()) + 1 + pad, img.width), min(int(ys.max()) + 1 + pad, img.height))
    return img.crop(box)


def fit(img, max_side):
    if max(img.size) > max_side:
        img = img.copy()
        img.thumbnail((max_side, max_side), Image.LANCZOS)
    return img


def save_png(img, path, colors=0):
    """存 PNG；colors > 0 时做调色板量化，明显减小体积。"""
    if colors:
        img = img.quantize(colors=colors, method=Image.FASTOCTREE, dither=Image.FLOYDSTEINBERG)
    img.save(path, optimize=True)
    print(f"  {os.path.basename(path):<24} {os.path.getsize(path)/1024:7.1f} KB")


def save_jpg(img, path, quality=78):
    img.convert("RGB").save(path, quality=quality, optimize=True, progressive=True)
    print(f"  {os.path.basename(path):<24} {os.path.getsize(path)/1024:7.1f} KB")


# --------------------------------------------------------------------------
# 程序化无缝纹理
# --------------------------------------------------------------------------


def seamless_noise(size, blur, seed):
    """做一张四边可无缝拼接的柔和噪声（3x3 平铺后模糊再取中心）。"""
    rng = np.random.default_rng(seed)
    base = rng.random((size, size)).astype(np.float32)
    tiled = np.tile(base, (3, 3))
    im = Image.fromarray((tiled * 255).astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(blur))
    arr = np.asarray(im).astype(np.float32)[size:2 * size, size:2 * size] / 255.0
    lo, hi = arr.min(), arr.max()
    return (arr - lo) / max(hi - lo, 1e-6)


def fiber_layer(size, seed, density=0.5, horizontal=True):
    """纸张纤维：细长的方向性噪声。"""
    n = seamless_noise(size, 0.6, seed)
    k = 12
    acc = np.zeros_like(n)
    for i in range(k):
        acc += np.roll(n, i - k // 2, axis=1 if horizontal else 0)
    acc /= k
    return (acc - acc.min()) / max(acc.max() - acc.min(), 1e-6) * density


def make_parchment(size=320, seed=7):
    """老羊皮纸：暖米色 + 斑驳 + 纤维。

    斑驳（低频）压得比较轻：低频一重，平铺到宽屏上就会看出一团团云斑。
    """
    blotch = seamless_noise(size, 5, seed)
    grain = seamless_noise(size, 0.7, seed + 1)
    fib = fiber_layer(size, seed + 2, 0.5, True) + fiber_layer(size, seed + 3, 0.4, False)
    v = 0.30 * blotch + 0.34 * grain + 0.36 * (fib / 0.9)
    v = np.clip((v - 0.5) * 1.1 + 0.5, 0, 1)
    light = np.array([226, 209, 178], np.float32)
    dark = np.array([170, 146, 110], np.float32)
    rgb = dark + (light - dark) * v[..., None]
    return Image.fromarray(rgb.astype(np.uint8), "RGB")


def make_linen(size=256, seed=21):
    """暗夜亚麻 / 旧书封：深褐灰的经纬织纹。"""
    warp = fiber_layer(size, seed, 1.0, True)
    weft = fiber_layer(size, seed + 1, 1.0, False)
    blotch = seamless_noise(size, 11, seed + 2)
    grain = seamless_noise(size, 0.7, seed + 3)
    v = 0.34 * warp + 0.34 * weft + 0.22 * blotch + 0.10 * grain
    v = np.clip((v - 0.5) * 1.45 + 0.5, 0, 1)
    light = np.array([64, 54, 44], np.float32)
    dark = np.array([26, 22, 19], np.float32)
    rgb = dark + (light - dark) * v[..., None]
    return Image.fromarray(rgb.astype(np.uint8), "RGB")


def make_vignette(size=512):
    """四角压暗遮罩，给卡片和背景加旧照片感（带 alpha 的 PNG）。"""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    cx = cy = (size - 1) / 2
    r = np.sqrt(((x - cx) / cx) ** 2 + ((y - cy) / cy) ** 2) / np.sqrt(2)
    a = np.clip((r - 0.45) / 0.55, 0, 1) ** 1.6 * 235
    rgb = np.zeros((size, size, 3), np.float32)
    rgb[:, :] = (10, 8, 6)
    return Image.fromarray(np.dstack([rgb, a]).astype(np.uint8), "RGBA")


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------


def build(src, out):
    os.makedirs(out, exist_ok=True)
    p = lambda name: os.path.join(src, name)
    o = lambda name: os.path.join(out, name)
    have = lambda name: os.path.isfile(p(name))

    print("程序化纹理:")
    save_jpg(make_parchment(), o("tex-parchment.jpg"), 82)
    save_jpg(make_linen(), o("tex-linen.jpg"), 82)
    save_png(make_vignette(), o("tex-vignette.png"), colors=64)

    print("幻灯片纹理:")
    if have("ref-night.jpg"):
        # 裁掉左上角标题、右上角徽章、底部水印与说明文字
        im = Image.open(p("ref-night.jpg")).crop((40, 120, 1060, 545))
        save_jpg(fit(im, 1100), o("bg-night-garden.jpg"), 74)
    if have("ref-parchment.jpg"):
        # 只取右下一块干净羊皮纸（避开标题字、四角花纹与水印）
        im = Image.open(p("ref-parchment.jpg")).crop((430, 600, 900, 700))
        im = im.resize((470, 100), Image.LANCZOS)
        save_jpg(im, o("bg-parchment-strip.jpg"), 80)
        # 版画蝴蝶：浅底深墨，用暗度当 alpha
        bf = Image.open(p("ref-parchment.jpg")).crop((360, 120, 900, 600))
        save_png(fit(trim(ink_alpha(bf, 78, 175, tint=(196, 164, 106))), 460), o("dec-butterfly-engraved.png"), colors=64)

    print("黑底拼贴去背:")
    jobs = [
        # 文件, 裁切框, 输出名, 最长边, 量化色数
        ("mat-butterfly.jpg", (180, 120, 660, 470), "dec-moth.png", 460, 96),
        ("mat-butterfly.jpg", (20, 400, 420, 800), "dec-flowers.png", 400, 96),
        ("mat-butterfly.jpg", (80, 470, 620, 780), "dec-score.png", 520, 64),
        ("mat-news.jpg", (130, 230, 620, 660), "dec-news-scrap.png", 460, 96),
        ("mat-words.jpg", (140, 300, 620, 700), "dec-words.png", 460, 96),
        ("mat-letter.jpg", (120, 120, 620, 830), "dec-letter-collage.png", 480, 96),
        ("mat-crane.jpg", (150, 330, 700, 800), "dec-crane.png", 480, 96),
    ]
    for fname, box, name, side, colors in jobs:
        if not have(fname):
            continue
        im = Image.open(p(fname)).crop(box)
        save_png(fit(trim(unblack(im)), side), o(name), colors=colors)

    print("完成 ->", out)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default="source", help="原始素材目录")
    ap.add_argument("--out", default="assets/nocturne", help="输出目录")
    a = ap.parse_args()
    build(a.src, a.out)
