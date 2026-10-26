import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import httpx
from workers.storage_transfer import upload, download, CHUNK_SIZE


class Transfers(unittest.TestCase):
    def run_upload(self, size, handler):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'audio.wav'
            with source.open('wb') as file:
                file.truncate(size)
            client = httpx.Client(transport=httpx.MockTransport(handler))
            with patch('workers.storage_transfer.httpx.Client', return_value=client), patch('workers.storage_transfer.time.sleep'):
                upload('https://storage.test', 'secret', 'user/job/audio.wav', source)

    def test_small_standard(self):
        calls = []
        def handler(request):
            calls.append(request)
            return httpx.Response(200)
        self.run_upload(CHUNK_SIZE, handler)
        self.assertEqual(len(calls), 1)
        self.assertIn('/object/outputs/', calls[0].url.path)
        self.assertEqual(len(calls[0].content), CHUNK_SIZE)

    def test_large_chunks_and_lost_response(self):
        offset = 0
        chunks = []
        failed = False
        def handler(request):
            nonlocal offset, failed
            if request.method == 'POST':
                self.assertEqual(request.headers['upload-length'], str(2 * CHUNK_SIZE + 7))
                return httpx.Response(201, headers={'Location': '/storage/v1/upload/resumable/id'})
            if request.method == 'HEAD':
                return httpx.Response(200, headers={'Upload-Offset': str(offset)})
            self.assertEqual(int(request.headers['upload-offset']), offset)
            chunks.append(len(request.content))
            offset += len(request.content)
            if not failed:
                failed = True
                raise httpx.ReadTimeout('private URL must not be logged', request=request)
            return httpx.Response(204, headers={'Upload-Offset': str(offset)})
        self.run_upload(2 * CHUNK_SIZE + 7, handler)
        self.assertEqual(chunks, [CHUNK_SIZE, CHUNK_SIZE, 7])

    def test_5xx_retried_413_not_retried(self):
        for status, count in [(503, 4), (413, 1)]:
            calls = []
            def handler(request):
                calls.append(request)
                return httpx.Response(status)
            with self.assertRaises(httpx.HTTPStatusError):
                self.run_upload(10, handler)
            self.assertEqual(len(calls), count)

    def test_duplicate_only_on_retry_and_matching_size(self):
        for existing, first, succeeds in [(10, False, True), (9, False, False), (10, True, False)]:
            calls = []
            def handler(request):
                calls.append(request)
                if request.method == 'GET':
                    return httpx.Response(200, json={'metadata': {'size': existing}})
                return httpx.Response(409 if first or len(calls) > 1 else 503)
            if succeeds:
                self.run_upload(10, handler)
            else:
                with self.assertRaises(httpx.HTTPStatusError):
                    self.run_upload(10, handler)

    def test_download_restarts_partial_file(self):
        calls = 0
        class Broken(httpx.SyncByteStream):
            def __iter__(self):
                yield b'partial'
                raise httpx.ReadTimeout('secret')
        def stream(*args, **kwargs):
            nonlocal calls
            calls += 1
            return httpx.Response(200, request=httpx.Request('GET', 'https://storage.test'),
                                  stream=Broken() if calls == 1 else httpx.ByteStream(b'complete'))
        from contextlib import contextmanager
        @contextmanager
        def response(*args, **kwargs):
            yield stream()
        with tempfile.TemporaryDirectory() as directory, patch('workers.storage_transfer.httpx.stream', response), patch('workers.storage_transfer.time.sleep'):
            target = Path(directory) / 'input'
            download('https://storage.test', 'secret', 'uploads', 'input', target)
            self.assertEqual(target.read_bytes(), b'complete')
            self.assertEqual(calls, 2)

    def test_large_patch_5xx_and_413(self):
        for status, expected in [(503, 4), (413, 1)]:
            patches = []
            def handler(request):
                if request.method == 'POST':
                    return httpx.Response(201, headers={'Location': '/storage/v1/upload/resumable/id'})
                if request.method == 'HEAD':
                    return httpx.Response(200, headers={'Upload-Offset': '0'})
                patches.append(request)
                return httpx.Response(status)
            with self.assertRaises(httpx.HTTPStatusError):
                self.run_upload(CHUNK_SIZE + 1, handler)
            self.assertEqual(len(patches), expected)

    def test_log_redacts_private_request(self):
        from workers.storage_transfer import log_failure
        response = httpx.Response(503, request=httpx.Request('POST', 'https://private.test/secret?key=private'), text='private body')
        with self.assertRaises(httpx.HTTPStatusError) as caught:
            response.raise_for_status()
        with patch('builtins.print') as log:
            log_failure('job-id', 'output_transfer', caught.exception)
            log.assert_called_once_with('job-id step=output_transfer HTTPStatusError status=503')
