"""Deploy from repo root: modal deploy -m workers.timeline_tools_worker."""
import os
import tempfile
import uuid
from pathlib import Path
from urllib.parse import quote

import modal

app = modal.App('timeline-tools-worker')
image = (modal.Image.debian_slim(python_version='3.12')
    .apt_install('ffmpeg', 'libsndfile1')
    .pip_install_from_requirements('workers/requirements.txt')
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
    mime = {'.wav': 'audio/wav', '.json': 'application/json', '.srt': 'application/x-subrip', '.vtt': 'text/vtt'}[source.suffix]
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
    code = 'processing'
    try:
        validate(job['type'], job['settings'])
        # Defense in depth for service-role Storage access.
        expected = str(uuid.UUID(job['user_id']))
        parts = job['input_path'].split('/')
        if len(parts) != 2 or parts[0] != expected or '..' in parts[1]:
            raise ValueError('Invalid input owner')
        with tempfile.TemporaryDirectory(prefix='timeline-') as directory:
            folder = Path(directory)
            source = folder / ('input' + Path(parts[1]).suffix)
            code = 'storage'
            transfer_input(url, key, job['input_path'], source)
            code = 'invalid_media'
            seconds = duration(source)
            if not db.rpc('worker_prepare', {'p_job_id': job_id, 'p_worker_id': worker_id, 'p_duration': seconds}).execute().data:
                return
            code = 'processing'
            outputs = process(source, folder, job['type'], job['settings'])
            code = 'storage'
            for output in outputs:
                path = f'{expected}/{job_id}/{output.name}'
                paths.append(path)  # Also clean up a partially transferred object on failure.
                transfer_output(url, key, path, output)
            completion_attempted = True
            committed = bool(db.rpc('worker_complete', {'p_job_id': job_id, 'p_worker_id': worker_id, 'p_outputs': paths}).execute().data)
    except ValueError:
        code = 'invalid_settings'
    except MediaError:
        pass
    except Exception:
        # Do not print exception strings: HTTP errors can include keys/signed URLs.
        pass
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
                except Exception:
                    safe_to_remove = False
            if not committed:
                try:
                    failed = db.rpc('worker_fail', {'p_job_id': job_id, 'p_worker_id': worker_id, 'p_code': code}).execute().data
                    safe_to_remove = safe_to_remove or bool(failed)
                except Exception:
                    pass
                if paths and safe_to_remove:
                    try:
                        db.storage.from_('outputs').remove(paths)
                    except Exception:
                        pass  # Private orphan objects can be removed by operator.


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
