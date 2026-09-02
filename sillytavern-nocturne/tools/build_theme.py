#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成可以直接在 SillyTavern「用户设置 → UI 主题 → 导入」里导入的主题预设。

会产出两个文件：
    themes/夜笺 Nocturne.json          自带贴图（base64），导入即用
    themes/夜笺 Nocturne 外链版.json    贴图走 /user/images/nocturne/，文件小
预设里的字段与 1.14 / 1.15 自带主题（如 Cappuccino.json）完全一致。
"""

import json
import os

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BASE = {
    "blur_strength": 2,
    "main_text_color": "rgba(230, 219, 194, 1)",
    "italics_text_color": "rgba(171, 156, 126, 1)",
    "underline_text_color": "rgba(201, 168, 106, 1)",
    "quote_text_color": "rgba(227, 198, 141, 1)",
    "blur_tint_color": "rgba(18, 15, 13, 0.97)",
    "chat_tint_color": "rgba(10, 9, 8, 0.42)",
    "user_mes_blur_tint_color": "rgba(41, 30, 24, 0.97)",
    "bot_mes_blur_tint_color": "rgba(33, 27, 22, 0.97)",
    "shadow_color": "rgba(0, 0, 0, 0.85)",
    "shadow_width": 2,
    "border_color": "rgba(201, 168, 106, 0.34)",
    "font_scale": 1,
    "fast_ui_mode": False,
    "waifuMode": False,
    "avatar_style": 2,          # 方形头像，配合旧照片边框
    "chat_display": 0,          # 平铺（卡片样式由 CSS 负责，别用气泡）
    "noShadows": False,
    "chat_width": 50,
    "timer_enabled": True,
    "timestamps_enabled": True,
    "timestamp_model_icon": True,
    "mesIDDisplay_enabled": True,
    "hideChatAvatars_enabled": False,
    "message_token_count_enabled": True,
    "expand_message_actions": False,
    "enableZenSliders": False,
    "enableLabMode": False,
    "hotswap_enabled": True,
    "bogus_folders": True,
    "reduced_motion": False,
    "compact_input_area": True,
}


def write(name, *css_paths):
    """把若干个 css 文件按顺序拼成一份 custom_css（顺序 = 层叠顺序，别搞反）。"""
    theme = dict(BASE)
    theme["name"] = name
    theme["custom_css"] = "\n\n".join(open(p, encoding="utf-8").read() for p in css_paths)
    out_dir = os.path.join(HERE, "themes")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, name + ".json")
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(theme, fh, ensure_ascii=False, indent=4)
    print(f"{os.path.basename(out):<34} {os.path.getsize(out)/1024:7.0f} KB")


if __name__ == "__main__":
    css = lambda n: os.path.join(HERE, "css", n)
    # 默认版：内嵌贴图 + 信封页眉
    write("夜笺 Nocturne", css("nocturne.inline.css"), css("nocturne-envelope.css"))
    # 不要信封页眉的版本
    write("夜笺 Nocturne 素页版", css("nocturne.inline.css"))
    # 贴图走 /user/images/nocturne/ 的小体积版本
    write("夜笺 Nocturne 外链版", css("nocturne.css"), css("nocturne-envelope.css"))
