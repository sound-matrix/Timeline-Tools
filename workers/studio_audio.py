"""Script-driven Studio. Probe -> language gate -> prepare -> ASR -> match -> arrange.

No guide is read, no time stretching. ASR models are lazy-loaded and test-injectable.
"""
import json
import math
from numbers import Real
import re
import unicodedata
import zipfile
from pathlib import Path
from types import SimpleNamespace
from workers.audio import duration, ffmpeg, master, run, write_subtitles
MAX_BYTES = 250 * 1024 * 1024
MEDIA = {'wav','mp3','m4a','flac','aac','ogg','mp4','mov','mkv','webm'}
NOTE = 'script-match-v1: text similarity, speaker evidence and monotonic clip order. Review low-confidence and missing lines. No time-stretch.'

class LanguageMismatch(ValueError):
    def __init__(self, detail):
        super().__init__('language_mismatch')
        self.detail = detail

def validate_studio(s):
    if not isinstance(s, dict): return False
    keys = {'line_gap_ms','match_strictness','dialogue_lufs','master_lufs','has_bed','room_tone','subtitles'}
    if s.get('has_bed') is True: keys |= {'ducking_db','bed_fit'}
    if set(s)-{'region_mode'} != keys or s.get('region_mode','whole_clip') not in ('whole_clip','split_by_line') or type(s.get('has_bed')) is not bool: return False
    def num(v,lo,hi): return type(v) in (int,float) and math.isfinite(v) and lo <= v <= hi
    room,sub = s['room_tone'],s['subtitles']
    return (type(s['line_gap_ms']) is int and num(s['line_gap_ms'],0,5000)
      and s['match_strictness'] in ('strict','normal','loose')
      and num(s['dialogue_lufs'],-70,-5) and num(s['master_lufs'],-70,-5)
      and (not s['has_bed'] or num(s['ducking_db'],0,40) and s['bed_fit'] in ('trim','loop','extend'))
      and isinstance(room,dict) and (type(room.get('enabled')) is bool and room=={'enabled':False} or set(room)=={'enabled','amount'} and room['enabled'] is True and num(room['amount'],0,100))
      and isinstance(sub,dict) and (type(sub.get('enabled')) is bool and sub=={'enabled':False} or set(sub)=={'enabled','formats'} and sub['enabled'] is True and isinstance(sub['formats'],list) and 1<=len(sub['formats'])<=2 and len(set(sub['formats']))==len(sub['formats']) and all(f in ('srt','vtt') for f in sub['formats'])))

def parse_script(text):
    if len(text.encode('utf-8')) > 65536:
        raise ValueError('Script too large')
    text = text.lstrip('\ufeff').replace('\r', '').strip()
    lines = []
    def add(value, start=None, end=None):
        value = ' '.join(re.sub(r'<[^>]*>', '', value).replace('-->', '→').split())
        if not value:
            return
        match = re.match(r'^([^:]{1,60}):\s*(.+)$', value)
        speaker, value = (match[1].strip(), match[2]) if match else ('', value)
        if len(value) > 1000:
            raise ValueError('Script line too long')
        lines.append(dict(text=value, speaker=speaker, start=start, end=end))
    if '-->' in text:
        for block in re.split(r'\n\s*\n', text):
            rows = block.split('\n')
            at = next((i for i, row in enumerate(rows) if '-->' in row), None)
            if at is None:
                continue
            match = re.match(r'^\s*((?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$', rows[at])
            if not match:
                raise ValueError('Invalid script timing')
            def clock(v):
                result = 0
                for part in v.replace(',', '.').split(':'):
                    result = result * 60 + float(part)
                return result
            start, end = clock(match[1]), clock(match[2])
            if not 0 <= start < end <= 86400:
                raise ValueError('Script cues must be ordered and non-overlapping')
            add(' '.join(rows[at+1:]), start, end)
    else:
        for line in text.split('\n'):
            add(line)
    if lines and lines[0]['start'] is not None: lines.sort(key=lambda line: line['start'])
    if not 1 <= len(lines) <= 300:
        raise ValueError('Use 1-300 script lines')
    return lines


def speech_regions(source, seconds):
    result = run(['ffmpeg', '-hide_banner', '-nostdin', '-protocol_whitelist', 'file,pipe', '-i', str(source),
                  '-map', '0:a:0', '-af', 'silencedetect=noise=-35dB:d=0.15', '-f', 'null', '-'])
    quiet, cursor = [], None
    for kind, value in re.findall(r'silence_(start|end):\s*([\d.]+)', result.stderr):
        value = min(seconds, max(0, float(value)))
        if kind == 'start':
            cursor = value
        elif cursor is not None:
            quiet.append((cursor, value)); cursor = None
    if cursor is not None:
        quiet.append((cursor, seconds))
    active, cursor = [], 0
    for start, end in quiet:
        if start > cursor + .01:
            active.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < seconds - .01:
        active.append((cursor, seconds))
    return active, quiet



def unpack(source, folder):
    if source.stat().st_size > MAX_BYTES: raise ValueError('Bundle too large')
    try:
        with zipfile.ZipFile(source) as z:
            infos=z.infolist(); names=[i.filename for i in infos]
            if not 2<=len(infos)<=204 or len(set(names))!=len(names) or sum(i.file_size for i in infos)>MAX_BYTES: raise ValueError('Invalid bundle')
            for i in infos:
                if not re.fullmatch(r'[A-Za-z0-9_-]+\.[a-z0-9]+',i.filename) or i.compress_type!=zipfile.ZIP_STORED or i.flag_bits&1 or (i.external_attr>>16)&0o170000==0o120000: raise ValueError('Unsafe bundle')
            if z.getinfo('manifest.json').file_size>131072: raise ValueError('Manifest too large')
            m=json.loads(z.read('manifest.json'))
            if m.get('version') not in (1,2): raise ValueError('Invalid version')
            expected = {'version','guide','voices','bed','script'} if m['version']==1 else {'version','clips','bed','script'}
            if set(m) not in (expected, expected|{'mode'} if m['version']==2 else expected): raise ValueError('Invalid manifest')
            mode = m.get('mode', 'transcribe' if m.get('script') is None and m['version']==2 else 'script')
            if mode not in ('script','transcribe') or (mode=='transcribe' and (m['version']!=2 or m['script'] is not None)) or (mode=='script' and m['script'] is None): raise ValueError('Invalid mode')
            clips=m.get('clips',m.get('voices'))
            if not isinstance(clips,list) or not 1<=len(clips)<=200: raise ValueError('Use 1-200 clips')
            def media(n): return isinstance(n,str) and n in names and n.split('.')[-1] in MEDIA
            for c in clips:
                if not isinstance(c,dict) or set(c)-{'file','speaker','name'} or not media(c.get('file')) or not isinstance(c.get('name'),str) or not 1<=len(c['name'])<=255 or not isinstance(c.get('speaker',''),str) or len(c.get('speaker',''))>60: raise ValueError('Invalid clip')
                c.setdefault('speaker','')
            if m['bed'] is not None and not media(m['bed']): raise ValueError('Invalid bed')
            script=m['script']
            if script is not None and (script not in ('script.txt','script.srt','script.vtt') or z.getinfo(script).file_size>65536): raise ValueError('Invalid script')
            media_names=[c['file'] for c in clips]+([m['bed']] if m['bed'] else [])
            required=['manifest.json']+([script] if script else [])+media_names
            # v1 guide is accepted for compatibility, but NEVER read, extracted, probed or billed.
            allowed=set(required)|({m['guide']} if m['version']==1 and isinstance(m['guide'],str) else set())
            if len(set(required))!=len(required) or set(names)!=allowed: raise ValueError('Unexpected members')
            lines=parse_script(z.read(script).decode('utf-8-sig')) if script else []
            folder.mkdir(exist_ok=True)
            for name in media_names:
                with z.open(name) as src, (folder/name).open('wb') as dst:
                    while chunk:=src.read(1024*1024): dst.write(chunk)
            return dict(version=2,clips=clips,bed=m['bed'],script=script,mode=mode),lines
    except (zipfile.BadZipFile,KeyError,TypeError,UnicodeError,json.JSONDecodeError) as e: raise ValueError('Invalid studio bundle') from e


def script_language(text):
    # Script blocks are deterministic, including short Indic lines unreliable in LID models.
    blocks=[(0x0900,0x097f,'hi'),(0x0c00,0x0c7f,'te'),(0x0b80,0x0bff,'ta'),(0x0c80,0x0cff,'kn'),(0x0d00,0x0d7f,'ml'),(0x0980,0x09ff,'bn'),(0x0a80,0x0aff,'gu'),(0x0a00,0x0a7f,'pa'),(0x0b00,0x0b7f,'or'),(0x0600,0x06ff,'ar'),(0x4e00,0x9fff,'zh'),(0xac00,0xd7af,'ko'),(0x3040,0x30ff,'ja')]
    counts=[(sum(lo<=ord(c)<=hi for c in text),code) for lo,hi,code in blocks]
    count,lang=max(counts)
    if count: return lang
    from lingua import LanguageDetectorBuilder
    result=LanguageDetectorBuilder.from_all_languages().build().detect_language_of(text)
    if result is None: raise ValueError('Unable to detect script language')
    return result.iso_code_639_1.name.lower()

_MODELS={}
def model(device='cpu', size='small'):
    from faster_whisper import WhisperModel
    key=(device,size)
    if key not in _MODELS: _MODELS[key]=WhisperModel(size,device=device,compute_type='int8_float16' if device=='cuda' else 'int8',download_root='/models')
    return _MODELS[key]

def detect_language(path, regions, folder, index):
    # Concatenate at most 30 seconds of speech, rather than 30 seconds of leading silence.
    spans=[]; remaining=30.0
    for a,b in regions:
        if remaining<=0: break
        end=min(b,a+remaining); spans.append((a,end)); remaining-=end-a
    if not spans: return ('uncertain',0.0)
    out=folder/f'gate-{index}.wav'
    graph=';'.join(f'[0:a]atrim=start={a}:end={b},asetpts=PTS-STARTPTS[s{i}]' for i,(a,b) in enumerate(spans))
    graph+=';'+''.join(f'[s{i}]' for i in range(len(spans)))+f'concat=n={len(spans)}:v=0:a=1[out]'
    run(['ffmpeg','-v','error','-nostdin','-y','-protocol_whitelist','file,pipe','-i',str(path),'-filter_complex',graph,'-map','[out]','-ar','16000','-ac','1',str(out)])
    _,info=model().transcribe(str(out),vad_filter=True,beam_size=1)
    return info.language,float(info.language_probability)

def prepare(source,folder,settings=None,detector=None,on_step=None):
    def step(name):
        if on_step is not None: on_step(name)
    step('studio_unpack')
    assets=folder/'assets'; m,lines=unpack(source,assets)
    names=[c['file'] for c in m['clips']]+([m['bed']] if m['bed'] else [])
    step('studio_probe')
    durations={n:duration(assets/n) for n in names}
    if max(durations.values())>3600 or sum(durations.values())>7200: raise ValueError('60 minutes per file / 120 minutes combined')
    step('studio_decode')
    regions={n:speech_regions(assets/n,durations[n]) for n in names}
    lang=None; languages=[]
    if m['script'] is not None:
        step('studio_language_gate')
        lang=script_language(' '.join(l['text'] for l in lines))
        for i,c in enumerate(m['clips']):
            code,prob=(detector or detect_language)(assets/c['file'],regions[c['file']][0],folder,i)
            languages.append(dict(name=c['name'],lang=code,prob=prob,uncertain=prob<.5))
    detail=dict(script_lang=lang,clips=languages)
    if lang and any(c['prob']>=.5 and c['lang']!=lang for c in languages): raise LanguageMismatch(detail)
    step('studio_plan')
    gap=(settings or {}).get('line_gap_ms',0)/1000
    seconds=sum(b-a for c in m['clips'] for a,b in regions[c['file']][0])+max(0,len(lines)-1)*gap
    if m['mode']=='transcribe': seconds=sum(durations.values())
    # Reserve missing-line silence in the estimate, preventing later underfunded processing.
    seconds=max(.001,seconds)
    if m['bed'] and (settings or {}).get('bed_fit')=='extend': seconds=max(seconds,durations[m['bed']])
    return dict(manifest=m,lines=lines,durations=durations,seconds=seconds,assets=assets,regions=regions,languages=detail)


def transcribe(project,device='cpu'):
    result=[]
    from faster_whisper import BatchedInferencePipeline
    pipeline=BatchedInferencePipeline(model=model(device))
    for i,c in enumerate(project['manifest']['clips']):
        segments,_=pipeline.transcribe(str(project['assets']/c['file']),language=project['languages'].get('script_lang'),word_timestamps=True,vad_filter=True,batch_size=8 if device=='cuda' else 2)
        for segment in segments:
            words=getattr(segment,'words',None)
            groups=[]; group=[]
            for word in words or []:
                if group and word.start-group[-1].end>=.45: groups.append(group); group=[]
                group.append(word)
                if re.search(r'[.!?।॥。！？]\s*$',word.word) or len(group)>=80: groups.append(group); group=[]
            if group: groups.append(group)
            if groups:
                for g in groups:
                    if g[-1].end>g[0].start: result.append(dict(clip=f'c{i}',src_start=round(float(g[0].start),6),src_end=round(float(g[-1].end),6),text=''.join(w.word for w in g).strip(),speaker=c.get('speaker',''),name=c['name']))
            elif segment.end>segment.start:
                result.append(dict(clip=f'c{i}',src_start=round(float(segment.start),6),src_end=round(float(segment.end),6),text=segment.text.strip(),speaker=c.get('speaker',''),name=c['name']))
    return result


def normal(text): return ''.join(c for c in unicodedata.normalize('NFKC',text).casefold() if unicodedata.category(c)[0] not in ('P','Z','C'))
def similarity(a,b):
    from rapidfuzz.fuzz import ratio,token_set_ratio
    return .7*ratio(normal(a),normal(b))/100+.3*token_set_ratio(unicodedata.normalize('NFKC',a).casefold(),unicodedata.normalize('NFKC',b).casefold())/100

def matching(lines,segments):
    # Per-clip monotonic dynamic programming, then resolve competing clips by evidence.
    # Groups permit one segment to cover consecutive lines and merged segments per line.
    proposals=[]
    for clip in dict.fromkeys(s['clip'] for s in segments):
        indices=[i for i,s in enumerate(segments) if s['clip']==clip]; n,m=len(indices),len(lines)
        dp=[[0.0]*(m+1) for _ in range(n+1)]; trace={}
        for i in range(n+1):
            for j in range(m+1):
                if i<n and dp[i+1][j]<=dp[i][j]: dp[i+1][j]=dp[i][j]; trace[i+1,j]=(i,j,None)
                if j<m and dp[i][j+1]<=dp[i][j]: dp[i][j+1]=dp[i][j]; trace[i,j+1]=(i,j,None)
                for sc,lc in ((1,1),(2,1),(3,1),(1,2),(1,3)):
                    if i+sc>n or j+lc>m: continue
                    group=[segments[k] for k in indices[i:i+sc]]
                    score=similarity(' '.join(s['text'] for s in group),' '.join(l['text'] for l in lines[j:j+lc]))
                    speaker=group[0]['speaker'].strip().casefold()
                    tag=lines[j]['speaker'].strip().casefold()
                    inferred=tag and re.search(r'(?:^|[^\w])'+re.escape(tag)+r'(?:$|[_\W\d])',group[0]['name'].casefold())
                    score=min(1,score+(.08 if tag and (speaker==tag or inferred) else 0))
                    if score<.48: continue
                    value=dp[i][j]+(score-.3)-.02*(sc+lc-2)
                    if value>dp[i+sc][j+lc]:
                        dp[i+sc][j+lc]=value; trace[i+sc,j+lc]=(i,j,(indices[i:i+sc],list(range(j,j+lc)),score))
        point=(n,m)
        while point in trace:
            i,j,match=trace[point]
            if match: proposals.append(match)
            point=(i,j)
    selected=[]; used_s=set(); used_l=set()
    for ss,ll,score in sorted(proposals,key=lambda p:p[2],reverse=True):
        if used_s.intersection(ss) or used_l.intersection(ll): continue
        selected.append((ss,ll,score)); used_s.update(ss); used_l.update(ll)
    return selected,used_s


def arrange_split(project,segments,settings,job_id):
    lines=project['lines']; byline={}
    if project['manifest'].get('mode')=='transcribe':
        # ASR emits clip order, then monotonic segment order. No text matching or
        # language gate for an absent script; preserve speech on speaker lanes.
        if not segments: raise ValueError('No speech detected')
        if len(segments)>2000: raise ValueError('Transcript exceeds 2000 segments')
        lines=[dict(text=s['text'][:1000],speaker=s.get('speaker') or Path(s['name']).stem[:60]) for s in segments]
        matches=[([i],[i],1.0) for i in range(len(segments))]; used=set(range(len(segments)))
    else:
        matches,used=matching(lines,segments)
    for ss,ll,score in matches:
        first,last=segments[ss[0]],segments[ss[-1]]; start,end=first['src_start'],last['src_end']
        weights=[max(1,len(normal(lines[j]['text']))) for j in ll]; total=sum(weights); cursor=start
        for j,w in zip(ll,weights):
            nxt=cursor+(end-start)*w/total; byline[j]=(first['clip'],cursor,nxt,score); cursor=nxt
    speakers=list(dict.fromkeys(l['speaker'] or 'Dialogue' for l in lines))
    speakers.sort(key=lambda n:0 if n.casefold() in ('narrator','narration') else 1)
    palette=['#818CF8','#A78BFA','#67E8F9','#6EE7B7','#FCD34D','#F9A8D4']
    lanes=[dict(id=f'l{i}',name=n,color=palette[i%len(palette)],gain_db=0,mute=False,solo=False) for i,n in enumerate(speakers)]
    lane={l['name']:l['id'] for l in lanes}; regions=[]; missing=[]; cursor=0; gap=settings['line_gap_ms']/1000
    for j,line in enumerate(lines):
        lid=lane[line['speaker'] or 'Dialogue']
        if j in byline:
            clip,a,b,score=byline[j]; regions.append(dict(id=f'r{j}',lane=lid,kind='clip',clip=clip,src_start=round(a,6),src_end=round(b,6),start=round(cursor,6),gain_db=0,line=j,confidence=round(score,3))); length=b-a
        else:
            length=max(1.5,len(normal(line['text']))/12); missing.append(dict(line=j,lane=lid,start=round(cursor,6),length=length,text=line['text']))
        cursor+=length+(gap if j<len(lines)-1 else 0)
    if project['manifest']['bed'] and settings['bed_fit']=='extend': cursor=max(cursor,project['durations'][project['manifest']['bed']])
    a=dict(version=1,job_id=job_id,sample_rate=48000,duration=round(max(.001,cursor),6),snap=True,line_gap_ms=settings['line_gap_ms'],match_strictness=settings['match_strictness'],lanes=lanes,
      clips=[dict(id=f'c{i}',name=c['name'],duration=project['durations'][c['file']]) for i,c in enumerate(project['manifest']['clips'])],regions=regions,missing=missing,
      unplaced=[dict(clip=s['clip'],src_start=s['src_start'],src_end=s['src_end'],transcript=s['text']) for i,s in enumerate(segments) if i not in used],
      lines=[dict(index=i,speaker=l['speaker'],text=l['text']) for i,l in enumerate(lines)])
    return a

def migrate_arrangement(a):
    """Upgrade structural defaults only: never merge legacy cuts or move audio."""
    if type(a.get('version')) is not int or a.get('version') not in (1,2): raise ValueError('Invalid arrangement version')
    import copy
    legacy=a['version']==1
    a=copy.deepcopy(a); a['version']=2
    a.setdefault('pan_law','legacy' if legacy else 'equal_power')
    a.setdefault('legacy_mastering',legacy)
    a.setdefault('sections',[]); a.setdefault('derived_clips',[]); a.setdefault('markers',[]); a.setdefault('loop',dict(enabled=False,start=0,end=a['duration']))
    a.setdefault('tempo',120); a.setdefault('time_signature',[4,4]); a.setdefault('master',dict(gain_db=0,inserts=[]));a['master'].setdefault('reference_gain_db',0)
    for lane in a['lanes']:
        lane.setdefault('pan',0); lane.setdefault('height',120); lane.setdefault('inserts',[])
    for r in a['regions']:
        r.setdefault('reverse',False);r.setdefault('inserts',[])
        r.setdefault('lines',[dict(line=r['line'],src_start=r['src_start'],src_end=r['src_end'],confidence=r['confidence'])])
        r.setdefault('fade_in',0); r.setdefault('fade_out',0); r.setdefault('fade_curve','linear'); r.setdefault('mute',False)
    return a


def arrange(project,segments,settings,job_id):
    a=arrange_split(project,segments,settings,job_id)
    if settings.get('region_mode','whole_clip')=='split_by_line' and project['manifest'].get('mode')!='transcribe':
        placed={r['clip'] for r in a['regions']}
        a['unplaced']=[dict(clip=c['id'],src_start=0,src_end=c['duration'],transcript=' '.join(s['text'] for s in segments if s['clip']==c['id'])[:5000]) for c in a['clips'] if c['id'] not in placed]
        a['pan_law']='equal_power';a['legacy_mastering']=False
        return validate_arrangement(migrate_arrangement(a))
    # Script matching supplies anchors and captions, not destructive edit boundaries.
    byclip={}
    for r in a['regions']: byclip.setdefault(r['clip'],[]).append(r)
    regions=[]; ends={}; cursor=0; unplaced=[]; gap=settings['line_gap_ms']/1000
    transcribe=project['manifest'].get('mode')=='transcribe'
    for clip in sorted(a['clips'],key=lambda c:min((r['line'] for r in byclip.get(c['id'],[])),default=100000)):
        matches=sorted(byclip.get(clip['id'],[]),key=lambda r:r['line'])
        if not matches and not transcribe:
            unplaced.append(dict(clip=clip['id'],src_start=0,src_end=clip['duration'],transcript=' '.join(s['text'] for s in segments if s['clip']==clip['id'])[:5000]));continue
        first=matches[0] if matches else None
        lid=first['lane'] if first else a['lanes'][0]['id']
        line=a['lines'][first['line']] if first else a['lines'][0]
        source_line=project['lines'][first['line']] if first and not transcribe else {}
        anchor=source_line.get('start')
        desired=max(0,(anchor if anchor is not None else first['start'])-first['src_start']) if first else cursor
        if transcribe: desired=cursor
        start=max(desired,ends.get(lid,0))
        region=dict(id=f"r{len(regions)}",lane=lid,kind='clip',clip=clip['id'],src_start=0.,src_end=float(clip['duration']),start=round(float(start),6),gain_db=0.,line=line['index'],confidence=min((r['confidence'] for r in matches),default=0),
            lines=[dict(line=r['line'],src_start=r['src_start'],src_end=r['src_end'],confidence=r['confidence']) for r in matches])
        regions.append(region);ends[lid]=start+clip['duration']+gap;cursor=start+clip['duration']+gap
    a.update(regions=regions,unplaced=unplaced,duration=round(max([.001]+[r['start']+r['src_end'] for r in regions]+[m['start']+m['length'] for m in a['missing']]),6))
    if project['manifest']['bed'] and settings['bed_fit']=='extend': a['duration']=max(a['duration'],project['durations'][project['manifest']['bed']])
    a['pan_law']='equal_power';a['legacy_mastering']=False
    return validate_arrangement(migrate_arrangement(a))


def unique_source_seconds(regions):
    spans={}
    for r in regions: spans.setdefault(r['clip'],[]).append((r['src_start'],r['src_end']))
    seconds=0
    for ranges in spans.values():
        end=-1
        for a,b in sorted(ranges):
            seconds+=max(0,b-max(a,end));end=max(end,b)
    return seconds


def validate_arrangement(a):
    upgraded=migrate_arrangement(a);a.clear();a.update(upgraded)
    def real(value,lo,hi):
        if isinstance(value,bool) or not isinstance(value,Real) or not math.isfinite(value) or not lo<=value<=hi: raise ValueError('Invalid arrangement number')
        return float(value)
    a['duration']=real(a['duration'],.001,14400)
    if not 1<=len(a['lanes'])<=300 or not 1<=len(a['clips'])<=200 or len(a['regions'])>2000: raise ValueError('Invalid arrangement count')
    clips={c['id']:real(c['duration'],.001,14400) for c in a['clips']+a['derived_clips']};lanes={l['id'] for l in a['lanes']}
    if len(clips)!=len(a['clips'])+len(a['derived_clips']) or len(lanes)!=len(a['lanes']) or len({r['id'] for r in a['regions']})!=len(a['regions']): raise ValueError('Duplicate IDs')
    base={c['id']:c['duration'] for c in a['clips']}
    if len(a['derived_clips'])>200: raise ValueError('Too many bounced clips')
    for c in a['derived_clips']:
        if c['source'] not in base or not 0<=real(c['src_start'],0,14400)<real(c['src_end'],0,14400)<=base[c['source']]+.001 or abs(c['duration']-c['src_end']+c['src_start'])>.001: raise ValueError('Invalid bounced source')
        real(c['gain_db'],-60,24);real(c['fade_in'],0,14400);real(c['fade_out'],0,14400)
        if c['fade_curve'] not in ('linear','equal_power'): raise ValueError('Invalid bounced fade')
    for r in a['regions']:
        for k in ('src_start','src_end','start'): r[k]=real(r[k],0,14400)
        r['gain_db']=real(r['gain_db'],-60,24)
        if not 0<=r['src_start']<r['src_end']<=clips.get(r['clip'],0)+.001 or r['lane'] not in lanes or r['start']+r['src_end']-r['src_start']>a['duration']+.001: raise ValueError('Invalid region')
        if type(r['mute']) is not bool or r['fade_curve'] not in ('linear','equal_power'): raise ValueError('Invalid fade')
        for k in ('fade_in','fade_out'): r[k]=real(r[k],0,14400)
        for line in r['lines']:
            if type(line['line']) is not int or not 0<=line['line']<len(a['lines']) or not 0<=real(line['src_start'],0,14400)<real(line['src_end'],0,14400)<=clips[r['clip']]+.001: raise ValueError('Invalid caption')
            real(line['confidence'],0,1)
    if unique_source_seconds([dict(r,clip=c['source'],src_start=c['src_start']+r['src_start'],src_end=c['src_start']+r['src_end']) if (c:=next((c for c in a['derived_clips'] if c['id']==r['clip']),None)) else r for r in a['regions']])>(288000 if a.get('editor_project') else 14400): raise ValueError('Arrangement render budget exceeded')
    for l in a['lanes']:
        l['gain_db']=real(l['gain_db'],-60,24);l['pan']=real(l['pan'],-1,1);real(l['height'],60,400)
        if type(l['mute']) is not bool or type(l['solo']) is not bool: raise ValueError('Invalid lane')
        from workers.editor_dsp import validate_slots
        validate_slots(l['inserts'])
    real(a['tempo'],20,300)
    sig=a['time_signature']
    if len(sig)!=2 or type(sig[0]) is not int or not 1<=sig[0]<=16 or sig[1] not in (2,4,8,16): raise ValueError('Invalid time signature')
    real(a['master']['gain_db'],-60,24);real(a['master'].get('reference_gain_db',0),-60,24)
    validate_slots(a['master']['inserts'])
    for r in a['regions']+a['derived_clips']:
        validate_slots(r.get('inserts',[]))
        if type(r.get('reverse',False)) is not bool:raise ValueError('Invalid reverse')
    for section in a['sections']:
        if not 0<=real(section['start'],0,14400)<real(section['end'],0,14400)<=a['duration']:raise ValueError('Invalid section')
    if type(a['loop']['enabled']) is not bool or not 0<=real(a['loop']['start'],0,14400)<real(a['loop']['end'],0,14400)<=a['duration']+.001: raise ValueError('Invalid loop')
    if len(a['markers'])>1000: raise ValueError('Too many markers')
    for m in a['markers']: real(m['time'],0,a['duration'])
    if len(json.dumps(a,ensure_ascii=False).encode())>(1000000 if a.get('editor_project') else 524288): raise ValueError('Invalid arrangement size')
    return a


def fade_envelope(r,positions):
    import numpy as np
    length=r['src_end']-r['src_start']; envelope=np.ones(len(positions),dtype='float64')
    for fade,values in ((r.get('fade_in',0),positions),(r.get('fade_out',0),length-positions)):
        if fade>0:
            ramp=np.clip(values/fade,0,1)
            envelope*=np.sin(ramp*np.pi/2) if r.get('fade_curve')=='equal_power' else ramp
    return envelope


def pan_gains(pan):
    # -3 dB equal-power balance law; stereo channels retain their separation.
    angle=(pan+1)*math.pi/4
    return math.cos(angle),math.sin(angle)


def arrangement_cues(a):
    cues=[]
    for r in a['regions']:
        for line in r.get('lines',[]):
            left=max(r['src_start'],line['src_start']);right=min(r['src_end'],line['src_end'])
            if right>left: cues.append(SimpleNamespace(start=r['start']+left-r['src_start'],end=r['start']+right-r['src_start'],text=a['lines'][line['line']]['text']))
    return sorted(cues,key=lambda c:c.start)


def normalize_clips(project,folder,settings):
    import numpy as np
    import soundfile as sf
    stems=folder/'stems'; peaks=folder/'peaks'; stems.mkdir(exist_ok=True); peaks.mkdir(exist_ok=True); outputs=[]
    for i,c in enumerate(project['manifest']['clips']):
        work=folder/f'norm-{i}'; work.mkdir(exist_ok=True)
        result=master(project['assets']/c['file'],work,{'eq':{'enabled':False},'compressor':{'enabled':False},'limiter':{'enabled':False},'loudness':{'enabled':True,'lufs':settings['dialogue_lufs']}})[0]
        dest=stems/f'c{i}.wav'; result.replace(dest); outputs.append(dest)
        # Bounded peak extraction at 100 Hz, signed 8-bit extrema. Never load a 60m stem wholesale.
        values=[]
        with sf.SoundFile(dest) as f:
            for block in f.blocks(blocksize=max(1,f.samplerate//100),dtype='float32',always_2d=True):
                mono=block.mean(axis=1); values.append([int(np.clip(mono.min()*127,-128,127)),int(np.clip(mono.max()*127,-128,127))])
        peak=peaks/f'c{i}.json'; peak.write_text(json.dumps(dict(rate=100,peaks=values),separators=(',',':'))); outputs.append(peak)
    return outputs


def mix(project,folder,settings,job_id=None,segments=None):
    a=arrange(project,segments if segments is not None else transcribe(project),settings,job_id or '00000000-0000-4000-8000-000000000000')
    outputs=normalize_clips(project,folder,settings)
    # Measure the initial mix once; preserve the selected LUFS target without
    # renormalizing away future edits or the user's master fader on each export.
    stems={c['id']:folder/'stems'/f"{c['id']}.wav" for c in a['clips']}
    if stems and all(p.exists() for p in stems.values()):
        reference=folder/'master-reference';reference.mkdir()
        render(dict(stems=stems),a,reference,dict(settings,room_tone=dict(enabled=False)),dict(formats=[],subtitles=[],missing_lines='exclude'))
        result=run(['ffmpeg','-hide_banner','-nostdin','-i',str(reference/'dialogue.wav'),'-af',f"loudnorm=I={settings['master_lufs']}:print_format=json",'-f','null','-'])
        match=re.search(r'\{[^{}]*"input_i"[^{}]*\}',result.stderr,re.S)
        if match:
            measured=float(json.loads(match[0])['input_i'])
            if math.isfinite(measured):a['master']['reference_gain_db']=max(-60,min(24,settings['master_lufs']-measured))
    path=folder/'arrangement-r1.json'; path.write_text(json.dumps(a,ensure_ascii=False,allow_nan=False)); outputs.append(path)
    report=folder/'report.json'; report.write_text(json.dumps(dict(method='auto-transcribe-v1' if project['manifest'].get('mode')=='transcribe' else 'script-match-v1',note=NOTE,languages=project['languages'],asr=project.get('asr',{'model':'small','device':'cpu-fallback','cost_measurement':'Not measured'}),missing=a['missing'],unplaced=a['unplaced'],matches=a['regions'],low_confidence=[r['id'] for r in a['regions'] if r['confidence']<{'strict':.85,'normal':.7,'loose':.5}[settings['match_strictness']]]),ensure_ascii=False)); outputs.append(report)
    if settings['subtitles']['enabled']:
        cues=arrangement_cues(a)
        outputs+=write_subtitles(cues,folder,settings['subtitles']['formats'])
    # No preview render until export: the first user-selected render is included.
    return outputs


def render(project,a,folder,settings,export):
    a=validate_arrangement(a); parts=[]; solo=any(l['solo'] for l in a['lanes']); lanes={l['id']:l for l in a['lanes']}
    seconds=a['duration']
    # Stream dialogue in half-second blocks. Never materialize one delayed multi-hour
    # WAV per region (200 clips can otherwise create terabytes of silent files).
    import numpy as np
    import soundfile as sf
    from contextlib import ExitStack
    from workers.editor_dsp import InsertChain
    dialogue=folder/'dialogue.wav'
    audible=[r for r in a['regions'] if not r.get('mute',False) and not lanes[r['lane']]['mute'] and (not solo or lanes[r['lane']]['solo'])]
    with ExitStack() as stack:
        inputs={}
        for clip,path in project['stems'].items():
            probe=sf.info(path)
            if probe.samplerate!=48000 or probe.channels!=2:
                normalized=folder/f'decode-{clip}.wav'; ffmpeg(path,normalized); path=normalized
            inputs[clip]=stack.enter_context(sf.SoundFile(path))
        for c in a['derived_clips']:
            # Never let an arrangement ID become a filesystem path.
            path=folder/f"bounce-{len(inputs)}.wav"
            source=inputs[c['source']]
            with sf.SoundFile(path,'w',samplerate=48000,channels=2,format='RF64',subtype='FLOAT') as dst:
                total=round(c['duration']*48000);chain=InsertChain(c.get('inserts',[]),48000,a['tempo'])
                for offset in range(0,total,24000):
                    count=min(24000,total-offset);source.seek(round(c['src_end']*48000)-offset-count if c.get('reverse') else round(c['src_start']*48000)+offset)
                    samples=source.read(count,dtype='float32',always_2d=True)
                    if c.get('reverse'):samples=samples[::-1]
                    envelope=fade_envelope(dict(c,src_start=0,src_end=c['duration']), (np.arange(len(samples))+offset)/48000)
                    dst.write(chain.process(samples*(10**(c['gain_db']/20)*envelope[:,None])))
            inputs[c['id']]=stack.enter_context(sf.SoundFile(path))
        out=stack.enter_context(sf.SoundFile(dialogue,mode='w',samplerate=48000,channels=2,format='RF64',subtype='FLOAT'))
        total=round(seconds*48000); blocksize=24000
        spans=[(round(r['start']*48000),round((r['start']+r['src_end']-r['src_start'])*48000),r) for r in audible]
        track_chains={l['id']:InsertChain(l['inserts'],48000,a['tempo']) for l in a['lanes']}
        region_chains={r['id']:InsertChain(r.get('inserts',[]),48000,a['tempo']) for r in audible if any(s['enabled'] for s in r.get('inserts',[]))}
        master_chain=InsertChain(a['master']['inserts'],48000,a['tempo'])
        master_gain=10**((a['master'].get('gain_db',0)+a['master'].get('reference_gain_db',0))/20)
        for offset in range(0,total,blocksize):
            count=min(blocksize,total-offset); block=np.zeros((count,2),dtype='float32')
            tracks={l['id']:np.zeros_like(block) for l in a['lanes']}
            for start,end,r in spans:
                left=max(offset,start); right=min(offset+count,end);samples=None
                region=np.zeros_like(block) if r['id'] in region_chains else None
                if right>left:
                    source=inputs[r['clip']]
                    source_at=max(0,round(r['src_end']*48000)-(left-start)-(right-left) if r.get('reverse') else round(r['src_start']*48000)+left-start)
                    if source_at<len(source):
                        source.seek(source_at);samples=source.read(right-left,dtype='float32',always_2d=True)
                        if r.get('reverse'):samples=samples[::-1]
                        envelope=fade_envelope(r,(np.arange(len(samples))+left-start)/48000)
                        samples=samples*(10**(r['gain_db']/20)*envelope[:,None])
                        if region is not None:region[left-offset:left-offset+len(samples)]=samples
                if region is not None:tracks[r['lane']]+=region_chains[r['id']].process(region)
                elif samples is not None:tracks[r['lane']][left-offset:left-offset+len(samples)]+=samples
            for lane_id,samples in tracks.items():
                lane=lanes[lane_id]
                if lane['mute'] or (solo and not lane['solo']):continue
                pan=np.asarray(pan_gains(lane.get('pan',0)))
                if a.get('pan_law')=='legacy':pan=np.minimum(1,pan*math.sqrt(2))
                block+=track_chains[lane_id].process(samples)*pan*10**(lane['gain_db']/20)
            out.write(master_chain.process(block*master_gain))
    parts.append(dialogue)
    activity='+'.join(f"between(t,{r['start']},{r['start']+r['src_end']-r['src_start']})" for r in a['regions'] if not lanes[r['lane']]['mute'] and (not solo or lanes[r['lane']]['solo'])) or '0'
    if project.get('bed'):
        out=folder/'bed.wav'; args=['ffmpeg','-v','error','-y','-nostdin']
        if settings['bed_fit']=='loop': args+=['-stream_loop','-1']
        args+=['-protocol_whitelist','file,pipe','-i',str(project['bed']),'-af',f"apad=whole_dur={seconds},atrim=duration={seconds},volume='if(gt({activity},0),{10**(-settings['ducking_db']/20)},1)':eval=frame",'-t',str(seconds),'-c:a','pcm_s24le',str(out)]
        run(args);parts.append(out)
    room=settings['room_tone']
    if room['enabled'] and room['amount']>0:
        for clip,path in project['stems'].items():
            _,quiet=speech_regions(path,duration(path)); usable=[(s,e) for s,e in quiet if e-s>=.2]
            if usable:
                s,e=max(usable,key=lambda p:p[1]-p[0]); sample=folder/'room-sample.wav'; ffmpeg(path,sample,f'atrim=start={s}:end={e},asetpts=PTS-STARTPTS')
                out=folder/'room.wav';run(['ffmpeg','-v','error','-y','-nostdin','-stream_loop','-1','-i',str(sample),'-t',str(seconds),'-af',f"volume='if(gt({activity},0),0,{room['amount']/100})':eval=frame",'-c:a','pcm_s24le',str(out)]);parts.append(out);break
    raw=folder/'raw.wav'
    if parts:
        args=['ffmpeg','-v','error','-y','-nostdin']
        for path in parts: args+=['-i',str(path)]
        graph=''.join(f'[{i}:a]' for i in range(len(parts)))+f'amix=inputs={len(parts)}:normalize=0,apad=whole_dur={seconds},atrim=duration={seconds}[out]'
        run(args+['-filter_complex',graph,'-map','[out]','-ar','48000','-ac','2','-c:a','pcm_s24le',str(raw)])
    else: run(['ffmpeg','-v','error','-y','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t',str(seconds),str(raw)])
    work=folder/'master';work.mkdir(); final=raw if not a.get('legacy_mastering',False) else master(raw,work,{'eq':{'enabled':False},'compressor':{'enabled':False},'limiter':{'enabled':False},'loudness':{'enabled':True,'lufs':settings['master_lufs']}})[0]; outputs=[]
    for fmt in export['formats']:
        options=export[fmt];dest=folder/f'studio-mix.{fmt}'
        codec=['-c:a','libmp3lame','-b:a',f"{options['bitrate_kbps']}k"] if fmt=='mp3' else ['-c:a',{16:'pcm_s16le',24:'pcm_s24le','32f':'pcm_f32le'}[options['bit_depth']]]
        run(['ffmpeg','-v','error','-y','-i',str(final),'-t',str(seconds),'-ar',str(options['sample_rate'])]+codec+(['-rf64','auto'] if fmt=='wav' else [])+[str(dest)]);outputs.append(dest)
    cues=arrangement_cues(a)
    if export['missing_lines']=='mark': cues += [SimpleNamespace(start=m['start'],end=m['start']+m['length'],text='[Missing line] '+m['text']) for m in a['missing']]
    return outputs+write_subtitles(sorted(cues,key=lambda c:c.start),folder,export['subtitles'])


def studio(source,folder,settings): return mix(prepare(source,folder,settings),folder,settings)
