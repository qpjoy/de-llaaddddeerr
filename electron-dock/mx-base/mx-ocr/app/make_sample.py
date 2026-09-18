"""生成一张自检用测试图（含中文段落 + 表格 + 数字），供 manage.sh test 使用。"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

CJK_CANDIDATES = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/wqy-zenhei/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]


def pick_font(size):
    for p in CJK_CANDIDATES:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size), "cjk" in p.lower() or "wqy" in p.lower() or "noto" in p.lower()
            except OSError:
                continue
    return ImageFont.load_default(), False


def main(out="sample.png"):
    W, H = 1000, 620
    img = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(img)

    f_title, cjk = pick_font(34)
    f_body, _ = pick_font(21)
    f_cell, _ = pick_font(19)

    if cjk:
        title = "knock-ocr 自检样张"
        body = [
            "这是一段用于验证中文识别准确率的测试文本，包含标点、数字与英文混排。",
            "订单编号 SN-20260909-0427，金额 ¥12,860.50，联系人：张伟（Zhang Wei）。",
            "The quick brown fox jumps over the lazy dog. 0123456789",
        ]
        rows = [
            ["项目", "数量", "单价(元)", "小计(元)"],
            ["服务器机架", "4", "3,200.00", "12,800.00"],
            ["网线 CAT6", "12", "5.00", "60.00"],
            ["合计", "16", "—", "12,860.00"],
        ]
    else:
        title = "knock-ocr self test"
        body = [
            "Sample text for verifying OCR accuracy with punctuation and digits.",
            "Order SN-20260909-0427, amount 12,860.50, contact: Zhang Wei.",
            "The quick brown fox jumps over the lazy dog. 0123456789",
        ]
        rows = [
            ["Item", "Qty", "Price", "Total"],
            ["Server rack", "4", "3,200.00", "12,800.00"],
            ["Cable CAT6", "12", "5.00", "60.00"],
            ["Total", "16", "-", "12,860.00"],
        ]

    d.text((48, 36), title, fill="black", font=f_title)
    d.line((48, 88, W - 48, 88), fill="#999", width=2)

    y = 112
    for line in body:
        d.text((48, y), line, fill="black", font=f_body)
        y += 38

    y += 24
    x0, col_w, row_h = 48, [340, 120, 220, 220], 46
    for r, row in enumerate(rows):
        x = x0
        for c, cell in enumerate(row):
            box = (x, y, x + col_w[c], y + row_h)
            d.rectangle(box, outline="black", width=2)
            if r == 0:
                d.rectangle((box[0] + 2, box[1] + 2, box[2] - 2, box[3] - 2), fill="#eeeeee")
            d.text((x + 14, y + 12), cell, fill="black", font=f_cell)
            x += col_w[c]
        y += row_h

    img.save(out)
    print(out)
    if not cjk:
        print("[warn] 容器内未找到中文字体，样张退化为英文；中文验证请用 "
              "`manage.sh test <你的图片>` 传真实图片。", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "sample.png")
