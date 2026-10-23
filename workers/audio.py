"""Bounded ffmpeg pipelines. Never pass user text to a shell or echo stderr."""
import json
import math
import re
import subprocess
from pathlib import Path


class MediaError(Exception):
    pass


def run(args, timeout=1800):
    try:
        return subprocess.run(args, check=True, capture_output=True, timeout=timeout, text=True)
    except (subprocess.SubprocessError, OSError):
        raise MediaError('Media processing failed') from None


def ffmpeg(source, destination, filters=None, floating=False):
    args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
            '-protocol_whitelist', 'file,pipe', '-i', str(source), '-map', '0:a:0', '-vn']
    if filters:
        args += ['-af', filters]
    return run(args + ['-ar', '48000', '-ac', '2', '-c:a', 'pcm_f32le' if floating else 'pcm_s24le', str(destination)])


def duration(source):
    result = run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                  '-select_streams', 'a:0', '-show_entries', 'format=duration:stream=index',
                  '-of', 'json', str(source)], timeout=60)
    try:
        data = json.loads(result.stdout)
        value = float(data['format']['duration'])
        if not data['streams'] or not math.isfinite(value) or value <= 0:
            raise ValueError()
        return value
    except (ValueError, KeyError, TypeError):
        raise MediaError('Invalid media') from None


def validate(kind, s):
    """Mirror strict Zod schemas in lib/settings.ts; legacy masters are invalid_settings."""
    def keys(value, expected):
        return isinstance(value, dict) and set(value) == set(expected.split())

    def number(v, lo, hi):
        return type(v) in (int, float) and math.isfinite(v) and lo <= v <= hi

    def stage(value, fields, check):
        return (keys(value, 'enabled') and value['enabled'] is False) or (
            keys(value, 'enabled ' + fields) and value['enabled'] is True and check(value))

    def compressor(c):
        m = c['makeup']
        return (number(c['threshold'], -60, 0) and number(c['ratio'], 1, 20)
                and number(c['attack'], 0.01, 2000) and number(c['release'], 1, 9000)
                and c['knee'] in ('soft', 'hard') and (
                    (keys(m, 'mode') and m['mode'] == 'auto') or
                    (keys(m, 'mode gain') and m['mode'] == 'manual' and number(m['gain'], -36, 36))))

    def bands(e):
        return (isinstance(e['bands'], list) and len(e['bands']) == 5
                and all(stage(b, 'gain', lambda b: number(b['gain'], -12, 12)) for b in e['bands'])
                and any(b['enabled'] for b in e['bands']))

    if kind == 'clean':
        valid = (keys(s, 'noise hum reverb voice strength')
                 and all(type(s[k]) is bool for k in ('noise', 'hum', 'reverb', 'voice'))
                 and any(s[k] for k in ('noise', 'hum', 'reverb', 'voice'))
                 and number(s['strength'], 0, 100) and s['strength'] == int(s['strength']))
    elif kind == 'master':
        valid = (keys(s, 'loudness limiter compressor eq')
                 and stage(s['loudness'], 'lufs', lambda l: number(l['lufs'], -70, -5))
                 and stage(s['limiter'], 'ceiling knee release', lambda l:
                           number(l['ceiling'], -6, 0) and l['knee'] in ('soft', 'hard')
                           and number(l['release'], 50, 1000))
                 and stage(s['compressor'], 'threshold ratio attack release knee makeup', compressor)
                 and stage(s['eq'], 'bands', bands)
                 and any(s[k]['enabled'] for k in ('loudness', 'limiter', 'compressor', 'eq')))
    elif kind == 'subtitles':
        valid = (keys(s, 'language formats') and s['language'] in ('English', 'Hindi', 'Telugu', 'Tamil')
                 and isinstance(s['formats'], list) and 1 <= len(s['formats']) <= 2
                 and all(v in ('srt', 'vtt') for v in s['formats']))
    else:
        valid = False
    if not valid:
        raise ValueError('invalid_settings: Select complete processing options')


def clean(source, folder, s):
    # Chunked spectral gating bounds memory even for long recordings.
    import numpy as np
    import soundfile as sf
    import noisereduce as nr
    strength = s['strength'] / 100
    decoded = folder / 'decoded.wav'
    ffmpeg(source, decoded)
    current = decoded
    if s['noise'] and strength > 0:
        current = folder / 'denoised.wav'
        with sf.SoundFile(decoded) as src, sf.SoundFile(current, 'w', samplerate=src.samplerate,
                channels=src.channels, subtype='PCM_24') as dst:
            for block in src.blocks(blocksize=src.samplerate * 20, always_2d=True):
                if len(block) < 2048:
                    dst.write(block)
                else:
                    dst.write(np.asarray(nr.reduce_noise(y=block.T, sr=src.samplerate,
                        stationary=False, prop_decrease=strength, n_fft=1024)).T)
    filters = []
    if strength > 0:
        if s['hum']:
            filters += [f'equalizer=f={f}:t=q:w=12:g={-24 * strength}' for f in (50, 60, 100, 120)]
        if s['reverb']:
            # Conservative downward gate reduces room tails; not neural dereverberation.
            filters += [f'agate=threshold={0.008 * strength}:ratio={1 + 3 * strength}:attack=10:release=180']
        if s['voice']:
            filters += [f'highpass=f={60 + 30 * strength}', f'equalizer=f=3000:t=q:w=1:g={3 * strength}']
    output = folder / 'clean.wav'
    ffmpeg(current, output, ','.join(filters) or None)
    return [output]


def measure(source, target, peak):
    result = run(['ffmpeg', '-hide_banner', '-nostdin', '-protocol_whitelist', 'file,pipe',
                  '-i', str(source), '-map', '0:a:0', '-af',
                  f'loudnorm=I={target}:TP={peak}:LRA=50:print_format=json', '-f', 'null', '-'])
    match = re.search(r'\{\s*"input_i".*?\}', result.stderr, re.S)
    if not match:
        raise MediaError('Measurement failed')
    return json.loads(match.group())


def master(source, folder, s):
    # Float intermediates keep user makeup/EQ boosts intact before loudness/limiting.
    prepared = folder / 'eq-compressed.wav'
    filters = []
    if s['eq']['enabled']:
        filters += [f'equalizer=f={freq}:t=q:w=1:g={band["gain"]}'
                    for freq, band in zip((60, 250, 1000, 4000, 12000), s['eq']['bands']) if band['enabled']]
    if s['compressor']['enabled']:
        c = s['compressor']
        knee = 2.828427125 if c['knee'] == 'soft' else 1
        filters += [f'acompressor=threshold={10 ** (c["threshold"] / 20)}:ratio={c["ratio"]}'
                    f':attack={c["attack"]}:release={c["release"]}:knee={knee}:makeup=1']
        # Auto: half the estimated gain reduction for a 0 dBFS input. Explicitly selected.
        gain = (-c['threshold'] * (1 - 1 / c['ratio']) / 2
                if c['makeup']['mode'] == 'auto' else c['makeup']['gain'])
        filters += [f'volume={gain}dB']
    ffmpeg(source, prepared, ','.join(filters) or None, floating=True)
    current = prepared
    target = s['loudness']['lufs'] if s['loudness']['enabled'] else None
    ceiling = s['limiter']['ceiling'] if s['limiter']['enabled'] else None
    if target is not None:
        # 0 dBTP is loudnorm's technical maximum, not a hidden selected limiter ceiling.
        # The user's true-peak stage runs after loudness, only when enabled.
        m = measure(current, target, 0)
        fields = ('input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset')
        if all(math.isfinite(float(m[k])) for k in fields):
            norm = (f'loudnorm=I={target}:TP=0:LRA=50:measured_I={m["input_i"]}'
                    f':measured_TP={m["input_tp"]}:measured_LRA={m["input_lra"]}'
                    f':measured_thresh={m["input_thresh"]}:offset={m["target_offset"]}:linear=true')
            current = folder / 'normalised.wav'
            ffmpeg(prepared, current, norm, floating=True)
    filters = []
    if ceiling is not None:
        l = s['limiter']
        filters = ['aresample=192000']
        if l['knee'] == 'soft':
            # alimiter has no knee option: add a soft peak detector before its cap.
            filters += [f'acompressor=threshold={10 ** (ceiling / 20)}:ratio=20:knee=2.828427125'
                        f':attack=0.01:release={l["release"]}:makeup=1:detection=peak:link=maximum']
        filters += [f'alimiter=limit={10 ** (ceiling / 20)}:attack=5:release={l["release"]}'
                    ':level=false:latency=true', 'aresample=48000']
    output = folder / 'master.wav'
    ffmpeg(current, output, ','.join(filters) or None)
    # Analysis-only references never change the rendered audio.
    measured = measure(output, target if target is not None else -24, 0)
    peak = float(measured['input_tp'])
    if ceiling is not None and math.isfinite(peak) and peak > ceiling + 0.05:
        # Correct resampling/PCM intersample overshoot only for an enabled limiter.
        adjusted = folder / 'adjusted.wav'
        ffmpeg(output, adjusted, f'volume={ceiling - peak - 0.1}dB')
        adjusted.replace(output)
        measured = measure(output, target if target is not None else -24, 0)

    def finite(key):
        n = float(measured[key])
        return n if math.isfinite(n) else None

    report = folder / 'loudness-report.json'
    report.write_text(json.dumps({'integrated_lufs': finite('input_i'), 'true_peak_dbtp': finite('input_tp'),
        'target_lufs': target, 'ceiling_dbtp': ceiling, 'settings': s,
        'note': 'Measured output; loudness target may be limited by dynamics, peaks or silence. '
                'Disabled targets are null. Loudnorm itself uses its 0 dBTP safety maximum.'}, indent=2))
    return [output, report]


def timestamp(seconds, vtt=False):
    ms = max(0, round(seconds * 1000))
    hours, ms = divmod(ms, 3600000)
    minutes, ms = divmod(ms, 60000)
    secs, ms = divmod(ms, 1000)
    return f'{hours:02}:{minutes:02}:{secs:02}{"." if vtt else ","}{ms:03}'


def write_subtitles(segments, folder, formats):
    outputs = []
    for fmt in dict.fromkeys(formats):
        lines = ['WEBVTT\n'] if fmt == 'vtt' else []
        for i, segment in enumerate(segments, 1):
            # Prevent generated text from breaking cue syntax or injecting markup.
            text = re.sub(r'<[^>]*>', '', segment.text).replace('-->', '→')
            text = ' '.join(text.split())
            lines += [str(i), f'{timestamp(segment.start, fmt == "vtt")} --> {timestamp(segment.end, fmt == "vtt")}', text, '']
        dest = folder / f'subtitles.{fmt}'
        dest.write_text('\n'.join(lines) + '\n', encoding='utf-8')
        outputs.append(dest)
    return outputs


def subtitles(source, folder, s):
    from faster_whisper import WhisperModel
    decoded = folder / 'speech.wav'
    run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
         '-protocol_whitelist', 'file,pipe', '-i', str(source), '-map', '0:a:0', '-vn', '-ar', '16000', '-ac', '1', str(decoded)])
    model = WhisperModel('small', device='cpu', compute_type='int8', download_root='/models')
    segments, _ = model.transcribe(str(decoded), language={'English': 'en', 'Hindi': 'hi', 'Telugu': 'te', 'Tamil': 'ta'}[s['language']],
                                  vad_filter=True, beam_size=5, condition_on_previous_text=False)
    return write_subtitles(list(segments), folder, s['formats'])


def process(source, folder, kind, settings):
    validate(kind, settings)
    return {'clean': clean, 'master': master, 'subtitles': subtitles}[kind](source, folder, settings)
