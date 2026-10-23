"""CPU-only Audio Studio: bounded bundles, acoustic timing and deterministic mixing.

Confidence is an evidence score, never a probability or an accuracy guarantee.
No model downloads, transcription, voice cloning or network media protocols.
"""
import json
import math
import re
import zipfile
from pathlib import Path
from types import SimpleNamespace

from workers.audio import MediaError, duration, ffmpeg, master, run, write_subtitles

MAX_BYTES = 250 * 1024 * 1024
MEDIA = {'wav', 'mp3', 'm4a', 'flac', 'aac', 'ogg', 'mp4', 'mov', 'mkv', 'webm'}
NOTE = ('Heuristic timing from script order, guide speech regions and dub speech regions. '
        'Confidence measures acoustic coverage, boundary evidence and stretch; it is not a calibrated probability. '
        'No word recognition or ±150 ms guarantee. Review every line before publishing. The guide is not mixed into dialogue.')


def validate_studio(s):
    def shape(v, keys):
        return isinstance(v, dict) and set(v) == set(keys)
    def number(v, low, high):
        return type(v) in (int, float) and math.isfinite(v) and low <= v <= high
    if not isinstance(s, dict):
        return False
    keys = ['dialogue_lufs', 'master_lufs', 'has_bed', 'room_tone', 'subtitles']
    if s.get('has_bed') is True:
        keys += ['ducking_db']
    if not shape(s, keys) or type(s['has_bed']) is not bool:
        return False
    room, subs = s['room_tone'], s['subtitles']
    return (number(s['dialogue_lufs'], -70, -5) and number(s['master_lufs'], -70, -5)
            and (not s['has_bed'] or number(s['ducking_db'], 0, 40))
            and (shape(room, ['enabled']) and room['enabled'] is False or
                 shape(room, ['enabled', 'amount']) and room['enabled'] is True and number(room['amount'], 0, 100))
            and (shape(subs, ['enabled']) and subs['enabled'] is False or
                 shape(subs, ['enabled', 'formats']) and subs['enabled'] is True
                 and isinstance(subs['formats'], list) and 1 <= len(subs['formats']) <= 2
                 and all(f in ('srt', 'vtt') for f in subs['formats']) and len(set(subs['formats'])) == len(subs['formats'])))


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
            if not 0 <= start < end <= 86400 or lines and start < lines[-1]['end']:
                raise ValueError('Script cues must be ordered and non-overlapping')
            add(' '.join(rows[at+1:]), start, end)
    else:
        for line in text.split('\n'):
            add(line)
    if not 1 <= len(lines) <= 300:
        raise ValueError('Use 1-300 script lines')
    return lines


def unpack(source, folder):
    """Accept only flat, stored ZIP members. No extractall, links or compressed bombs."""
    try:
        if source.stat().st_size > MAX_BYTES:
            raise ValueError('Bundle too large')
        with zipfile.ZipFile(source) as archive:
            infos = archive.infolist()
            names = [i.filename for i in infos]
            if not 4 <= len(infos) <= 12 or len(set(names)) != len(names):
                raise ValueError('Invalid bundle')
            if sum(i.file_size for i in infos) > MAX_BYTES:
                raise ValueError('Bundle too large')
            for info in infos:
                if (not re.fullmatch(r'[A-Za-z0-9_-]+\.[a-z0-9]+', info.filename)
                        or info.compress_type != zipfile.ZIP_STORED or info.flag_bits & 1
                        or (info.external_attr >> 16) & 0o170000 == 0o120000):
                    raise ValueError('Invalid archive member')
            if 'manifest.json' not in names or archive.getinfo('manifest.json').file_size > 16384:
                raise ValueError('Manifest missing')
            manifest = json.loads(archive.read('manifest.json'))
            if not isinstance(manifest, dict) or set(manifest) != {'version', 'guide', 'voices', 'bed', 'script'} or type(manifest['version']) is not int or manifest['version'] != 1:
                raise ValueError('Invalid manifest')
            def media(name):
                return isinstance(name, str) and name in names and name.split('.')[-1] in MEDIA
            voices = manifest['voices']
            if not media(manifest['guide']) or not isinstance(voices, list) or not 1 <= len(voices) <= 8:
                raise ValueError('Invalid stems')
            if manifest['bed'] is not None and not media(manifest['bed']):
                raise ValueError('Invalid bed')
            speakers = []
            for voice in voices:
                if (not isinstance(voice, dict) or set(voice) != {'file', 'speaker', 'name'} or not media(voice['file'])
                        or not isinstance(voice['speaker'], str) or len(voice['speaker']) > 60
                        or not isinstance(voice['name'], str) or not 1 <= len(voice['name']) <= 255):
                    raise ValueError('Invalid voice')
                speakers.append(voice['speaker'].strip().casefold())
            if len(voices) > 1 and (not all(speakers) or len(set(speakers)) != len(speakers)):
                raise ValueError('Multiple voice stems need unique speaker labels')
            script = manifest['script']
            if script not in ('script.txt', 'script.srt', 'script.vtt') or script not in names or archive.getinfo(script).file_size > 65536:
                raise ValueError('Invalid script')
            required = ['manifest.json', manifest['guide'], script] + [v['file'] for v in voices] + ([manifest['bed']] if manifest['bed'] else [])
            if len(set(required)) != len(required) or set(required) != set(names):
                raise ValueError('Duplicate or unexpected bundle files')
            text = archive.read(script).decode('utf-8-sig')
            lines = parse_script(text)
            if len(voices) > 1 or speakers[0]:
                if any(l['speaker'].casefold() not in speakers for l in lines):
                    raise ValueError('Every script speaker must match a voice stem')
            folder.mkdir(exist_ok=True)
            for name in required:
                if name == 'manifest.json' or name == script:
                    continue
                with archive.open(name) as src, (folder / name).open('wb') as dst:
                    while chunk := src.read(1024 * 1024):
                        dst.write(chunk)
            return manifest, lines
    except (zipfile.BadZipFile, KeyError, TypeError, UnicodeError, OSError, json.JSONDecodeError):
        raise ValueError('Invalid studio bundle') from None


def prepare(source, folder):
    assets = folder / 'assets'
    manifest, lines = unpack(source, assets)
    names = [manifest['guide']] + [v['file'] for v in manifest['voices']] + ([manifest['bed']] if manifest['bed'] else [])
    durations = {name: duration(assets / name) for name in names}
    # Bound CPU/disk consumption before any decoding or filtering.
    if max(durations.values()) > 3600 or sum(durations.values()) > 7200:
        raise ValueError('Studio supports at most 60 minutes per file / 120 minutes combined')
    seconds = durations[manifest['guide']]
    if any(l['end'] is not None and l['end'] > seconds + .01 for l in lines):
        raise ValueError('Script cues exceed guide duration')
    return dict(manifest=manifest, lines=lines, durations=durations, seconds=seconds, assets=assets)


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


def allocate(lines, regions, seconds):
    """Match line order to acoustic regions; fall back to character-weighted speech time."""
    if len(regions) == len(lines):
        return regions
    spans = regions or [(0, seconds)]
    total = sum(e-s for s, e in spans)
    weights = [max(1, len(l['text'].split()) if ' ' in l['text'] else len(l['text'])) for l in lines]
    def position(amount, end=False):
        for i, (s, e) in enumerate(spans):
            length = e-s
            if amount < length - 1e-9 or end and amount <= length + 1e-9 or i == len(spans)-1:
                return min(e, s+amount)
            amount -= length
        return seconds
    consumed, timings = 0, []
    for weight in weights:
        start = position(total * consumed / sum(weights))
        consumed += weight
        end = position(total * consumed / sum(weights), True)
        timings.append((start, max(start + .001, end)))
    return timings


def coverage(regions, start, end):
    return min(1, sum(max(0, min(e, end)-max(s, start)) for s, e in regions) / max(.001, end-start))


def alignment(project):
    manifest, lines, assets, seconds = (project[k] for k in ('manifest', 'lines', 'assets', 'seconds'))
    guide_regions, quiet = speech_regions(assets / manifest['guide'], seconds)
    target = ([(l['start'], l['end']) for l in lines] if lines[0]['start'] is not None
              else allocate(lines, guide_regions, seconds))
    result, tracks = [], []
    for i, voice in enumerate(manifest['voices']):
        track = f'voice-{i}'
        tracks.append(dict(id=track, name=voice['name'], speaker=voice['speaker']))
        indices = [j for j, l in enumerate(lines) if len(manifest['voices']) == 1 and not voice['speaker']
                   or l['speaker'].casefold() == voice['speaker'].strip().casefold()]
        if not indices:
            raise ValueError('Voice has no matching script lines')
        length = project['durations'][voice['file']]
        regions, _ = speech_regions(assets / voice['file'], length)
        source_times = allocate([lines[j] for j in indices], regions, length)
        for j, (ss, se) in zip(indices, source_times):
            start, end = target[j]
            ratio = (se-ss) / max(.001, end-start)
            guide_coverage, dub_coverage = coverage(guide_regions, start, end), coverage(regions, ss, se)
            boundary = 1 if len(regions) == len(indices) else .45
            stretch = min(ratio, 1/ratio) if ratio > 0 else 0
            score = round(min(.85 if lines[j]['start'] is not None else .65,
                              guide_coverage * dub_coverage * boundary * stretch), 3)
            flags = []
            if len(regions) != len(indices): flags.append('Line boundaries estimated from script length')
            if not .5 <= ratio <= 2: flags.append('Large timing stretch; listen carefully')
            if guide_coverage < .5 or dub_coverage < .5: flags.append('Little acoustic speech evidence')
            if score < .7: flags.append('Low confidence: review timing')
            result.append(dict(text=lines[j]['text'], speaker=lines[j]['speaker'], start=round(start, 3), end=round(end, 3),
                               source_start=round(ss, 3), source_end=round(se, 3), confidence=score, track=track, flags=flags))
    result.sort(key=lambda l: (l['start'], l['track']))
    return dict(method='heuristic-v1', duration=round(seconds, 3), note=NOTE, tracks=tracks, lines=result), quiet


def tempo(ratio):
    # Keep each atempo stage in [0.5,2]. No pitch shift.
    values = []
    while ratio > 2:
        values.append('atempo=2'); ratio /= 2
    while ratio < .5:
        values.append('atempo=0.5'); ratio *= 2
    return ','.join(values + [f'atempo={ratio:.8f}'])


def mix(project, folder, s):
    report, quiet = alignment(project)
    manifest, assets, seconds = (project[k] for k in ('manifest', 'assets', 'seconds'))
    if s['has_bed'] != (manifest['bed'] is not None):
        raise ValueError('Bed settings do not match bundle')
    aligned = []
    for index, voice in enumerate(manifest['voices']):
        decoded = folder / f'dialogue-{index}.wav'
        # Normalize the whole stem to the chosen dialogue target, preserving dynamics.
        stem_folder = folder / f'norm-{index}'; stem_folder.mkdir()
        normalized = master(assets / voice['file'], stem_folder, {
            'eq': {'enabled': False}, 'compressor': {'enabled': False}, 'limiter': {'enabled': False},
            'loudness': {'enabled': True, 'lufs': s['dialogue_lufs']}})[0]
        cues = [l for l in report['lines'] if l['track'] == f'voice-{index}']
        filters, labels = [], []
        # Split one input for all line trims; one process per stem, not per line.
        splits = ''.join(f'[split{n}]' for n in range(len(cues)))
        filters.append(f'[0:a]asplit={len(cues)}{splits}')
        for n, line in enumerate(cues):
            span = max(.001, line['end']-line['start'])
            ratio = max(.001, line['source_end']-line['source_start']) / span
            filters.append(f'[split{n}]atrim=start={line["source_start"]}:end={line["source_end"]},asetpts=N/SR/TB,'
                           f'{tempo(ratio)},asetpts=N/SR/TB,apad=whole_dur={span},atrim=duration={span},adelay={round(line["start"]*1000)}:all=1,asetpts=N/SR/TB[c{n}]')
            labels.append(f'[c{n}]')
        filters.append(''.join(labels) + f'amix=inputs={len(cues)}:normalize=0,asetpts=N/SR/TB,apad=whole_dur={seconds},atrim=duration={seconds}[out]')
        run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-protocol_whitelist', 'file,pipe', '-i', str(normalized),
             '-filter_complex', ';'.join(filters), '-map', '[out]', '-t', str(seconds), '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s24le', str(decoded)])
        aligned.append(decoded)
    # Duck the bed only in the actual aligned dialogue windows.
    windows = [(l['start'], l['end']) for l in report['lines'] if l['confidence'] > 0]
    activity = '+'.join(f'between(t,{start},{end})' for start, end in windows) or '0'
    parts = list(aligned)
    if manifest['bed']:
        bed = folder / 'bed.wav'
        attenuation = 10 ** (-s['ducking_db']/20)
        ffmpeg(assets / manifest['bed'], bed, f"apad=whole_dur={seconds},atrim=duration={seconds},volume='if(gt({activity},0),{attenuation},1)':eval=frame")
        parts.append(bed)
    room = s['room_tone']
    if room['enabled'] and room['amount'] > 0:
        usable = [(start, end) for start, end in quiet if end-start >= .2]
        if usable:
            start, end = max(usable, key=lambda v: v[1]-v[0])
            sample, fill = folder / 'room-sample.wav', folder / 'room.wav'
            ffmpeg(assets / manifest['guide'], sample, f'atrim=start={start}:end={end},asetpts=PTS-STARTPTS')
            run(['ffmpeg', '-v', 'error', '-nostdin', '-y', '-stream_loop', '-1', '-protocol_whitelist', 'file,pipe', '-i', str(sample),
                 '-t', str(seconds), '-af', f"volume='if(gt({activity},0),0,{room['amount']/100})':eval=frame", '-c:a', 'pcm_s24le', str(fill)])
            parts.append(fill)
        else:
            report['note'] += ' Room tone was not added: no quiet guide region was found.'
    raw = folder / 'mix.wav'
    args = ['ffmpeg', '-v', 'error', '-nostdin', '-y']
    for path in parts:
        args += ['-protocol_whitelist', 'file,pipe', '-i', str(path)]
    graph = ''.join(f'[{i}:a]' for i in range(len(parts))) + f'amix=inputs={len(parts)}:normalize=0,atrim=duration={seconds}[out]'
    run(args + ['-filter_complex', graph, '-map', '[out]', '-c:a', 'pcm_s24le', str(raw)])
    final_folder = folder / 'final'; final_folder.mkdir()
    final = master(raw, final_folder, {'eq': {'enabled': False}, 'compressor': {'enabled': False},
                   'limiter': {'enabled': False}, 'loudness': {'enabled': True, 'lufs': s['master_lufs']}})[0]
    output = folder / 'studio-mix.wav'; final.replace(output)
    # Report actual achieved loudness; loudnorm's 0 dBTP safety bound may prevent target.
    report['loudness'] = json.loads((final_folder / 'loudness-report.json').read_text())
    dest = folder / 'alignment-report.json'; dest.write_text(json.dumps(report, ensure_ascii=False, allow_nan=False))
    outputs = [output, dest]
    if s['subtitles']['enabled']:
        segments = [SimpleNamespace(start=l['start'], end=l['end'], text=(l['speaker'] + ': ' if l['speaker'] else '') + l['text']) for l in report['lines']]
        outputs += write_subtitles(segments, folder, s['subtitles']['formats'])
    return outputs


def studio(source, folder, settings):
    return mix(prepare(source, folder), folder, settings)
