/** Source of render.py shipped in the external execution bundle (kept as a string so it needs no extra loader). */
export const RENDER_PY = String.raw`#!/usr/bin/env python3
"""
VierApparatus DCE - external renderer (Pillow).

Reads the SAME .njs design file and a data.json exported by DCE and writes PNG/JPEG files.
It is a compatible *subset* renderer: see README.md for what is and is not supported.

    python render.py --template template.njs --data data.json --out out --format png --workers 4
"""
import argparse, json, math, os, re, sys, time, unicodedata
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

HERE = Path(__file__).resolve().parent
SS = 3  # supersampling for shapes

# ---------------------------------------------------------------- safe expressions (no eval)
TOKEN = re.compile(r'\s*(?:(\d+(?:\.\d+)?)|"((?:[^"\\]|\\.)*)"|\'((?:[^\'\\]|\\.)*)\'|([A-Za-z_][A-Za-z0-9_.]*)|(&&|\|\||==|!=|<=|>=|<|>|!|\(|\)|,))')

def lookup(scope, path):
    cur = scope
    for part in path.split('.'):
        if part in ('__proto__', 'constructor', 'prototype'):
            return None
        if isinstance(cur, dict) and part in cur:
            cur = cur[part]
        else:
            return None
    return cur

def is_empty(v):
    return v is None or v == '' or (isinstance(v, list) and len(v) == 0)

def truthy(v):
    return not (is_empty(v) or v is False or v == 0 or v in ('0', 'false'))

def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None

def cmp(a, b):
    na, nb = num(a), num(b)
    if na is not None and nb is not None:
        return (na > nb) - (na < nb)
    sa, sb = '' if a is None else str(a), '' if b is None else str(b)
    return (sa > sb) - (sa < sb)

def tokenize(src):
    pos, out = 0, []
    while pos < len(src):
        if src[pos:].strip() == '':
            break
        m = TOKEN.match(src, pos)
        if not m:
            raise ValueError('bad expression: ' + src)
        pos = m.end()
        if m.group(1) is not None: out.append(('num', float(m.group(1))))
        elif m.group(2) is not None: out.append(('str', m.group(2)))
        elif m.group(3) is not None: out.append(('str', m.group(3)))
        elif m.group(4) is not None: out.append(('id', m.group(4)))
        else: out.append(('op', m.group(5)))
    return out

def eval_expr(src, scope):
    toks = tokenize(src)
    i = [0]
    def peek(): return toks[i[0]] if i[0] < len(toks) else (None, None)
    def eat(): t = toks[i[0]]; i[0] += 1; return t
    def is_op(v): return peek() == ('op', v)
    def word(w): return peek() == ('id', w)
    def p_or():
        l = p_and()
        while is_op('||') or word('or'):
            eat(); r = p_and(); l = truthy(l) or truthy(r)
        return l
    def p_and():
        l = p_not()
        while is_op('&&') or word('and'):
            eat(); r = p_not(); l = truthy(l) and truthy(r)
        return l
    def p_not():
        if is_op('!') or word('not'):
            eat(); return not truthy(p_not())
        return p_cmp()
    def p_cmp():
        l = p_prim()
        t = peek()
        if t[0] == 'op' and t[1] in ('==', '!=', '<', '<=', '>', '>='):
            eat(); r = p_prim()
            if t[1] in ('==', '!='):
                eq = (is_empty(l) and is_empty(r)) or (not is_empty(l) and not is_empty(r) and cmp(l, r) == 0)
                return eq if t[1] == '==' else not eq
            if is_empty(l): return False
            c = cmp(l, r)
            return {'<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0}[t[1]]
        if word('contains'):
            eat(); r = p_prim()
            if isinstance(l, list): return any(cmp(x, r) == 0 for x in l)
            return str(r or '').lower() in str(l or '').lower()
        return l
    def p_prim():
        t = eat()
        if t[0] in ('num', 'str'): return t[1]
        if t[0] == 'id':
            if t[1] == 'true': return True
            if t[1] == 'false': return False
            if t[1] == 'null': return None
            if is_op('('):
                eat(); args = []
                if not is_op(')'):
                    args.append(p_or())
                    while is_op(','): eat(); args.append(p_or())
                eat()
                a = args[0] if args else None
                return {'exists': lambda: not is_empty(a), 'empty': lambda: is_empty(a),
                        'len': lambda: len(a) if isinstance(a, list) else len(str(a or '')),
                        'lower': lambda: str(a or '').lower(), 'upper': lambda: str(a or '').upper(),
                        'number': lambda: num(a) or 0}[t[1]]()
            return lookup(scope, t[1])
        if t == ('op', '('):
            v = p_or(); eat(); return v
        raise ValueError('bad expression: ' + src)
    return truthy(p_or())

# ---------------------------------------------------------------- bindings
TOK = re.compile(r'\{\{\s*([^{}]+?)\s*\}\}')
MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split()

def slugify(s):
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')[:80]

def fmt(v):
    if v is None: return ''
    if isinstance(v, list): return ', '.join(fmt(x) for x in v)
    if isinstance(v, bool): return 'true' if v else 'false'
    if isinstance(v, float) and v.is_integer(): return str(int(v))
    return str(v)

def apply_filter(val, raw, name, arg):
    if name == 'upper': return val.upper()
    if name == 'lower': return val.lower()
    if name == 'title': return re.sub(r'\w\S*', lambda m: m.group(0)[0].upper() + m.group(0)[1:].lower(), val)
    if name == 'trim': return val.strip()
    if name == 'slug': return slugify(val)
    if name == 'truncate':
        n = int(arg or 0)
        return val[:max(0, n - 1)].rstrip() + '…' if n > 0 and len(val) > n else val
    if name == 'default': return arg or '' if val == '' else val
    if name == 'number':
        n = num(raw)
        return f'{n:,.{int(arg or 0)}f}' if n is not None else val
    if name == 'date':
        m = re.match(r'(\d{4})-(\d{2})-(\d{2})', val)
        return f'{int(m.group(3))} {MONTHS[int(m.group(2)) - 1]} {m.group(1)}' if m else val
    return val

def render_tpl(tpl, scope, defaults):
    missing, tokens = [], [0]
    def sub(m):
        tokens[0] += 1
        parts = [p.strip() for p in m.group(1).split('|')]
        raw = lookup(scope, parts[0])
        if is_empty(raw) and parts[0] in defaults: raw = defaults[parts[0]]
        if is_empty(raw): missing.append(parts[0])
        out = fmt(raw)
        for f in parts[1:]:
            name, _, arg = f.partition(':')
            out = apply_filter(out, raw, name.strip(), arg)
        return out
    return TOK.sub(sub, tpl), missing, tokens[0]

def color(v, default=None):
    if not isinstance(v, str) or v in ('none', 'transparent', ''): return default
    return v

# ---------------------------------------------------------------- fonts / text
_font_cache = {}
FONT_FILES = None

def find_font_file(family, bold):
    global FONT_FILES
    if FONT_FILES is None:
        FONT_FILES = [p for d in (HERE / 'fonts', HERE) for p in d.glob('*.ttf')] + [p for d in (HERE / 'fonts', HERE) for p in d.glob('*.otf')]
    fam = family.lower().replace(' ', '')
    cands = [p for p in FONT_FILES if p.stem.lower().replace(' ', '').startswith(fam)]
    return cands[0] if cands else None

def get_font(family, size, weight):
    key = (family, round(size * 2), weight)
    if key in _font_cache: return _font_cache[key]
    path = find_font_file(family, weight >= 600)
    f = None
    if path:
        try:
            f = ImageFont.truetype(str(path), max(1, round(size)))
            try: f.set_variation_by_axes([weight])
            except Exception: pass
        except Exception: f = None
    if f is None:
        try: f = ImageFont.truetype('DejaVuSans-Bold.ttf' if weight >= 600 else 'DejaVuSans.ttf', max(1, round(size)))
        except Exception: f = ImageFont.load_default(max(1, round(size)))
    _font_cache[key] = f
    return f

def wrap(text, font, maxw):
    out = []
    for para in re.split(r'\r?\n', text):
        if para == '': out.append(''); continue
        line = ''
        for word in [w for w in para.split(' ') if w]:
            cand = (line + ' ' + word) if line else word
            if font.getlength(cand) <= maxw: line = cand; continue
            if line: out.append(line); line = ''
            if font.getlength(word) <= maxw: line = word; continue
            chunk = ''
            for ch in word:
                if chunk and font.getlength(chunk + ch) > maxw: out.append(chunk); chunk = ch
                else: chunk += ch
            line = chunk
        out.append(line)
    return out

def ellipsize(line, font, maxw):
    s = re.sub(r'[\s.,;:!?-]+$', '', line)
    while s and font.getlength(s + '…') > maxw: s = s[:-1].rstrip()
    return s + '…'

def layout_text(text, st, cons, w, h):
    policy = cons.get('overflow', 'multiline')
    base = st.get('fontSize', 32)
    fam, wt, lh = st.get('fontFamily', 'Jost'), st.get('fontWeight', 400), st.get('lineHeight', 1.2)
    if not text.strip(): return None if policy == 'hide' else ([], base)
    mc = cons.get('maxChars')
    if mc and len(text) > mc:
        if policy == 'hide': return None
        text = text[:max(1, mc - 1)].rstrip() + '…'
    max_lines = cons.get('maxLines') or math.inf
    def cap(size):
        by_h = max(1, int(h / (size * lh) + 1e-6)) if policy not in ('multiline', 'expand') else math.inf
        return min(max_lines, by_h)
    def attempt(size):
        lines = wrap(text, get_font(fam, size, wt), w)
        return lines, len(lines) <= cap(size)
    def clamp(size, lines):
        c = cap(size)
        if len(lines) <= c: return lines
        lines = lines[:int(c)]
        lines[-1] = ellipsize(lines[-1], get_font(fam, size, wt), w)
        return lines
    if policy == 'auto_shrink':
        hi = cons.get('maxFontSize') or base
        lo = min(cons.get('minFontSize') or max(6, round(hi * 0.4)), hi)
        lines, ok = attempt(hi)
        if ok: return lines, hi
        a, b, best = round(lo * 2), round(hi * 2), round(lo * 2)
        while a <= b:
            mid = (a + b) // 2
            if attempt(mid / 2)[1]: best, a = mid, mid + 1
            else: b = mid - 1
        size = best / 2
        lines, ok = attempt(size)
        return (lines if ok else clamp(size, lines)), size
    lines, _ = attempt(base)
    if policy == 'hide':
        return (lines, base) if len(lines) <= cap(base) else None
    if policy == 'truncate' or max_lines != math.inf:
        lines = clamp(base, lines)
    return lines, base

# ---------------------------------------------------------------- drawing
def poly(w, h, sides):
    return [(w / 2 + w / 2 * math.cos(-math.pi / 2 + 2 * math.pi * i / sides), h / 2 + h / 2 * math.sin(-math.pi / 2 + 2 * math.pi * i / sides)) for i in range(sides)]

def star(w, h, pts, inner):
    out = []
    for i in range(pts * 2):
        a, r = -math.pi / 2 + math.pi * i / pts, (1 if i % 2 == 0 else inner)
        out.append((w / 2 + w / 2 * r * math.cos(a), h / 2 + h / 2 * r * math.sin(a)))
    return out

def path_pts(n, W, H):
    # flatten the Bezier path (anchors + optional handles, all normalised to the box) into a polyline
    p = n.get('path', {}); pts = p.get('points', []); hs = p.get('handles') or []
    if len(pts) < 2: return []
    closed = bool(p.get('closed'))
    A = lambda i: (pts[i][0] * W, pts[i][1] * H)
    out = [A(0)]
    for i in range(len(pts) if closed else len(pts) - 1):
        j = (i + 1) % len(pts)
        a, b = A(i), A(j)
        ho = hs[i] if i < len(hs) else None
        hi = hs[j] if j < len(hs) else None
        if not ho and not hi:
            out.append(b); continue
        c1 = (ho[2] * W, ho[3] * H) if ho else a
        c2 = (hi[0] * W, hi[1] * H) if hi else b
        for k in range(1, 17):
            t = k / 16; u = 1 - t
            out.append((u**3 * a[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t**3 * b[0],
                        u**3 * a[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t**3 * b[1]))
    return out[:-1] if closed and len(out) > 2 else out

def draw_shape(layer_size, n, fill, stroke, sw):
    w, h = layer_size
    big = Image.new('RGBA', (max(1, w * SS), max(1, h * SS)), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    st = n.get('style', {})
    t = n['type']
    f = fill; s = stroke if stroke and sw > 0 else None
    W, H = w * SS, h * SS
    if t == 'rect':
        r = min(st.get('cornerRadius', 0), w / 2, h / 2) * SS
        d.rounded_rectangle([0, 0, W - 1, H - 1], radius=r, fill=f, outline=s, width=int(sw * SS) if s else 0)
    elif t == 'ellipse':
        d.ellipse([0, 0, W - 1, H - 1], fill=f, outline=s, width=int(sw * SS) if s else 0)
    elif t == 'line':
        d.line([(0, H / 2), (W, H / 2)], fill=s or f, width=max(1, int((sw or 2) * SS)))
    elif t in ('polygon', 'star'):
        pts = poly(W, H, max(3, int(n.get('sides', 6)))) if t == 'polygon' else star(W, H, max(3, int(n.get('points', 5))), n.get('innerRatio', 0.45))
        d.polygon(pts, fill=f, outline=s, width=int(sw * SS) if s else 0)
    elif t == 'path':
        pts = path_pts(n, W, H)
        if len(pts) >= 2:
            if n['path'].get('closed') and f: d.polygon(pts, fill=f)
            d.line(pts + ([pts[0]] if n['path'].get('closed') else []), fill=s or f, width=max(1, int((sw or 2) * SS)), joint='curve')
    return big.resize((w, h), Image.LANCZOS)

def rounded_mask(w, h, r):
    if r <= 0: return Image.new('L', (w, h), 255)
    m = Image.new('L', (w * SS, h * SS), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w * SS - 1, h * SS - 1], radius=r * SS, fill=255)
    return m.resize((w, h), Image.LANCZOS)

def fit_image(im, w, h, fit, fx, fy):
    iw, ih = im.size
    if fit == 'fill': return im.resize((w, h), Image.LANCZOS)
    layer = Image.new('RGBA', (w, h), (0, 0, 0, 0))
    if fit == 'contain':
        s = min(w / iw, h / ih); nw, nh = max(1, round(iw * s)), max(1, round(ih * s))
        layer.paste(im.resize((nw, nh), Image.LANCZOS), ((w - nw) // 2, (h - nh) // 2)); return layer
    if fit == 'crop':
        layer.paste(im, (round((w - iw) * fx), round((h - ih) * fy))); return layer
    s = max(w / iw, h / ih); nw, nh = max(1, round(iw * s)), max(1, round(ih * s))
    layer.paste(im.resize((nw, nh), Image.LANCZOS), (round((w - nw) * fx), round((h - nh) * fy)))
    return layer

class Ctx:
    def __init__(self, data, doc, bundle):
        self.scope = data; self.bundle = bundle; self.issues = []
        self.defaults = {p['key']: p['default_value'] for p in doc.get('placeholders', []) if p.get('default_value') not in (None, '')}
        self.required = {p['key'] for p in doc.get('placeholders', []) if p.get('required')}

def load_asset(ref, ctx):
    if not ref: return None
    p = ctx.bundle / 'assets'
    for cand in list(p.glob(ref + '.*')) + list(p.glob(ref)):
        try: return Image.open(cand).convert('RGBA')
        except Exception: pass
    return None

def visible(n, ctx):
    ex = (n.get('binding') or {}).get('visible', {}).get('expr')
    if not ex: return True
    try: return eval_expr(ex, ctx.scope)
    except Exception: return True

def render_node(canvas, n, ctx, parent_opacity):
    if not n.get('visible', True) or not visible(n, ctx): return
    if n['type'] == 'group':
        for c in n.get('children', []): render_node(canvas, c, ctx, parent_opacity * n.get('opacity', 1))
        return
    st, cons, b = n.get('style', {}), n.get('constraints') or {}, n.get('binding') or {}
    w, h = max(1, round(n['width'])), max(1, round(n['height']))
    op = parent_opacity * n.get('opacity', 1)
    layer = None
    t = n['type']
    if t == 'text':
        tpl = (b.get('text') or {}).get('template', n.get('text', ''))
        text, missing, ntok = render_tpl(tpl, ctx.scope, ctx.defaults)
        fb = (b.get('text') or {}).get('fallback') or cons.get('fallbackText')
        for k in missing:
            if k in ctx.required and not fb: raise ValueError('Required value %s is missing for "%s"' % (k, n.get('name')))
        if fb and (text.strip() == '' or (missing and len(missing) == ntok)): text = fb
        pad = st.get('padding', 0)
        res = layout_text(text, st, cons, max(1, w - 2 * pad), max(1, h - 2 * pad))
        if res is None: return
        lines, size = res
        lh = size * st.get('lineHeight', 1.2)
        eh = h
        if cons.get('overflow') == 'expand': eh = max(h, round(len(lines) * lh + 2 * pad))
        layer = Image.new('RGBA', (w, eh), (0, 0, 0, 0)); d = ImageDraw.Draw(layer)
        font = get_font(st.get('fontFamily', 'Jost'), size, st.get('fontWeight', 400))
        col = color(lookup(ctx.scope, b['fill']['key']) if b.get('fill') else st.get('fill'), '#231F20')
        inner = eh - 2 * pad; content = len(lines) * lh
        va = st.get('verticalAlign', 'top')
        y0 = pad + (0 if va == 'top' else (inner - content) / 2 if va == 'middle' else inner - content)
        al = st.get('textAlign', 'left')
        x = pad if al == 'left' else w / 2 if al == 'center' else w - pad
        anchor = {'left': 'lm', 'center': 'mm', 'right': 'rm'}[al]
        for i, line in enumerate(lines):
            y = y0 + i * lh + lh / 2
            d.text((x, y), line, font=font, fill=col, anchor=anchor)
            if st.get('decoration', 'none') != 'none' and line:
                lw = font.getlength(line); x0 = x if al == 'left' else x - lw / 2 if al == 'center' else x - lw
                yy = y + (size * 0.42 if st['decoration'] == 'underline' else 0)
                d.line([(x0, yy), (x0 + lw, yy)], fill=col, width=max(1, round(size / 14)))
        h = eh
    elif t in ('image', 'frame'):
        ib = b.get('image'); ref = None
        if ib:
            v = lookup(ctx.scope, ib['key']); ref = fmt(v[0] if isinstance(v, list) and v else v) if not is_empty(v) else None
            ref = ref or ib.get('fallback')
        else:
            ref = (n.get('src') or {}).get('assetId')
        im = load_asset(ref, ctx) or load_asset(cons.get('fallbackAssetId'), ctx)
        if im is None:
            if cons.get('missing', 'placeholder' if t == 'frame' else 'hide') == 'error': raise ValueError('Image missing for "%s"' % n.get('name'))
            if cons.get('missing', 'placeholder' if t == 'frame' else 'hide') == 'hide': return
            layer = Image.new('RGBA', (w, h), (232, 237, 243, 255))
        else:
            layer = fit_image(im, w, h, cons.get('fit', 'cover'), cons.get('focalX', 0.5), cons.get('focalY', 0.5))
        r = st.get('cornerRadius', 0)
        if r: layer.putalpha(Image.composite(layer.getchannel('A'), Image.new('L', (w, h), 0), rounded_mask(w, h, min(r, w / 2, h / 2))))
    elif t == 'plugin':
        return  # render plugins are browser-only (see README)
    else:
        fill = color(st.get('fill'))
        if b.get('fill'):
            v = lookup(ctx.scope, b['fill']['key']); fill = color(v if not is_empty(v) else b['fill'].get('fallback'), fill)
        layer = draw_shape((w, h), n, fill, color(st.get('stroke')), st.get('strokeWidth', 0))
    if layer is None: return
    if op < 1: layer.putalpha(layer.getchannel('A').point(lambda a: int(a * op)))
    rot = n.get('rotation', 0)
    cx, cy = n['x'] + n['width'] / 2, n['y'] + h / 2
    if rot:
        layer = layer.rotate(-rot, expand=True, resample=Image.BICUBIC)
    paste(canvas, layer, round(cx - layer.width / 2), round(cy - layer.height / 2))

def paste(canvas, layer, x, y):
    # clipped alpha composite
    cw, ch = canvas.size
    sx, sy = max(0, -x), max(0, -y)
    ex, ey = min(layer.width, cw - x), min(layer.height, ch - y)
    if ex <= sx or ey <= sy: return
    canvas.alpha_composite(layer.crop((sx, sy, ex, ey)), dest=(x + sx, y + sy))

def fname(pattern, scope, idx, ext):
    def sub(m):
        parts = [p.strip() for p in m.group(1).split('|')]
        mi = re.match(r'(?:batch\.)?index(?::(\d+))?$', parts[0])
        if mi: return str(idx).zfill(int(mi.group(1) or 3))
        out = fmt(lookup(scope, parts[0]))
        for f in parts[1:]:
            name, _, arg = f.partition(':'); out = apply_filter(out, out, name, arg)
        return out
    name = TOK.sub(sub, pattern)
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '-', name).strip().lstrip('.') or 'record-%03d' % idx
    name = re.sub(r'\.(png|jpe?g)$', '', name, flags=re.I)
    return name + '.' + ext

def render_one(args):
    doc, rec, idx, total, out_dir, fmt_, pattern, bundle, quality = args
    try:
        scope = {'content': rec.get('content', {}), 'template': rec.get('template', {}), 'batch': {'index': idx, 'total': total}}
        for p in doc.get('placeholders', []):
            if p['key'].startswith('template.') and p['key'][9:] not in scope['template'] and p.get('default_value') is not None:
                scope['template'][p['key'][9:]] = p['default_value']
        W, H = int(doc['canvas']['width']), int(doc['canvas']['height'])
        bg = color(doc['canvas'].get('background'))
        canvas = Image.new('RGBA', (W, H), bg if bg else (0, 0, 0, 0))
        ctx = Ctx(scope, doc, bundle)
        for n in doc['nodes']: render_node(canvas, n, ctx, 1)
        ext = 'jpg' if fmt_ == 'jpeg' else fmt_
        name = fname(pattern, scope, idx, ext)
        path = Path(out_dir) / name
        if fmt_ == 'jpeg':
            flat = Image.new('RGB', canvas.size, 'white'); flat.paste(canvas, mask=canvas.getchannel('A')); flat.save(path, quality=int(quality * 100))
        else: canvas.save(path)
        return (idx, name, None)
    except Exception as e:
        return (idx, None, '%s: %s' % (type(e).__name__, e))

def main():
    ap = argparse.ArgumentParser(description='DCE external renderer')
    ap.add_argument('--template', default=str(HERE / 'template.njs'))
    ap.add_argument('--data', default=str(HERE / 'data.json'))
    ap.add_argument('--out', default=str(HERE / 'out'))
    ap.add_argument('--format', choices=['png', 'jpeg'], default='png')
    ap.add_argument('--pattern', default='{{content.slug}}')
    ap.add_argument('--quality', type=float, default=0.92)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) - 1))
    a = ap.parse_args()
    doc = json.loads(Path(a.template).read_text(encoding='utf-8'))
    if doc.get('format') != 'vierapparatus-dce': sys.exit('Not a DCE template')
    data = json.loads(Path(a.data).read_text(encoding='utf-8'))
    recs = data['records'] if isinstance(data, dict) else data
    if a.limit: recs = recs[:a.limit]
    Path(a.out).mkdir(parents=True, exist_ok=True)
    jobs = [(doc, r, i + 1, len(recs), a.out, a.format, a.pattern, HERE, a.quality) for i, r in enumerate(recs)]
    t0 = time.time(); ok = 0; failed = []
    manifest = []
    if a.workers > 1 and len(jobs) > 1:
        with ProcessPoolExecutor(max_workers=a.workers) as ex: results = list(ex.map(render_one, jobs, chunksize=4))
    else: results = [render_one(j) for j in jobs]
    for idx, name, err in results:
        rid = recs[idx - 1].get('content', {}).get('id', '')
        if err: failed.append((idx, err)); manifest.append({'filename': None, 'record_id': rid, 'status': 'failed', 'error': err})
        else: ok += 1; manifest.append({'filename': name, 'record_id': rid, 'status': 'ok'})
    (Path(a.out) / 'manifest.json').write_text(json.dumps({'template_id': doc['meta']['id'], 'entries': manifest}, indent=2), encoding='utf-8')
    dt = time.time() - t0
    print('Rendered %d/%d in %.2fs (%.1f/s). Failures: %d' % (ok, len(recs), dt, ok / dt if dt else 0, len(failed)))
    for i, e in failed[:20]: print('  record %d: %s' % (i, e))
    sys.exit(1 if failed else 0)

if __name__ == '__main__':
    main()
`;
