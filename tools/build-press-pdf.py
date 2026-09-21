#!/usr/bin/env python3
"""Create the press PDF. Requires reportlab, fonttools and brotli.
Run before build-press-kit.py. Text comes from assets/veyago-press-notes.txt.
The PDF adapts the supplied Veyago document system into a short press booklet.
"""
from pathlib import Path
from tempfile import TemporaryDirectory
from xml.sax.saxutils import escape
from fontTools.ttLib import TTFont as Font
from fontTools.varLib.instancer import instantiateVariableFont
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import HexColor
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph
from reportlab.lib.utils import ImageReader
from reportlab.lib.units import mm

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / 'assets'
W, H = 210*mm, 297*mm
LEFT, TOP, COL, SIDE = 20*mm, 24*mm, 118*mm, 44*mm
RIGHT = 148*mm
INK, GREY, RULE, TINT, BLUE = map(HexColor, ['#111315','#6B7075','#E3E5E7','#F2F3F4','#2F6BFF'])
notes = (ASSETS/'veyago-press-notes.txt').read_text()
def description(section, next_section):
    return notes.split('\n'+section+'\n',1)[1].split('\n\n'+next_section+'\n',1)[0].strip()

with TemporaryDirectory() as tmp:
    for weight in [400, 600, 700]:
        f = Font(ASSETS/'fonts/inter-latin.woff2'); f.flavor = None
        f = instantiateVariableFont(f, {'wght':weight, 'opsz':14}, inplace=True)
        for name in f['name'].names:
            if name.nameID in (1, 4, 6): name.string = f'InterPress-{weight}'.encode(name.getEncoding())
        path = str(Path(tmp)/f'inter-{weight}.ttf'); f.save(path)
        pdfmetrics.registerFont(TTFont(f'Inter-{weight}', path))
    f=Font(ASSETS/'fonts/ibm-plex-mono.woff2');f.flavor=None
    path=str(Path(tmp)/'mono.ttf');f.save(path);pdfmetrics.registerFont(TTFont('Plex',path))
    c = canvas.Canvas(str(ASSETS/'veyago-press-kit.pdf'), pagesize=(W,H))
    c.setTitle('Veyago | Press kit | September 2026')
    c.setAuthor('Veyago Inc.')
    def label(text,x,y,color=GREY):
        c.setFillColor(color);c.setFont('Plex',7.5);c.drawString(x,y,text.upper())
    def para(text,x,y,width=COL,size=10,leading=15,font='Inter-400',color=INK):
        style=ParagraphStyle('body',fontName=font,fontSize=size,leading=leading,textColor=color)
        p=Paragraph(escape(text).replace('\n', '<br/>'),style);_,h=p.wrap(width,H);p.drawOn(c,x,y-h);return y-h
    def title(text,y):return para(text,LEFT,y,COL,24,25.92,'Inter-700')-16
    def header(section,page):
        label(section,LEFT,H-TOP,BLUE);label('Veyago · Press kit',RIGHT,H-TOP)
        c.setStrokeColor(RULE);c.line(LEFT,22*mm,W-18*mm,22*mm)
        label('Veyago Inc. · September 2026',LEFT,16*mm);label(f'{page:02d}',W-24*mm,16*mm)
        return H-TOP-35
    def image_fit(file,x,y,w,h):
        im=ImageReader(str(ASSETS/file));iw,ih=im.getSize();s=min(w/iw,h/ih)
        c.drawImage(im,x+(w-iw*s)/2,y-h+(h-ih*s)/2,iw*s,ih*s,mask='auto')
    def note(text,y):
        style=ParagraphStyle('note',fontName='Inter-400',fontSize=10,leading=15,textColor=INK)
        p=Paragraph(escape(text).replace('\n', '<br/>'),style);_,h=p.wrap(COL-24,H)
        c.setFillColor(TINT);c.roundRect(LEFT,y-h-46,COL,h+46,5,fill=1,stroke=0)
        label('For the record',LEFT+12,y-18);p.drawOn(c,LEFT+12,y-32-h)
    # Cover: dark ground, restrained labels, no invented company metrics.
    c.setFillColor(INK);c.rect(0,0,W,H,fill=1,stroke=0)
    white=HexColor('#FFFFFF')
    label('Veyago Inc.',LEFT,H-TOP,white)
    for i in range(3):c.setFillColor(BLUE if i==2 else GREY);c.circle(W-29*mm+i*5*mm,H-TOP+2,2.3,fill=1,stroke=0)
    label('Press & media',LEFT,H-75*mm,BLUE)
    y=para('Independent software.\nUseful by design.',LEFT,H-90*mm,150*mm,30,32.4,'Inter-700',white)
    para('The studio behind Kept and Veyago travel. Company facts, product descriptions, and images for your story.',LEFT,y-22,COL,11.5,16.1,color=white)
    label('Prepared for · Journalists & editors',LEFT,66*mm,white)
    label('September 2026',LEFT,54*mm,white)
    label('By Veyago Inc.',LEFT,42*mm,white)
    para('hello@veyago.cloud · www.veyago.cloud',LEFT,28*mm,155*mm,9,12.6,color=white)
    c.linkURL('https://www.veyago.cloud/company/#press',(LEFT,20*mm,LEFT+150*mm,30*mm),relative=0)
    c.showPage()
    # Studio and shipped product.
    y=header('01 · The studio & Kept',2)
    y=title('A small studio building software for everyday life.',y)
    y=para('Privacy-first apps and fast, hand-written websites for small businesses.',LEFT,y,COL,11.5,16.1)-22
    y=para(description('COMPANY','KEPT'),LEFT,y)-26
    y=para('Kept puts the next deadline first.',LEFT,y,COL,14,16.8,'Inter-600')-12
    y=para(description('KEPT','VEYAGO TRAVEL'),LEFT,y)-22
    note('Kept is available now. Veyago travel is a separate product in development.',y)
    label('Founded',RIGHT,H-61*mm);para('28 April 2026',RIGHT,H-66*mm,SIDE,9,12.6)
    label('Company',RIGHT,H-82*mm);para('New York C-Corporation. Founder & CEO: Cassian Drefke.',RIGHT,H-87*mm,SIDE,9,12.6)
    image_fit('kept-screen-upcoming.png',RIGHT,H-115*mm,SIDE,100*mm)
    para('Kept · Upcoming items',RIGHT,H-220*mm,SIDE,9,12.6,color=GREY)
    para('Product details: www.veyago.cloud/kept/',LEFT,48*mm,COL,9,12.6,color=GREY)
    c.linkURL('https://www.veyago.cloud/kept/',(LEFT,38*mm,LEFT+COL,50*mm),relative=0)
    c.showPage()
    # Travel: distinguish planned capabilities from availability.
    y=header('02 · Veyago travel',3)
    y=title('The journey starts with choosing where to go.',y)
    y=para('A travel app in development for people planning alone or deciding together.',LEFT,y,COL,11.5,16.1)-22
    y=para(description('VEYAGO TRAVEL','QUICK FACTS'),LEFT,y)-28
    y=para('A decision before an itinerary.',LEFT,y,COL,14,16.8,'Inter-600')-12
    y=para('The Bracket is the starting point: compare destinations, narrow the choices, and arrive at one shared answer. The planned itinerary and wellbeing features build on that decision.',LEFT,y)-24
    note('Launch is planned for Q4 2026. These images show a product in development; features and timing may change.',y)
    label('Planned launch',RIGHT,H-61*mm);para('Q4 2026',RIGHT,H-66*mm,SIDE,20,24,'Inter-700')
    label('Platforms',RIGHT,H-85*mm);para('iOS & Android',RIGHT,H-90*mm,SIDE,9,12.6)
    image_fit('veyago-bracket.jpg',RIGHT,H-115*mm,SIDE,100*mm)
    para('Veyago travel · Article preview',RIGHT,H-220*mm,SIDE,9,12.6,color=GREY)
    para('Product details: www.veyago.cloud/veyago/',LEFT,48*mm,COL,9,12.6,color=GREY)
    c.linkURL('https://www.veyago.cloud/veyago/',(LEFT,38*mm,LEFT+COL,50*mm),relative=0)
    c.showPage()
    # Assets and colophon.
    y=header('03 · Assets & contact',4)
    y=title('The people and pictures behind the story.',y)
    y=para('The downloadable kit brings the source images and ready-to-use copy together.',LEFT,y,COL,11.5,16.1)-24
    for heading,body in [('Brand artwork','Veyago icon and vector mark, Kept vector icon, and the studio social image.'),('Product images','Kept: upcoming items, items, and insights. Veyago travel: Discover and article previews, plus a travel photograph.'),('Press enquiries','For interviews, product questions, image credits, or additional assets: hello@veyago.cloud.')]:
        y=para(heading,LEFT,y,COL,14,16.8,'Inter-600')-9
        body_top = y
        y=para(body,LEFT,y)-20
        if heading == 'Press enquiries':
            c.linkURL('mailto:hello@veyago.cloud',(LEFT,y+20,LEFT+COL,body_top),relative=0)
    y=para('About this edition',LEFT,y,COL,14,16.8,'Inter-600')-10
    y=para('Prepared by Veyago Inc. on 18 September 2026 from the existing studio and product pages. This edition updates the legacy press kit’s contact details and planned travel launch date, and adds Kept images and a founder portrait. No new traction or funding figures have been introduced.',LEFT,y,COL,9,12.6)-14
    y=para('Set in Inter and IBM Plex Mono, using the Veyago document system. Refresh the descriptions and asset captions when product availability changes. Veyago Inc. · New York.',LEFT,y,COL,9,12.6,color=GREY)
    image_fit('cassian-drefke.png',RIGHT,H-62*mm,SIDE,56*mm)
    para('Cassian Drefke\nFounder & CEO',RIGHT,H-122*mm,SIDE,9,12.6,color=GREY)
    label('Full kit',RIGHT,H-152*mm)
    para('Logos, portrait, product images, press notes, and this PDF.',RIGHT,H-158*mm,SIDE,9,12.6)
    c.showPage();c.save()
print('Built assets/veyago-press-kit.pdf (4 pages)')
