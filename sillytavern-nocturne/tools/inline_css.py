#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 nocturne.css 里的贴图路径换成 base64，生成「一段就能用」的单文件版本。

适合没法往 SillyTavern 目录里放文件的场景（比如手机端、别人代管的服务器），
代价是自定义 CSS 会变大（约 300 KB），主题切换时略慢一点。

用法:
    python3 tools/inline_css.py                       # 生成 css/nocturne.inline.css
    python3 tools/inline_css.py --lite                # 去掉最大的背景图，体积减半
"""

import argparse
import base64
import mimetypes
import os
import re

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(HERE, "css", "nocturne.css")
ASSETS = os.path.join(HERE, "assets", "nocturne")

# 主题里实际用到的贴图；没列到这里的变量会被置成 none，省体积
USED = {
    "tex-linen.jpg", "tex-parchment.jpg", "tex-vignette.png",
    "bg-night-garden.jpg", "dec-butterfly-engraved.png",
    "dec-flowers.png", "dec-news-scrap.png", "dec-score.png",
}
# --lite 模式额外剔除的大图
LITE_DROP = {"bg-night-garden.jpg"}


def data_uri(path):
    mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
    with open(path, "rb") as fh:
        return f"data:{mime};base64,{base64.b64encode(fh.read()).decode('ascii')}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lite", action="store_true", help="去掉夜色背景大图")
    ap.add_argument("--out", default=os.path.join(HERE, "css", "nocturne.inline.css"))
    args = ap.parse_args()

    css = open(SRC, encoding="utf-8").read()
    drop = set(LITE_DROP) if args.lite else set()
    stats = {"inlined": 0, "dropped": 0, "missing": 0}

    def repl(m):
        name = m.group(1)
        path = os.path.join(ASSETS, name)
        if name in drop or name not in USED:
            stats["dropped"] += 1
            return "none"
        if not os.path.isfile(path):
            stats["missing"] += 1
            return "none"
        stats["inlined"] += 1
        return f'url("{data_uri(path)}")'

    out = re.sub(r'url\("/user/images/nocturne/([^"]+)"\)', repl, css)
    header = (
        "/* 夜笺 Nocturne · 单文件版（贴图已内嵌 base64，无需往酒馆目录放文件）\n"
        "   由 tools/inline_css.py 生成，请不要直接改这个文件，改 css/nocturne.css 后重新生成。 */\n"
    )
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(header + out)

    size = os.path.getsize(args.out) / 1024
    print(f"内嵌 {stats['inlined']} 张，跳过 {stats['dropped']} 张，缺失 {stats['missing']} 张")
    print(f"输出 {args.out}  ({size:.0f} KB)")


if __name__ == "__main__":
    main()
