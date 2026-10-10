# font-symbols — пересобрать client/public/assets/fonts/ITDSymbols-Regular.woff2
# (ITGAME-48): подмножество GNU Unifont под символы строк игры, которых нет в
# Departure Mono. Глифы не меняются; семейство переименовано в «ITD Symbols»
# (OFL п.3: изменённая версия не носит имя исходника), лицензия в name-таблице —
# OFL 1.1 (выбрана из двойной лицензии Unifont). Лицензия рядом: OFL-ITDSymbols.txt.
#
#   uvx --from fonttools --with brotli python client/scripts/font-symbols.py \
#     unifont-16.0.04.otf client/public/assets/fonts/ITDSymbols-Regular.woff2 "⌂⏸▶☣✓✕✖✗"
#
# unifont-16.0.04.otf — https://unifoundry.com/pub/unifont/unifont-16.0.04/font-builds/
# Новый символ в строках игры, которого нет в Departure Mono: добавить в третий
# аргумент, пересобрать, обновить unicode-range в client/index.html и
# FONT_SYMBOLS_TEXT в client/src/render.ts.
import sys
from fontTools import subset
from fontTools.ttLib import TTFont
src, out, chars = sys.argv[1], sys.argv[2], sys.argv[3]
opts = subset.Options()
opts.flavor = 'woff2'
opts.name_IDs = ['*']; opts.name_languages = ['*']; opts.notdef_outline = True
opts.layout_features = []; opts.hinting = False; opts.desubroutinize = True
f = TTFont(src)
s = subset.Subsetter(opts); s.populate(unicodes=[ord(c) for c in chars]); s.subset(f)
fam = 'ITD Symbols'
desc = 'Subset of GNU Unifont 16.0.04 (https://unifoundry.com/unifont/) for IT Director: ' + ' '.join(f'U+{ord(c):04X}' for c in chars)
name = f['name']
for rec in list(name.names):
    if rec.nameID in (1, 4, 16): name.setName(fam, rec.nameID, rec.platformID, rec.platEncID, rec.langID)
    elif rec.nameID in (3,): name.setName('ITDSymbols-Regular;16.0.04-subset', 3, rec.platformID, rec.platEncID, rec.langID)
    elif rec.nameID == 6: name.setName('ITDSymbols-Regular', 6, rec.platformID, rec.platEncID, rec.langID)
name.setName(desc, 10, 3, 1, 0x409)
for rec in list(name.names):
    if rec.nameID == 13: name.setName('This Font Software is licensed under the SIL Open Font License, Version 1.1 (chosen from the Unifont dual license). This license is available with a FAQ at: https://openfontlicense.org', 13, rec.platformID, rec.platEncID, rec.langID)
    elif rec.nameID == 14: name.setName('https://openfontlicense.org', 14, rec.platformID, rec.platEncID, rec.langID)
if 'CFF ' in f:
    cff = f['CFF '].cff; cff.fontNames = ['ITDSymbols-Regular']
    td = cff.topDictIndex[0]
    for k in ('FullName', 'FamilyName'):
        if hasattr(td, k): setattr(td, k, fam)
subset.save_font(f, out, opts)
g = TTFont(out)
print('glyphs', g.getGlyphOrder(), 'cmap', sorted(hex(k) for k in g.getBestCmap()))
for r in g['name'].names:
    if r.platformID == 3: print(r.nameID, r.toUnicode()[:120])
