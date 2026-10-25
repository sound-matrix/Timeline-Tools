"""Explicit export choices; no coercion or defaults."""
def validate_export(s):
    if not isinstance(s,dict) or set(s)-{'revision','formats','mp3','wav','subtitles','missing_lines'}: raise ValueError('Invalid export')
    if type(s.get('revision')) is not int or s['revision']<1: raise ValueError('Invalid revision')
    f=s.get('formats'); subs=s.get('subtitles')
    if not isinstance(f,list) or not 1<=len(f)<=2 or len(set(f))!=len(f) or any(v not in ('mp3','wav') for v in f): raise ValueError('Choose formats')
    if not isinstance(subs,list) or len(subs)>2 or len(set(subs))!=len(subs) or any(v not in ('srt','vtt') for v in subs) or s.get('missing_lines') not in ('exclude','mark'): raise ValueError('Choose subtitles')
    for fmt in ('mp3','wav'):
        if (fmt in f)!=(fmt in s): raise ValueError('Choose format settings')
        if fmt not in f: continue
        o=s[fmt]
        if not isinstance(o,dict): raise ValueError('Invalid format settings')
        if fmt=='mp3':
            if set(o)!={'bitrate_kbps','sample_rate'} or type(o['bitrate_kbps']) is not int or o['bitrate_kbps'] not in (128,192,256,320) or type(o['sample_rate']) is not int or o['sample_rate'] not in (44100,48000): raise ValueError('Invalid MP3')
        elif set(o)!={'bit_depth','sample_rate'} or o['bit_depth'] not in (16,24,'32f') or isinstance(o['bit_depth'],bool) or type(o['sample_rate']) is not int or o['sample_rate'] not in (44100,48000,96000): raise ValueError('Invalid WAV')


def apply_inserts(samples, slots, rate=48000, tempo=120):
    from workers.editor_dsp import InsertChain, validate_slots
    validate_slots(slots)
    if samples is None or not slots:return samples
    return InsertChain(slots,rate,tempo).process(samples)
