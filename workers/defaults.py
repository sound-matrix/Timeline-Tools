"""Submit-time defaults. Same canonical JSON as lib/defaults.ts; no UI selection."""
import copy
import json
from pathlib import Path
CONFIG = json.loads(Path(__file__).with_name('defaults.json').read_text())
DEFAULTS, STAGES = CONFIG['defaults'], CONFIG['stages']

def merge(base, partial):
    result = copy.deepcopy(base)
    for key, value in partial.items():
        result[key] = merge(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else copy.deepcopy(value)
    return result

def with_defaults(kind, partial=None):
    if partial is None: partial = {}
    if not isinstance(partial, dict): return partial
    if kind == 'clean' and 'strength' in partial: return partial
    p = copy.deepcopy(partial)
    if kind == 'studio_export':
        formats = p.get('formats', DEFAULTS['export']['formats'])
        if formats == []: formats = DEFAULTS['export']['formats']
        p['formats'] = formats
        base = dict(formats=formats, subtitles=[], missing_lines='exclude')
        if isinstance(formats, list):
            for fmt in formats:
                if fmt in ('mp3','wav'): base[fmt] = DEFAULTS['export'][fmt]
        return merge(base, p)
    if kind not in DEFAULTS or kind == 'export': return partial
    base = DEFAULTS[kind]
    if kind == 'subtitles' and p.get('formats') == []: del p['formats']
    if kind in ('clean','master'):
        keys = ['noise','hum','reverb'] if kind == 'clean' else ['loudness','limiter','compressor','eq']
        selected = any(isinstance(p.get(k),dict) and p[k].get('enabled') is True for k in keys) or (kind == 'clean' and p.get('voice') is True)
        if not selected and all(k not in p or p[k] == {'enabled':False} for k in keys) and p.get('voice',False) is False:
            for k in keys + (['voice'] if kind == 'clean' else []): p.pop(k,None)
    result = merge(base,p)
    for key,value in p.items():
        if key not in STAGES or not isinstance(value,dict): continue
        enabled = value.get('enabled',base.get(key,{}).get('enabled',False))
        result[key] = merge({'enabled':False},{k:v for k,v in value.items() if k=='enabled' or v != []}) if enabled is False else merge(STAGES[key],value)
        if key == 'subtitles' and result[key].get('enabled') is True and result[key].get('formats') == []: result[key]['formats'] = ['srt']
    eq=result.get('eq')
    if isinstance(eq,dict) and eq.get('enabled') is True and isinstance(eq.get('bands'),list):
        bands=eq['bands']
        eq['bands']=copy.deepcopy(STAGES['eq']['bands']) if all(b=={'enabled':False} for b in bands) else [merge({'gain':0},b) if isinstance(b,dict) and b.get('enabled') is True else b for b in bands]
    if kind == 'studio' and result.get('has_bed') is True:
        result.setdefault('ducking_db',12); result.setdefault('bed_fit','trim')
    return result
