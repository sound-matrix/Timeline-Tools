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
    """Mirror lib/settings.ts even for jobs inserted directly through the Data API."""
    if not isinstance(s, dict):
        raise ValueError('Invalid settings')
    def number(v, lo, hi):
        return type(v) in (int, float) and math.isfinite(v) and lo <= v <= hi
    if kind == 'clean':
        valid = set(s) == {'noise', 'hum', 'reverb', 'voice', 'strength'} and all(
            type(s[k]) is bool for k in ('noise', 'hum', 'reverb', 'voice')) and type(s['strength']) is int and 0 <= s['strength'] <= 100
    elif kind == 'master':
        valid = (set(s) == {'eq', 'threshold', 'ratio', 'ceiling', 'lufs'}
                 and isinstance(s['eq'], list) and len(s['eq']) == 5
                 and all(number(v, -12, 12) for v in s['eq'])
                 and number(s['threshold'], -40, 0) and number(s['ratio'], 1, 10)
                 and s['ceiling'] in ('-1', '-2', '-0.3') and s['lufs'] in ('-14', '-16', '-23'))
    elif kind == 'subtitles':
        valid = (set(s) == {'language', 'formats'} and s['language'] in ('English', 'Hindi', 'Telugu', 'Tamil')
                 and isinstance(s['formats'], list) and 1 <= len(s['formats']) <= 2
                 and all(v in ('srt', 'vtt') for v in s['formats']))
    else:
        valid = False
    if not valid:
        raise ValueError('Invalid settings')


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
                  f'loudnorm=I={target}:TP={peak}:LRA=11:print_format=json', '-f', 'null', '-'])
    match = re.search(r'\{\s*"input_i".*?\}', result.stderr, re.S)
    if not match:
        raise MediaError('Measurement failed')
    return json.loads(match.group())


def master(source, folder, s):
    prepared = folder / 'eq-compressed.wav'
    filters = [f'equalizer=f={freq}:t=q:w=1:g={gain}' for freq, gain in zip((60, 250, 1000, 4000, 12000), s['eq'])]
    filters += [f'acompressor=threshold={10 ** (s["threshold"] / 20)}:ratio={s["ratio"]}:attack=20:release=250:makeup=1']
    ffmpeg(source, prepared, ','.join(filters))
    m = measure(prepared, s['lufs'], s['ceiling'])
    output = folder / 'master.wav'
    fields = ('input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset')
    if all(math.isfinite(float(m[k])) for k in fields):
        norm = (f'loudnorm=I={s["lufs"]}:TP={s["ceiling"]}:LRA=11:measured_I={m["input_i"]}'
                f':measured_TP={m["input_tp"]}:measured_LRA={m["input_lra"]}'
                f':measured_thresh={m["input_thresh"]}:offset={m["target_offset"]}:linear=true')
        ffmpeg(prepared, output, norm)
    else:
        # Silence has no finite integrated loudness. Preserve silence, report null.
        ffmpeg(prepared, output)
    measured = measure(output, s['lufs'], s['ceiling'])
    peak = float(measured['input_tp'])
    if math.isfinite(peak) and peak > float(s['ceiling']) + 0.05:
        # Resampling/PCM rounding can introduce small overshoots. Attenuate then remeasure.
        adjusted = folder / 'adjusted.wav'
        ffmpeg(output, adjusted, f'volume={float(s["ceiling"]) - peak - 0.1}dB')
        adjusted.replace(output)
        measured = measure(output, s['lufs'], s['ceiling'])
    def finite(key):
        n = float(measured[key])
        return n if math.isfinite(n) else None
    report = folder / 'loudness-report.json'
    report.write_text(json.dumps({'integrated_lufs': finite('input_i'), 'true_peak_dbtp': finite('input_tp'),
        'target_lufs': float(s['lufs']), 'ceiling_dbtp': float(s['ceiling']),
        'note': 'Measured output; loudness target may be limited by dynamics or silence.'}, indent=2))
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
