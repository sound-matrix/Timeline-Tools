"""Editor cloud export. Immutable DB snapshots; no browser-provided Storage paths."""
import copy
import math
import re
import uuid
from pathlib import Path
from workers.studio_export import apply_inserts

def asset_path(path, user, project, asset, peaks=False):
    user=str(uuid.UUID(user));project=str(uuid.UUID(project));asset=str(uuid.UUID(asset))
    suffix=r'peaks' if peaks else r'(?:wav|mp3|flac|m4a|aac|aiff|aif|ogg)'
    if not isinstance(path,str) or not re.fullmatch(re.escape(f'editor/{user}/{project}/{asset}.')+suffix,path,re.I):
        raise ValueError('Invalid Editor asset path')
    return path

def validate_editor_snapshot(snapshot,user,project):
    from workers.studio_audio import validate_arrangement
    if not isinstance(snapshot,dict):raise ValueError('Missing snapshot')
    a=validate_arrangement(copy.deepcopy(snapshot['arrangement']))
    if a['job_id']!=str(uuid.UUID(project)) or not a.get('editor_project'):raise ValueError('Invalid project')
    assets={}
    for row in snapshot.get('assets',[]):
        if row['project_id']!=project or row['user_id']!=user:raise ValueError('Invalid asset ownership')
        asset_path(row['storage_path'],user,project,row['id'])
        asset_path(row['peaks_path'],user,project,row['id'],True)
        assets[row['id']]=row
    originals={c['id']:c for c in (snapshot.get('source_arrangement') or {}).get('clips',[])}
    for c in a['clips']:
        if c.get('asset'):
            row=assets.get(c['asset'])
            if not row or row['id']!=c['id'] or abs(float(row['duration'])-c['duration'])>.001:raise ValueError('Invalid asset reference')
        elif originals.get(c['id'])!=c:raise ValueError('Invalid source clip')
    return a,assets

def render_editor(stems,arrangement,folder,settings,overlay=None,source_ids=None):
    from workers.studio_audio import render,ffmpeg,run
    import numpy as np
    import soundfile as sf
    a=copy.deepcopy(arrangement);stems=dict(stems)
    if overlay:
        from workers.podcast import render as render_podcast,local_edits,remap
        edits={k:v for k,v in overlay['edits'].items() if k!='timeline'}
        local={}
        for c in a['clips']:
            if c['id'] not in (source_ids or set()):local[c['id']]={'operations':[],'corrections':{},'speaker_names':{}};continue
            e=edits if c['id']=='source' else local_edits(edits,c.get('offset',0),c['duration']);local[c['id']]=e
            normalized=folder/f'pod-input-{len(local)}.wav';ffmpeg(stems[c['id']],normalized)
            work=folder/f'pod-{len(local)}';work.mkdir()
            render_podcast(normalized,work,overlay['transcript'],e,{'formats':[],'subtitles':[]},c['duration'])
            stems[c['id']]=work/'podcast-edited.wav';c['duration']=max(.001,remap(c['duration'],e))
        a['regions']=[dict(r,src_start=remap(r['src_start'],local.get(r['clip'],edits)),src_end=remap(r['src_end'],local.get(r['clip'],edits),False),start=remap(r['start'],edits)) for r in a['regions'] if remap(r['src_end'],local.get(r['clip'],edits),False)>remap(r['src_start'],local.get(r['clip'],edits))]
        a['duration']=remap(a['duration'],edits);a['loop']=dict(a['loop'],start=min(a['duration']-.001,remap(a['loop']['start'],edits)),end=remap(a['loop']['end'],edits));a['markers']=[dict(m,time=remap(m['time'],edits)) for m in a['markers']]
    a['legacy_mastering']=False
    for track in a['lanes']:apply_inserts(None,track['inserts'])
    apply_inserts(None,a['master']['inserts'])
    export={'formats':['wav'],'wav':{'bit_depth':'32f','sample_rate':48000},'subtitles':[],'missing_lines':'exclude','revision':settings['revision']}
    render({'stems':stems},a,folder,{'room_tone':{'enabled':False},'has_bed':False,'master_lufs':-16},export)
    first,last=settings['range'];seconds=last-first
    if not 0<=first<last<=a['duration']+.001:raise ValueError('Invalid export range')
    source=folder/'studio-mix.wav';gain=1.0
    if settings['options']['normalize']:
        peak=0
        with sf.SoundFile(source) as f:
            f.seek(round(first*f.samplerate));remaining=round(seconds*f.samplerate)
            while remaining>0:
                block=f.read(min(24000,remaining),dtype='float32',always_2d=True)
                if not len(block):break
                peak=max(peak,float(np.max(np.abs(block))));remaining-=len(block)
        if peak:gain=1/peak
    options=settings['options'];fmt=options['format'];target=folder/f'editor-mix.{fmt}'
    codec=['-c:a','libmp3lame','-b:a',str(options['bitrate'])+'k'] if fmt=='mp3' else ['-c:a','pcm_s24le' if options['depth']==24 else 'pcm_s16le']
    run(['ffmpeg','-v','error','-y','-ss',str(first),'-i',str(source),'-t',str(seconds),'-af',f'volume={gain}','-ar',str(options['rate'])]+codec+[str(target)])
    outputs=[target]
    if overlay and settings.get('subtitles'):
        from workers.podcast import timeline_words
        from workers.audio import write_subtitles
        from types import SimpleNamespace
        edits=dict(overlay['edits'],timeline=arrangement)
        words=timeline_words(overlay['transcript'],edits,a)
        cues=[SimpleNamespace(start=max(0,w['start']-first),end=min(seconds,w['end']-first),text=w['w']) for w in words if w['end']>first and w['start']<last]
        outputs+=write_subtitles(cues,folder,settings['subtitles'])
    return outputs

def handle_editor_job(db,job,worker_id,url,key):
    import tempfile
    import httpx
    from urllib.parse import quote
    from workers.timeline_tools_worker import transfer_output
    from workers.audio import duration,ffmpeg
    uploaded=[];committed=False;completion_attempted=False
    try:
        owner=str(uuid.UUID(job['user_id']));project=str(uuid.UUID(job['editor_project_id']))
        a,assets=validate_editor_snapshot(job['arrangement_snapshot'],owner,project)
        s=job['settings'];o=s['options']
        if set(o)!={'format','rate','depth','bitrate','normalize'} or o['format'] not in ('wav','mp3') or o['rate'] not in (44100,48000,96000) or o['depth'] not in (16,24) or o['bitrate'] not in (128,192,256,320) or type(o['normalize']) is not bool:raise ValueError('Invalid export settings')
        first,last=s['range']
        if not all(isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v) for v in [first,last]) or not 0<=first<last<=14400:raise ValueError('Invalid range')
        snapshot=job['arrangement_snapshot'];source_job=snapshot.get('source_job_id');original_job=None
        if source_job:
            original_job=db.table('jobs').select('*').eq('id',source_job).eq('user_id',owner).eq('status','done').single().execute().data
            if not original_job or original_job['type']!=snapshot['source_kind']:raise ValueError('Source unavailable')
        with tempfile.TemporaryDirectory(prefix='editor-') as temp:
            folder=Path(temp);stems={}
            for i,c in enumerate(a['clips']):
                bucket='uploads'
                if c.get('asset'):path=assets[c['asset']]['storage_path']
                else:
                    if not original_job:raise ValueError('Source missing')
                    bucket='outputs'
                    if original_job['type']=='studio':
                        if not re.fullmatch(r'c\d{1,3}',c['id']):raise ValueError('Invalid source clip')
                        path=f"{owner}/{source_job}/stems/{c['id']}.wav"
                    elif c['id']=='source':
                        row=db.table('podcast_projects').select('source_path').eq('job_id',source_job).eq('user_id',owner).single().execute().data;path=row['source_path']
                    else:
                        if not re.fullmatch(r'c\d{1,3}',c['id']):raise ValueError('Invalid podcast clip')
                        row=db.table('podcast_media').select('audio_path').eq('project_id',source_job).eq('user_id',owner).eq('media_index',int(c['id'][1:])).single().execute().data;path=row['audio_path']
                    if path not in original_job['output_paths'] or not path.startswith(f'{owner}/{source_job}/') or '..' in path:raise ValueError('Invalid source path')
                target=folder/f'input-{i}{Path(path).suffix}'
                with httpx.stream('GET',f'{url}/storage/v1/object/authenticated/{bucket}/{quote(path,safe="/")}',headers={'Authorization':f'Bearer {key}','apikey':key},timeout=300) as response:
                    response.raise_for_status()
                    with target.open('wb') as f:
                        for block in response.iter_bytes(1048576):f.write(block)
                if abs(duration(target)-c['duration'])>.05:raise ValueError('Asset duration changed')
                stems[c['id']]=target
            if not db.rpc('worker_prepare',{'p_job_id':job['id'],'p_worker_id':worker_id,'p_duration':last-first}).execute().data:return
            source_ids={c['id'] for c in (snapshot.get('source_arrangement') or {}).get('clips',[])}
            paths=render_editor(stems,a,folder,s,snapshot.get('source_overlay'),source_ids)
            for f in paths:
                path=f"{owner}/{job['id']}/{f.name}";transfer_output(url,key,path,f);uploaded.append(path)
            completion_attempted=True
            committed=bool(db.rpc('worker_complete',{'p_job_id':job['id'],'p_worker_id':worker_id,'p_outputs':uploaded}).execute().data)
    except Exception as error:
        print(f"job {job['id']} step=editor_export {type(error).__name__}")
        try:db.rpc('worker_fail',{'p_job_id':job['id'],'p_worker_id':worker_id,'p_code':'processing'}).execute()
        except Exception:pass
    finally:
        if not committed and not completion_attempted and uploaded:
            try:db.storage.from_('outputs').remove(uploaded)
            except Exception:pass
