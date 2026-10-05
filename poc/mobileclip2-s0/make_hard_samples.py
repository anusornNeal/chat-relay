import json
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT=Path(__file__).resolve().parent
OUT=ROOT/"samples-hard"
OUT.mkdir(parents=True,exist_ok=True)
W,H=768,512

def font(size):
    for name in ["arial.ttf","segoeui.ttf","DejaVuSans.ttf"]:
        try: return ImageFont.truetype(name,size)
        except OSError: pass
    return ImageFont.load_default()

def canvas(title,dark=False):
    bg=(28,30,35) if dark else (248,248,250)
    fg=(238,240,244) if dark else (32,36,44)
    im=Image.new("RGB",(W,H),bg); d=ImageDraw.Draw(im)
    d.text((30,24),title,fill=fg,font=font(28))
    return im,d,fg

def calendar(v):
    im,d,fg=canvas("Schedule" if v else "My month",dark=bool(v))
    left,top=55,110
    for c in range(7):
        for r in range(5):
            x=left+c*92; y=top+r*66
            d.rounded_rectangle((x,y,x+75,y+52),radius=10,outline=(120,125,135),width=1)
            n=r*7+c+1
            d.text((x+24,y+14),str(n),fill=fg,font=font(18))
    d.ellipse((left+2*92+18,top+2*66+8,left+2*92+58,top+2*66+48),outline=(70,130,230),width=4)
    return im

def loading(v):
    im,d,fg=canvas("Syncing" if v else "Working",dark=bool(v))
    cx,cy=W//2,H//2
    if v:
        d.rounded_rectangle((180,270,588,292),radius=10,fill=(80,84,92))
        d.rounded_rectangle((180,270,430,292),radius=10,fill=(90,145,235))
    else:
        for i in range(12):
            a=math.radians(i*30)
            x1=cx+math.cos(a)*34; y1=cy+math.sin(a)*34
            x2=cx+math.cos(a)*58; y2=cy+math.sin(a)*58
            d.line((x1,y1,x2,y2),fill=fg,width=7)
    return im

def error_dialog(v):
    im,d,fg=canvas("Home",dark=bool(v))
    panel=(50,52,60) if v else (255,255,255)
    d.rounded_rectangle((115,155,653,345),radius=14,fill=panel,outline=(180,80,80),width=3)
    d.text((155,190),"Network unavailable" if v else "Request failed",fill=fg,font=font(30))
    d.text((155,245),"Try again later",fill=fg,font=font(20))
    d.rounded_rectangle((500,285,610,330),radius=8,outline=(110,150,240),width=3)
    return im

def success(v):
    im,d,fg=canvas("Done" if v else "Finished",dark=bool(v))
    if v:
        d.rounded_rectangle((225,150,545,360),radius=28,outline=(80,180,110),width=5)
        d.text((300,215),"SUCCESS",fill=(80,200,120),font=font(34))
    else:
        d.ellipse((W//2-65,145,W//2+65,275),outline=(60,180,100),width=8)
        d.line((W//2-35,210,W//2-5,240),fill=(60,180,100),width=10)
        d.line((W//2-5,240,W//2+45,180),fill=(60,180,100),width=10)
        d.text((300,330),"All set",fill=fg,font=font(28))
    return im

def settings(v):
    im,d,fg=canvas("Preferences" if v else "Account",dark=bool(v))
    labels=["General","Notifications","Security","About"] if v else ["Profile","Language","Privacy","Support"]
    y=105
    for i,label in enumerate(labels):
        d.text((70,y+16),label,fill=fg,font=font(22))
        d.line((60,y+58,700,y+58),fill=(120,125,135),width=1)
        if i%2==0:
            d.ellipse((625,y+15,650,y+40),outline=(90,140,230),width=3)
        y+=85
    return im

def unknown(v):
    im,d,fg=canvas("Editor" if v else "Web page",dark=bool(v))
    if v:
        d.rectangle((45,90,725,455),fill=(20,22,26))
        for i,text in enumerate(["main.ts","function start() {","  return service.run()","}"]):
            d.text((80,125+i*60),text,fill=(190,210,235),font=font(22))
    else:
        d.rounded_rectangle((55,105,710,160),radius=8,fill=(235,237,240))
        d.text((75,118),"https://example.com/article",fill=(80,85,95),font=font(18))
        d.text((85,210),"News article",fill=fg,font=font(32))
        for i in range(6):
            d.line((85,275+i*24,625,275+i*24),fill=(150,155,165),width=7)
    return im

gens={"calendar":calendar,"loading":loading,"error_dialog":error_dialog,"success":success,"settings":settings,"unknown":unknown}
manifest=[]
for label,gen in gens.items():
    for v in range(2):
        name=f"{label}-hard-{v+1}.png"
        gen(v).save(OUT/name)
        manifest.append({"file":name,"expected":label})
(OUT/"manifest.json").write_text(json.dumps(manifest,indent=2),encoding="utf-8")
print(f"generated {len(manifest)} hard samples in {OUT}")
