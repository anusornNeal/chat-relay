import json
import math
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "samples"
OUT.mkdir(parents=True, exist_ok=True)

W, H = 768, 512

def font(size):
    for name in ["arial.ttf", "segoeui.ttf", "DejaVuSans.ttf"]:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default()

def base(title):
    im = Image.new("RGB", (W, H), (245, 246, 248))
    d = ImageDraw.Draw(im)
    d.rectangle((0, 0, W, 64), fill=(255, 255, 255))
    d.text((28, 17), title, fill=(28, 32, 40), font=font(26))
    d.line((0, 64, W, 64), fill=(220, 223, 228), width=2)
    return im, d

def calendar(variant):
    im, d = base("Calendar")
    d.text((30, 84), ["October 2026", "November 2026", "December 2026"][variant], fill=(35, 38, 44), font=font(30))
    left, top, cw, ch = 38, 140, 95, 52
    days = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"]
    for c, name in enumerate(days):
        d.text((left+c*cw+20, top-35), name, fill=(90, 95, 105), font=font(16))
    n=1
    for r in range(5):
        for c in range(7):
            x=left+c*cw; y=top+r*ch
            d.rounded_rectangle((x,y,x+82,y+42), radius=7, outline=(210,213,218), width=1, fill=(255,255,255))
            if n <= 31:
                d.text((x+29,y+10), str(n), fill=(40,44,52), font=font(18))
            n += 1
    return im

def loading(variant):
    im, d = base("Please wait")
    cx, cy = W//2, H//2-20
    for i in range(10):
        a=math.radians(i*36+variant*12)
        x1=cx+math.cos(a)*42; y1=cy+math.sin(a)*42
        x2=cx+math.cos(a)*64; y2=cy+math.sin(a)*64
        shade=60+i*15
        d.line((x1,y1,x2,y2), fill=(shade,shade,shade), width=8)
    d.text((W//2-75, cy+90), "Loading...", fill=(55,60,70), font=font(28))
    return im

def error_dialog(variant):
    im, d = base("Jobs")
    d.rectangle((0,64,W,H), fill=(225,227,231))
    x1,y1,x2,y2=150,135,618,390
    d.rounded_rectangle((x1,y1,x2,y2), radius=18, fill=(255,255,255), outline=(200,203,210), width=2)
    d.ellipse((190,175,250,235), fill=(210,60,60))
    d.text((208,180), "!", fill=(255,255,255), font=font(34))
    titles=["Something went wrong","Unable to load data","Connection error"]
    d.text((280,175), titles[variant], fill=(30,34,42), font=font(26))
    d.text((190,260), "Please try again.", fill=(90,95,105), font=font(20))
    d.rounded_rectangle((430,320,570,365), radius=10, fill=(65,95,220))
    d.text((470,331), "Retry", fill=(255,255,255), font=font(18))
    return im

def success(variant):
    im, d = base("Complete")
    cx,cy=W//2,230
    d.ellipse((cx-72,cy-72,cx+72,cy+72), fill=(55,165,95))
    d.line((cx-36,cy,cx-8,cy+30), fill=(255,255,255), width=12)
    d.line((cx-8,cy+30,cx+45,cy-35), fill=(255,255,255), width=12)
    titles=["Saved successfully","Job completed","Changes updated"]
    d.text((W//2-110,340), titles[variant], fill=(32,36,44), font=font(27))
    return im

def settings(variant):
    im, d = base("Settings")
    labels=[["Notifications","Dark mode","Language","Privacy"],
            ["Account","Security","Appearance","Help"],
            ["Profile","Calendar","Permissions","About"]][variant]
    y=105
    for idx,label in enumerate(labels):
        d.rounded_rectangle((48,y,720,y+72), radius=10, fill=(255,255,255), outline=(221,224,230), width=1)
        d.text((78,y+22), label, fill=(40,44,52), font=font(22))
        if idx % 2 == 0:
            d.rounded_rectangle((625,y+23,680,y+49), radius=13, fill=(80,110,220))
            d.ellipse((653,y+25,677,y+47), fill=(255,255,255))
        else:
            d.text((660,y+22), ">", fill=(120,125,135), font=font(24))
        y += 88
    return im

def unknown(variant):
    im, d = base(["Terminal", "Browser", "Desktop"][variant])
    if variant == 0:
        d.rectangle((45,95,725,455), fill=(24,26,30))
        for i,text in enumerate(["PS C:\\> npm run dev","server listening on :3000","GET /health 200","git status --short"]):
            d.text((70,125+i*55), text, fill=(190,225,190), font=font(20))
    elif variant == 1:
        d.rounded_rectangle((55,100,710,155), radius=8, fill=(232,234,238))
        d.rounded_rectangle((55,180,500,410), radius=8, fill=(255,255,255), outline=(210,213,218))
        d.text((85,210), "Documentation", fill=(40,44,52), font=font(28))
        for i in range(5):
            d.line((85,270+i*25,430,270+i*25), fill=(165,170,178), width=8)
    else:
        d.rectangle((0,65,W,H), fill=(45,85,120))
        for i,name in enumerate(["Files","Code","Chrome","Recycle Bin"]):
            x=55+(i%2)*115; y=115+(i//2)*115
            d.rectangle((x,y,x+48,y+48), fill=(225,230,238))
            d.text((x,y+58), name, fill=(255,255,255), font=font(14))
    return im

GENERATORS={
    "calendar": calendar,
    "loading": loading,
    "error_dialog": error_dialog,
    "success": success,
    "settings": settings,
    "unknown": unknown,
}

manifest=[]
for label, gen in GENERATORS.items():
    for variant in range(3):
        name=f"{label}-{variant+1}.png"
        gen(variant).save(OUT / name)
        manifest.append({"file": name, "expected": label})

(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
print(f"generated {len(manifest)} samples in {OUT}")
