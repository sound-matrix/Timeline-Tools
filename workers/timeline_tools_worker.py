"""Deploy from repo root: modal deploy -m workers.timeline_tools_worker."""
import os
import tempfile
import uuid
from pathlib import Path
from urllib.parse import quote

import modal

app = modal.App('timeline-tools-worker')
# Complete build steps before attaching local source mounts to either image.
base = (modal.Image.debian_slim(python_version='3.12')
    .apt_install('ffmpeg', 'libsndfile1')
    .pip_install_from_requirements('workers/requirements.txt'))
image = base.add_local_python_source('workers')
gpu_image = (base
    .pip_install('nvidia-cublas-cu12==12.8.4.1', 'nvidia-cudnn-cu12==9.10.2.21')
    .env({'LD_LIBRARY_PATH': '/usr/local/lib/python3.12/site-packages/nvidia/cublas/lib:/usr/local/lib/python3.12/site-packages/nvidia/cudnn/lib'})
    .add_local_python_source('workers'))
models = modal.Volume.from_name('timeline-tools-asr-models', create_if_missing=True)
secrets = modal.Secret.from_name('timeline-tools-supabase', required_keys=['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'])


def transfer_input(url, key, input_path, target):
    import httpx
    # Stream large uploads to disk; never load the entire input into memory.
    with httpx.stream('GET', f'{url}/storage/v1/object/authenticated/uploads/{quote(input_path, safe="/")}',
            headers={'Authorization': f'Bearer {key}', 'apikey': key}, timeout=300) as response:
        response.raise_for_status()
        with target.open('wb') as file:
            for chunk in response.iter_bytes(1024 * 1024):
                file.write(chunk)


def transfer_output(url, key, output_path, source):
    import httpx
    mime = {'.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json', '.srt': 'application/x-subrip', '.vtt': 'text/vtt'}[source.suffix]
    def chunks():
        with source.open('rb') as file:
            while data := file.read(1024 * 1024):
                yield data
    with httpx.Client(timeout=300) as client:
        response = client.post(f'{url}/storage/v1/object/outputs/{quote(output_path, safe="/")}',
            headers={'Authorization': f'Bearer {key}', 'apikey': key, 'Content-Type': mime,
                     'Content-Length': str(source.stat().st_size), 'x-upsert': 'false'}, content=chunks())
        response.raise_for_status()


def handle_job(db, job, worker_id, url, key):
    from workers.audio import duration, validate, process, MediaError
    job_id = job['id']
    paths = []
    committed = False
    completion_attempted = False
    code = 'invalid_settings'
    step = 'validate_settings'
    def at(name, failure_code='processing'):
        nonlocal step, code
        step, code = name, failure_code
    def studio_step(name):
        at(name, 'invalid_media' if name in ('studio_probe','studio_decode') else
           'invalid_settings' if name == 'studio_unpack' else 'processing')
    def log_failure(error, failed_step=None):
        # Never log exception messages/tracebacks: they may contain URLs or keys.
        print(f'job {job_id} step={failed_step or step} {type(error).__name__}')
    try:
        if job['type'] == 'studio_export':
            from workers.studio_export import validate_export
            validate_export(job['settings'])
        else:
            validate(job['type'], job['settings'])
        # Defense in depth for service-role Storage access.
        expected = str(uuid.UUID(job['user_id']))
        input_path = job['input_path']
        parent = None
        if job['type'] == 'studio_export':
            parent = db.table('jobs').select('*').eq('id',job['parent_job_id']).eq('user_id',expected).eq('type','studio').eq('status','done').single().execute().data
            if not parent: raise ValueError('Invalid parent')
            input_path = parent['input_path']
        parts = input_path.split('/')
        if len(parts) != 2 or parts[0] != expected or '..' in parts[1]:
            raise ValueError('Invalid input owner')
        with tempfile.TemporaryDirectory(prefix='timeline-') as directory:
            folder = Path(directory)
            source = folder / ('input' + Path(parts[1]).suffix)
            at('input_transfer','storage')
            transfer_input(url, key, input_path, source)
            at('studio_prepare')
            project = None
            if job['type'] == 'studio':
                from workers.studio_audio import prepare
                if source.suffix != '.zip':
                    raise ValueError('Studio requires a ZIP bundle')
                project = prepare(source, folder, job['settings'], on_step=studio_step)
                seconds = project['seconds']  # Derived VAD speech + chosen gaps, after language gate.
            elif parent is not None:
                from workers.studio_audio import validate_arrangement
                at('validate_arrangement')
                arrangement = validate_arrangement(job['arrangement_snapshot'])
                seconds = arrangement['duration']
            else:
                at('probe','invalid_media')
                seconds = duration(source)
            at('worker_prepare')
            if not db.rpc('worker_prepare', {'p_job_id': job_id, 'p_worker_id': worker_id, 'p_duration': seconds}).execute().data:
                return
            at('processing')
            if project is not None:
                from workers.studio_audio import mix
                try:
                    at('asr_gpu')
                    result = studio_asr.remote(url, key, input_path, project['languages']['script_lang'])
                    if isinstance(result,dict):
                        segments=result['segments']; project['asr']=result['metrics']
                    else:
                        segments=result
                except Exception as error:
                    log_failure(error)
                    at('asr_cpu')
                    from workers.studio_audio import transcribe
                    segments = transcribe(project)  # CPU fallback, same cached small model.
                at('studio_match_arrange_mix')
                outputs = mix(project, folder, job['settings'], job_id, segments)
            elif parent is not None:
                from workers.studio_audio import unpack, render
                manifest, _ = unpack(source, folder/'assets')
                stems = {}
                for clip in arrangement['clips']:
                    path = f"{expected}/{parent['id']}/stems/{clip['id']}.wav"
                    if path not in parent['output_paths']: raise ValueError('Unknown clip')
                    dest = folder/f"{clip['id']}.wav"
                    at('stem_transfer','storage')
                    transfer_stem(url,key,path,dest)
                    stems[clip['id']] = dest
                at('studio_export_render')
                outputs = render(dict(stems=stems,bed=folder/'assets'/manifest['bed'] if manifest['bed'] else None),arrangement,folder,parent['settings'],job['settings'])
            else:
                outputs = process(source, folder, job['type'], job['settings'])
            at('output_transfer','storage')
            for output in outputs:
                path = f'{expected}/{job_id}/{output.relative_to(folder).as_posix()}'
                paths.append(path)  # Also clean up a partially transferred object on failure.
                transfer_output(url, key, path, output)
            if project is not None:
                at('save_arrangement')
                import json
                a = json.loads((folder/'arrangement-r1.json').read_text())
                db.table('jobs').update(dict(duration_sec=min(seconds,a['duration']))).eq('id',job_id).eq('worker_id',worker_id).eq('status','processing').execute()
                db.table('studio_arrangements').insert(dict(job_id=job_id,user_id=expected,revision=1,arrangement=a,arrangement_path=f'{expected}/{job_id}/arrangement-r1.json')).execute()
                db.table('jobs').update(dict(peaks_paths=[p for p in paths if '/peaks/' in p])).eq('id',job_id).eq('worker_id',worker_id).execute()
            at('worker_complete')
            completion_attempted = True
            committed = bool(db.rpc('worker_complete', {'p_job_id': job_id, 'p_worker_id': worker_id, 'p_outputs': paths}).execute().data)
    except ValueError as error:
        log_failure(error)
        from workers.studio_audio import LanguageMismatch
        if isinstance(error,LanguageMismatch):
            code='language_mismatch'
            detail=dict(script_lang=error.detail['script_lang'],clips=[c for c in error.detail['clips'] if c['prob']>=.5 and c['lang']!=error.detail['script_lang']])
            import json
            while len(json.dumps(detail).encode())>8192: detail['clips'].pop()
            db.table('jobs').update(dict(error_code=code,error_detail=detail)).eq('id',job_id).eq('worker_id',worker_id).eq('status','processing').execute()
    except MediaError as error:
        log_failure(error)
    except Exception as error:
        log_failure(error)
    finally:
        if not committed:
            # If completion's response was lost, verify state before deleting outputs.
            # If DB is unavailable, preserve objects for operator reconciliation.
            safe_to_remove = not completion_attempted
            if completion_attempted:
                try:
                    state = db.table('jobs').select('status').eq('id', job_id).single().execute().data
                    committed = state['status'] == 'done'
                    safe_to_remove = state['status'] == 'failed'
                except Exception as error:
                    log_failure(error,'completion_check')
                    safe_to_remove = False
            if not committed:
                try:
                    failed = db.rpc('worker_fail', {'p_job_id': job_id, 'p_worker_id': worker_id, 'p_code': code}).execute().data
                    safe_to_remove = safe_to_remove or bool(failed)
                except Exception as error:
                    log_failure(error,'worker_fail')
                if paths and safe_to_remove:
                    try:
                        db.storage.from_('outputs').remove(paths)
                    except Exception as error:
                        log_failure(error,'output_cleanup')  # Private orphans remain for operator.


def transfer_stem(url,key,path,target):
    import httpx
    with httpx.stream('GET',f'{url}/storage/v1/object/authenticated/outputs/{quote(path,safe="/")}',headers={'Authorization':f'Bearer {key}','apikey':key},timeout=300) as response:
        response.raise_for_status()
        with target.open('wb') as f:
            for chunk in response.iter_bytes(1024*1024): f.write(chunk)

@app.function(image=gpu_image, volumes={'/models':models}, gpu='T4', cpu=2, memory=8192,timeout=3600,max_containers=2)
def studio_asr(url,key,input_path,language):
    import time
    from workers.studio_audio import unpack,transcribe
    from workers.audio import duration
    started=time.perf_counter()
    with tempfile.TemporaryDirectory(prefix='studio-asr-') as tmp:
        folder=Path(tmp); source=folder/'input.zip';transfer_input(url,key,input_path,source)
        manifest,lines=unpack(source,folder/'assets')
        result=transcribe(dict(manifest=manifest,assets=folder/'assets',languages={'script_lang':language}),device='cuda')
        models.commit()
        seconds=time.perf_counter()-started
        minutes=sum(duration(folder/'assets'/c['file']) for c in manifest['clips'])/60
        return dict(segments=result,metrics=dict(model='small',device='T4',elapsed_seconds=seconds,audio_minutes=minutes,gpu_only_usd_per_audio_minute=seconds*0.000164/max(minutes,.001),pricing_basis='Modal public T4 $0.000164/s; excludes CPU, memory, language gate and storage'))


@app.function(image=image, secrets=[secrets], volumes={'/models': models},
              schedule=modal.Period(seconds=30), cpu=2, memory=4096,
              timeout=3600, max_containers=4, retries=0)
def poll():
    from supabase import create_client
    # One claim per scheduled invocation; overlapping runs use SKIP LOCKED.
    # A hard-killed invocation is failed by the next claim after a 2h grace period.
    try:
        url = os.environ['SUPABASE_URL'].rstrip('/')
        key = os.environ['SUPABASE_SERVICE_ROLE_KEY']
        db = create_client(url, key)
        worker_id = str(uuid.uuid4())
        rows = db.rpc('worker_claim', {'p_worker_id': worker_id}).execute().data
        if rows:
            handle_job(db, rows[0], worker_id, url, key)
    except Exception:
        # No exception/HTTP payloads in Modal logs. Monitor queue age and failed rows.
        print('Worker poll unavailable; retrying on next schedule.')
