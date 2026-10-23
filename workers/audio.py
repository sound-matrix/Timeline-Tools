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


def ffmpeg(source, destination, filters=None):
    args = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
            '-protocol_whitelist', 'file,pipe', '-i', str(source), '-map', '0:a:0', '-vn']
    if filters:
        args += ['-af', filters]
    return run(args + ['-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', str(destination)])


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
    """Strict mirror of lib/settings.ts, including disabled stage shapes."""
    def shape(value, keys):
        return isinstance(value, dict) and set(value) == set(keys)

    def number(v, lo, hi):
        return type(v) in (int, float) and math.isfinite(v) and lo <= v <= hi

    def band(v):
        return shape(v, ['enabled']) and v['enabled'] is False or (
            shape(v, ['enabled', 'gain']) and v['enabled'] is True and number(v['gain'], -12, 12))

    def stage(name, v):
        if shape(v, ['enabled']) and v['enabled'] is False:
            return True
        if not isinstance(v, dict) or v.get('enabled') is not True:
            return False
        if name == 'loudness':
            return shape(v, ['enabled', 'lufs']) and number(v['lufs'], -70, -5)
        if name == 'limiter':
            return (shape(v, ['enabled', 'ceiling', 'knee', 'release']) and number(v['ceiling'], -6, 0)
                    and v['knee'] in ('soft', 'hard') and number(v['release'], 50, 1000))
        if name == 'compressor':
            if not shape(v, ['enabled', 'threshold', 'ratio', 'attack', 'release', 'knee', 'makeup']):
                return False
            m = v['makeup']
            makeup = (shape(m, ['mode']) and m['mode'] == 'auto' or
                      shape(m, ['mode', 'gain']) and m['mode'] == 'manual' and number(m['gain'], -24, 24))
            return (number(v['threshold'], -60, 0) and number(v['ratio'], 1, 20)
                    and number(v['attack'], 0.01, 2000) and number(v['release'], 0.01, 9000)
                    and v['knee'] in ('soft', 'hard') and makeup)
        return (shape(v, ['enabled', 'bands']) and isinstance(v['bands'], list) and len(v['bands']) == 5
                and all(band(b) for b in v['bands']) and any(b['enabled'] for b in v['bands']))

    if kind == 'clean':
        keys = ('noise', 'hum', 'reverb', 'voice')
        valid = (shape(s, [*keys, 'strength']) and all(type(s[k]) is bool for k in keys)
                 and any(s[k] for k in keys) and number(s['strength'], 0, 100) and s['strength'] % 1 == 0)
    elif kind == 'master':
        keys = ('eq', 'compressor', 'loudness', 'limiter')
        valid = (shape(s, keys) and all(stage(k, s[k]) for k in keys)
                 and any(s[k]['enabled'] for k in keys))
    elif kind == 'subtitles':
        valid = (shape(s, ['language', 'formats']) and s['language'] in ('English', 'Hindi', 'Telugu', 'Tamil')
                 and isinstance(s['formats'], list) and 1 <= len(s['formats']) <= 2
                 and all(v in ('srt', 'vtt') for v in s['formats']))
    else:
        valid = False
    if not valid:
        raise ValueError('invalid_settings: Select your processing options again.')


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
    # The signal path is strictly EQ -> compressor -> loudness -> limiter.
    current = source
    filters = []
    if s['eq']['enabled']:
        filters += [f'equalizer=f={freq}:t=q:w=1:g={b["gain"]}'
                    for freq, b in zip((60, 250, 1000, 4000, 12000), s['eq']['bands']) if b['enabled']]
    c = s['compressor']
    if c['enabled']:
        makeup = (-c['threshold'] * (1 - 1 / c['ratio']) / 2
                  if c['makeup']['mode'] == 'auto' else c['makeup']['gain'])
        filters += [f'acompressor=threshold={10 ** (c["threshold"] / 20)}:ratio={c["ratio"]}'
                    f':attack={c["attack"]}:release={c["release"]}:knee={2.828427 if c["knee"] == "soft" else 1}'
                    ':makeup=1', f'volume={makeup}dB']
    if filters:
        current = folder / 'eq-compressed.wav'
        ffmpeg(source, current, ','.join(filters))

    loudness, limiter = s['loudness'], s['limiter']
    # These fallback values configure analysis only, never an enabled target.
    target = loudness['lufs'] if loudness['enabled'] else -24
    peak_target = limiter['ceiling'] if limiter['enabled'] else 0
    if loudness['enabled']:
        m = measure(current, target, peak_target)
        fields = ('input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset')
        if all(math.isfinite(float(m[k])) for k in fields):
            # Avoid narrowing dynamics to a fixed LRA when linear gain can reach
            # the requested target. Compressor/limiter remain explicit choices.
            norm = (f'loudnorm=I={target}:TP={peak_target}:LRA=50:measured_I={m["input_i"]}'
                    f':measured_TP={m["input_tp"]}:measured_LRA={m["input_lra"]}'
                    f':measured_thresh={m["input_thresh"]}:offset={m["target_offset"]}:linear=true')
            normalized = folder / 'normalized.wav'
            ffmpeg(current, normalized, norm)
            current = normalized
        # Silence cannot be normalized to finite LUFS; preserve it.

    output = folder / 'master.wav'
    if limiter['enabled']:
        ceiling = 10 ** (limiter['ceiling'] / 20)
        # Oversampling exposes inter-sample peaks. A high-ratio compressor supplies
        # the selected knee; alimiter catches residual peaks with auto-level OFF.
        limit = (f'aresample=192000,acompressor=threshold={ceiling}:ratio=20:attack=0.01'
                 f':release={limiter["release"]}:knee={2.828427 if limiter["knee"] == "soft" else 1}:makeup=1,'
                 f'alimiter=limit={ceiling}:attack=0.1:release={limiter["release"]}:level=false:latency=true,'
                 'aresample=48000')
        ffmpeg(current, output, limit)
    else:
        ffmpeg(current, output)
    measured = measure(output, target, peak_target)
    peak = float(measured['input_tp'])
    if limiter['enabled'] and math.isfinite(peak) and peak > limiter['ceiling'] + 0.05:
        # Output resampling can overshoot; enforce the chosen true-peak ceiling.
        adjusted = folder / 'adjusted.wav'
        ffmpeg(output, adjusted, f'volume={limiter["ceiling"] - peak - 0.1}dB')
        adjusted.replace(output)
        measured = measure(output, target, peak_target)

    def finite(key):
        n = float(measured[key])
        return n if math.isfinite(n) else None
    report = folder / 'loudness-report.json'
    report.write_text(json.dumps({'integrated_lufs': finite('input_i'), 'true_peak_dbtp': finite('input_tp'),
        'target_lufs': target if loudness['enabled'] else None,
        'ceiling_dbtp': peak_target if limiter['enabled'] else None,
        'settings': s,
        'note': 'Measured output; dynamics, peak limiting or silence may prevent the loudness target. '
                'Loudness normalization has its own 0 dBTP safety bound when the limiter is disabled.'}, indent=2))
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
