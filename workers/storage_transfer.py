"""Bounded, restartable Storage transfers. Never log request data."""
import base64
import time
from urllib.parse import quote, urljoin, urlsplit
import httpx

CHUNK_SIZE = 6 * 1024 * 1024
RETRIES = 3


def transient(error):
    return isinstance(error, httpx.TransportError) or (
        isinstance(error, httpx.HTTPStatusError) and error.response.status_code >= 500)


def retry(operation):
    for attempt in range(RETRIES + 1):
        try:
            return operation()
        except (httpx.TransportError, httpx.HTTPStatusError) as error:
            if not transient(error) or attempt == RETRIES:
                raise
            time.sleep(2 ** attempt)


def log_failure(job_id, step, error):
    status = f' status={error.response.status_code}' if isinstance(error, httpx.HTTPStatusError) else ''
    print(f'{job_id} step={step} {type(error).__name__}{status}')


def download(url, key, bucket, path, target):
    def attempt():
        with httpx.stream('GET', f'{url}/storage/v1/object/authenticated/{bucket}/{quote(path, safe="/")}',
                          headers={'Authorization': f'Bearer {key}', 'apikey': key}, timeout=300) as response:
            response.raise_for_status()
            # Restart at byte zero after interrupted responses, truncating partial data.
            with target.open('wb') as file:
                for block in response.iter_bytes(1024 * 1024):
                    file.write(block)
    retry(attempt)


def upload(url, key, path, source):
    size = source.stat().st_size
    mime = {'.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.json': 'application/json',
            '.mp4': 'video/mp4', '.srt': 'application/x-subrip', '.vtt': 'text/vtt'}.get(source.suffix, 'application/octet-stream')
    headers = {'Authorization': f'Bearer {key}', 'apikey': key, 'x-upsert': 'false'}
    with httpx.Client(timeout=300, headers=headers) as client:
        def checked(method, address, **kwargs):
            response = client.request(method, address, **kwargs)
            response.raise_for_status()
            return response

        def same_size():
            response = retry(lambda: checked('GET', f'{url}/storage/v1/object/info/outputs/{quote(path, safe="/")}'))
            info = response.json()
            return info.get('size', info.get('metadata', {}).get('size')) == size

        if size <= CHUNK_SIZE:
            for attempt in range(RETRIES + 1):
                try:
                    with source.open('rb') as file:
                        checked('POST', f'{url}/storage/v1/object/outputs/{quote(path, safe="/")}',
                                headers={'Content-Type': mime, 'Content-Length': str(size)}, content=file)
                    return
                except (httpx.TransportError, httpx.HTTPStatusError) as error:
                    if attempt and isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 409 and same_size():
                        return
                    if not transient(error) or attempt == RETRIES:
                        raise
                    time.sleep(2 ** attempt)
        else:
            tus = {'Tus-Resumable': '1.0.0'}
            metadata = {'bucketName': 'outputs', 'objectName': path, 'contentType': mime, 'cacheControl': '3600'}
            storage_url = urlsplit(url)
            if storage_url.hostname and storage_url.hostname.endswith('.supabase.co') and not storage_url.hostname.endswith('.storage.supabase.co'):
                storage_url = storage_url._replace(netloc=storage_url.netloc.replace('.supabase.co', '.storage.supabase.co'))
            endpoint = storage_url.geturl().rstrip("/") + "/storage/v1/upload/resumable"
            response = retry(lambda: checked('POST', endpoint, headers={**tus, 'Upload-Length': str(size),
                'Upload-Metadata': ','.join(f'{k} {base64.b64encode(v.encode()).decode()}' for k, v in metadata.items())}))
            location = urljoin(endpoint, response.headers['Location'])
            # Do not forward service credentials to an unexpected Location origin.
            if urlsplit(location)[:2] != urlsplit(endpoint)[:2]:
                raise ValueError('Unexpected upload origin')
            offset = 0
            with source.open('rb') as file:
                while offset < size:
                    start = offset
                    for attempt in range(RETRIES + 1):
                        try:
                            if attempt:
                                head = retry(lambda: checked('HEAD', location, headers=tus))
                                offset = int(head.headers['Upload-Offset'])
                                if not start <= offset <= min(start + CHUNK_SIZE, size):
                                    raise ValueError('Invalid upload offset')
                                if offset == min(start + CHUNK_SIZE, size):
                                    break
                            file.seek(offset)
                            data = file.read(min(start + CHUNK_SIZE, size) - offset)
                            response = checked('PATCH', location, headers={**tus, 'Content-Type': 'application/offset+octet-stream',
                                               'Upload-Offset': str(offset)}, content=data)
                            confirmed = int(response.headers['Upload-Offset'])
                            if confirmed != offset + len(data):
                                raise ValueError('Invalid upload offset')
                            offset = confirmed
                            break
                        except (httpx.TransportError, httpx.HTTPStatusError) as error:
                            if attempt and isinstance(error, httpx.HTTPStatusError) and error.response.status_code == 409 and same_size():
                                return
                            if not transient(error) or attempt == RETRIES:
                                raise
                            time.sleep(2 ** attempt)
