# -*- coding: utf-8 -*-
"""把可读版模板压成单行，并重新生成酒馆正则 JSON。

改完 `预言家日报-替换模板.html` 后运行：python3 build.py
"""
import io
import json
import os
import re
import uuid

BASE = os.path.dirname(os.path.abspath(__file__))
TPL = os.path.join(BASE, "预言家日报-替换模板.html")
ONE_LINE = os.path.join(BASE, "预言家日报-替换模板-单行版.txt")
FIND = os.path.join(BASE, "预言家日报-正则-查找式.txt")
JSON_OUT = os.path.join(BASE, "预言家日报-正则.json")


def minify(src):
    """去注释 + 折行，得到可安全塞进酒馆正则的单行 HTML。"""
    s = re.sub(r"/\*.*?\*/", "", src, flags=re.S)   # CSS 注释
    s = re.sub(r"<!--.*?-->", "", s, flags=re.S)    # HTML 注释
    s = re.sub(r"\s*\n\s*", " ", s)                 # 折行与缩进
    head, tail = s.split("</style>", 1)             # 只在 CSS 部分收紧符号周围空格
    head = re.sub(r"\s*([{};,:>])\s*", r"\1", head)
    return re.sub(r">\s+<", "><", head + "</style>" + tail).strip()


SAMPLES = [
    ("示例一 · 校内快讯（默认是折叠的，这份先替你展开了；右上角可切晨刊 / 夜刊）", True, [
        "1971年12月1日", "星期三 · 冬季学期",
        "下午四时许", "冬日黄昏 · 晚宴之前",
        "校内快讯",
        "黑湖边雪球大战惊动半座城堡",
        "霍格沃茨学生昨日于黑湖岸边组织了一场规模可观的雪球对抗，据称参赛者一度多达四十余人。"
        "目击者称，双方使用了诱敌、包抄乃至临时防御工事，甚至有人试图以漂浮咒改良弹道，所幸未酿成伤情。"
        "数名高年级学生因此开始争论，雪球是否应被列入正式校际运动；亦有画像抱怨积雪溅上画框。"
        "校方尚未就此发表意见，惟级长办公室门前的告示已被人悄悄改写。",
        "匿名猫头鹰来函", "多方消息",
    ]),
    ("示例二 · 魔法部政讯（这份是默认的折叠状态，点报头展开）", False, [
        "1971年12月上旬", "十二月号外",
        "午夜将近", "宵禁以后",
        "魔法部政讯",
        "魔法部重申身份登记条例，反对之声渐起",
        "魔法部昨日于新闻办公室重申，现行的血统与身份登记条例将继续施行，并称此举“纯为便利统计与公共安全”。"
        "发言人拒绝回答关于登记资料保存年限的追问。对角巷部分商户对本报表示，近月来前来核验证件者明显增多；"
        "亦有匿名人士称，某些登记档案的调阅记录并不完整。魔法部对上述说法未予置评。",
        "魔法部新闻办公室", "官方口径",
    ]),
]

PREVIEW = os.path.join(BASE, "预言家日报-效果预览.html")

PREVIEW_SHELL = u"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>预言家日报状态栏 · 效果预览</title>
<style>
  body{margin:0;padding:22px 12px 60px;background:#3b3630;
       background-image:radial-gradient(ellipse at 50%% 0%%,#4a443b,#241f1a 70%%);
       font-family:'Noto Serif SC',serif;}
  .demo-h{max-width:760px;margin:0 auto 6px;color:#cbbfa6;font-size:13px;letter-spacing:.1em;
          border-bottom:1px solid #6a5942;padding-bottom:6px;}
</style>
</head>
<body>
%s</body>
</html>
"""


def make_preview(tpl):
    blocks = []
    for caption, expanded, vals in SAMPLES:
        one = re.sub(r"\$([1-9])", lambda m: vals[int(m.group(1)) - 1], tpl)
        if expanded:
            one = one.replace('<details class="dp-paper">', '<details class="dp-paper" open>')
        blocks.append(u'<div class="demo-h">%s</div>\n%s\n' % (caption, one))
    io.open(PREVIEW, "w", encoding="utf-8").write(PREVIEW_SHELL % u"".join(blocks))


def main():
    src = io.open(TPL, encoding="utf-8").read()
    make_preview(src)
    out = minify(src)
    assert "\n" not in out, "压缩后仍有换行"
    assert len(re.findall(r"\$[1-9]", out)) == 14, "捕获组占位符数量异常"
    io.open(ONE_LINE, "w", encoding="utf-8").write(out)

    script = {
        "id": str(uuid.uuid5(uuid.NAMESPACE_URL, "daily-prophet-status-bar")),
        "scriptName": "预言家日报 · 常驻新闻状态栏",
        "findRegex": io.open(FIND, encoding="utf-8").read().strip(),
        "replaceString": out,
        "trimStrings": [],
        "placement": [2],
        "disabled": False,
        "markdownOnly": True,
        "promptOnly": False,
        "runOnEdit": True,
        "substituteRegex": 0,
        "minDepth": None,
        "maxDepth": None,
    }
    io.open(JSON_OUT, "w", encoding="utf-8").write(
        json.dumps(script, ensure_ascii=False, indent=2))
    print("预览页、单行版（%d 字符，源码 %d）与正则 JSON 均已重建" % (len(out), len(src)))


if __name__ == "__main__":
    main()
