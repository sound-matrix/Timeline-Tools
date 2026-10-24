"""Podcast media, diarization and non-destructive word editing.

All heavyweight model imports are lazy. No shell strings or user-derived filters.
Times are finite native floats rounded to six decimals. Probe/decode is isolated
from ASR/diarization/encoding so failures receive honest worker error codes.
"""

import json
import math
import re
import zipfile
from pathlib import Path
from types import SimpleNamespace
from workers.audio import duration, ffmpeg, run, clean, write_subtitles

MEDIA = {"wav", "mp3", "m4a", "flac", "aac", "ogg", "mp4", "mov", "mkv", "webm"}
VIDEO = {"mp4", "mov", "mkv", "webm"}
MAX_BYTES = 250 * 1024 * 1024


def finite(v, lo=0, hi=14400):
    from numbers import Real

    if (
        isinstance(v, bool)
        or not isinstance(v, Real)
        or not math.isfinite(float(v))
        or not lo <= float(v) <= hi
    ):
        raise ValueError("Invalid numeric value")
    return round(float(v), 6)


def validate_settings(s):
    from workers.audio import validate

    if (
        not isinstance(s, dict)
        or set(s) - {"cleanup", "mode", "speakers"}
        or s.get("mode") not in ("sequential", "mics")
    ):
        raise ValueError("Invalid podcast settings")
    validate("clean", s.get("cleanup"))
    if "speakers" in s and (
        type(s["speakers"]) is not int or not 1 <= s["speakers"] <= 12
    ):
        raise ValueError("Invalid speaker count")


def unpack(source, folder, fetch_media=None):
    if source.stat().st_size > MAX_BYTES:
        raise ValueError("Bundle too large")
    with zipfile.ZipFile(source) as z:
        infos = z.infolist()
        names = [i.filename for i in infos]
        if (
            not 1 <= len(infos) <= 201
            or len(set(names)) != len(names)
            or sum(i.file_size for i in infos) > MAX_BYTES
        ):
            raise ValueError("Invalid bundle")
        for i in infos:
            if (
                not re.fullmatch(r"[A-Za-z0-9_-]+\.[a-z0-9]+", i.filename)
                or i.compress_type != zipfile.ZIP_STORED
                or i.flag_bits & 1
                or (i.external_attr >> 16) & 0o170000 == 0o120000
            ):
                raise ValueError("Unsafe bundle")
        if z.getinfo("manifest.json").file_size > 131072:
            raise ValueError("Manifest too large")
        m = json.loads(z.read("manifest.json"))
        if (
            not isinstance(m, dict)
            or set(m) != {"version", "mode", "media"}
            or m["version"] not in (1, 2)
            or m["mode"] not in ("sequential", "mics")
            or not isinstance(m["media"], list)
            or not 1 <= len(m["media"]) <= 200
        ):
            raise ValueError("Invalid manifest")
        required = ["manifest.json"]
        for item in m["media"]:
            if (
                not isinstance(item, dict)
                or set(item)
                != (
                    {"file", "name", "offset", "storage_path"}
                    if m["version"] == 2
                    else {"file", "name", "offset"}
                )
                or not isinstance(item["file"], str)
                or (m["version"] == 1 and item["file"] not in names)
                or item["file"].split(".")[-1] not in MEDIA
                or not isinstance(item["name"], str)
                or not 1 <= len(item["name"]) <= 255
            ):
                raise ValueError("Invalid media")
            item["offset"] = finite(item["offset"], 0, 3600)
            if m["version"] == 1:
                required.append(item["file"])
            elif not re.fullmatch(
                r"[0-9a-f-]+\.[a-z0-9]+", item["file"]
            ) or not isinstance(item.get("storage_path"), str):
                raise ValueError("Invalid storage reference")
            if m["mode"] == "sequential" and item["offset"] != 0:
                raise ValueError("Offsets require mic mode")
        if len(set(required)) != len(required) or set(required) != set(names):
            raise ValueError("Unexpected members")
        folder.mkdir(exist_ok=True)
        for name in required[1:]:
            with z.open(name) as src, (folder / name).open("wb") as dst:
                while chunk := src.read(1024 * 1024):
                    dst.write(chunk)
        if m["version"] == 2:
            if fetch_media is None:
                raise ValueError("Storage references require verified downloads")
            seen = set()
            for item in m["media"]:
                if item["storage_path"] in seen or item["file"] in seen:
                    raise ValueError("Duplicate storage reference")
                seen.update([item["storage_path"], item["file"]])
                fetch_media(item, folder / item["file"])
        return m


def prepare(source, folder, settings, on_step=lambda _: None, fetch_media=None):
    on_step("podcast_unpack")
    assets = folder / "assets"
    manifest = unpack(source, assets, fetch_media)
    if manifest["mode"] != settings["mode"]:
        raise ValueError("Manifest mode differs from settings")
    on_step("podcast_probe")
    durations = [duration(assets / m["file"]) for m in manifest["media"]]
    if sum(durations) > 14400:
        raise ValueError("Four-hour processing budget exceeded")
    decoded = []
    on_step("podcast_decode")
    for i, m in enumerate(manifest["media"]):
        dest = folder / f"decoded-{i}.wav"
        ffmpeg(assets / m["file"], dest)
        decoded.append(dest)
    length = (
        sum(durations)
        if manifest["mode"] == "sequential"
        else max(m["offset"] + d for m, d in zip(manifest["media"], durations))
    )
    if length > 14400:
        raise ValueError("Four-hour session budget exceeded")
    return dict(
        manifest=manifest,
        assets=assets,
        decoded=decoded,
        durations=durations,
        seconds=sum(durations),
        duration=length,
    )


def video_proxy_command(source, target):
    return [
        "ffmpeg",
        "-v",
        "error",
        "-y",
        "-nostdin",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0",
        "-vf",
        "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2",
        "-c:v",
        "libx264",
        "-preset",
        "fast",
        "-crf",
        "24",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-movflags",
        "+faststart",
        str(target),
    ]


def write_peaks(source,target):
    import numpy as np
    import soundfile as sf
    values=[]
    with sf.SoundFile(source) as f:
        for block in f.blocks(blocksize=max(1,f.samplerate//100),dtype='float32',always_2d=True):
            mono=block.mean(axis=1);values.append([int(np.clip(mono.min()*127,-128,127)),int(np.clip(mono.max()*127,-128,127))])
    target.write_text(json.dumps(dict(rate=100,peaks=values),separators=(',',':')))


def build_mix(project, folder, settings):
    # Clean each input with the same pipeline used by /cleanup.
    tracks = []
    outputs = []
    media = []
    cursor = 0
    for i, (item, path, d) in enumerate(
        zip(project["manifest"]["media"], project["decoded"], project["durations"])
    ):
        work = folder / f"cleanup-{i}"
        work.mkdir()
        cleaned=clean(path,work,settings['cleanup'])[0]
        import shutil
        stem=folder/f'podcast-clip-{i}.wav';shutil.copyfile(cleaned,stem)
        tracks.append(stem);outputs.append(stem)
        peak=folder/f'podcast-clip-{i}-peaks.json';write_peaks(stem,peak);outputs.append(peak)
        offset = cursor if settings["mode"] == "sequential" else item["offset"]
        preview = None
        if Path(item["file"]).suffix[1:] in VIDEO:
            preview = folder / f"proxy-{i}.mp4"
            run(video_proxy_command(project["assets"] / item["file"], preview))
            outputs.append(preview)
        media.append(
            dict(
                index=i,
                name=item["name"],
                offset=offset,
                duration=d,
                proxy_file=preview.name if preview else None,
                audio_file=stem.name,peaks_file=peak.name,
            )
        )
        cursor += d
    args = ["ffmpeg", "-v", "error", "-y", "-nostdin"]
    for t in tracks:
        args += ["-i", str(t)]
    if settings["mode"] == "sequential":
        graph = (
            "".join(f"[{i}:a]" for i in range(len(tracks)))
            + f"concat=n={len(tracks)}:v=0:a=1[out]"
        )
    else:
        graph = ";".join(
            f'[{i}:a]adelay={round(m["offset"]*1000)}:all=1[t{i}]'
            for i, m in enumerate(media)
        )
        graph += (
            ";"
            + "".join(f"[t{i}]" for i in range(len(tracks)))
            + f"amix=inputs={len(tracks)}:normalize=1:duration=longest[out]"
        )
    mix = folder / "podcast-source.wav"
    run(
        args
        + [
            "-filter_complex",
            graph,
            "-map",
            "[out]",
            "-ar",
            "48000",
            "-ac",
            "2",
            "-c:a",
            "pcm_s24le",
            "-rf64",
            "auto",
            str(mix),
        ]
    )
    preview = folder / "podcast-preview.mp3"
    run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(mix),
            "-c:a",
            "libmp3lame",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            str(preview),
        ]
    )
    outputs.append(preview)
    project["media"] = media
    # Same compact waveform format as Studio; bounded reading, no full-recording array.
    import numpy as np
    import soundfile as sf

    peaks = []
    with sf.SoundFile(mix) as f:
        for block in f.blocks(blocksize=480, dtype="float32", always_2d=True):
            mono = block.mean(axis=1)
            peaks.append(
                [
                    int(np.clip(mono.min() * 127, -128, 127)),
                    int(np.clip(mono.max() * 127, -128, 127)),
                ]
            )
    peak = folder / "podcast-peaks.json"
    peak.write_text(json.dumps(dict(rate=100, peaks=peaks), separators=(",", ":")))
    return mix, outputs + [peak]


def assign_words(words, turns):
    """Choose the turn with maximum overlap; nearest turn only for boundary gaps."""
    out = []
    for word in words:
        a, b = finite(word["start"]), finite(word["end"])
        if b <= a:
            continue
        if not turns:
            raise ValueError("Diarization returned no turns")
        turn = max(
            turns,
            key=lambda t: (
                max(0, min(b, t["end"]) - max(a, t["start"])),
                -abs((a + b - t["start"] - t["end"]) / 2),
            ),
        )
        out.append(
            dict(
                w=word["w"].strip()[:300],
                start=a,
                end=b,
                speaker=turn["speaker"],
                conf=finite(word.get("conf", 0), 0, 1),
            )
        )
    return out


def cluster_turns(path, seconds, speakers=None, encoder=None):
    import numpy as np
    import soundfile as sf
    from sklearn.cluster import AgglomerativeClustering

    windows = []
    embeddings = []
    if encoder is None:
        from speechbrain.inference.speaker import EncoderClassifier

        encoder = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb",
            savedir="/models/ecapa",
            run_opts={"device": "cpu"},
        )
    import torch

    # Speech-only windows; silent stretches cannot manufacture speaker clusters.
    from workers.studio_audio import speech_regions

    active, _ = speech_regions(path, seconds)
    with sf.SoundFile(path) as f:
        for a, b in active:
            for start in np.arange(a, b, 1.5):
                end = min(b, float(start) + 1.5)
                if end - start < 0.25:
                    continue
                f.seek(round(float(start) * f.samplerate))
                samples = f.read(
                    round((end - start) * f.samplerate), dtype="float32", always_2d=True
                ).mean(axis=1)
                # ECAPA expects 16 kHz; the GPU function decodes this input at 16k.
                embedding = (
                    encoder.encode_batch(torch.from_numpy(samples).unsqueeze(0))
                    .detach()
                    .cpu()
                    .numpy()
                    .reshape(-1)
                )
                if not np.isfinite(embedding).all():
                    raise ValueError("Invalid embedding")
                windows.append((finite(float(start)), finite(end)))
                embeddings.append(
                    embedding / max(float(np.linalg.norm(embedding)), 1e-9)
                )
    if not windows:
        raise ValueError("No speech detected")
    if len(windows) == 1:
        labels = [0]
    else:
        n = min(speakers, len(windows)) if speakers else None
        labels = AgglomerativeClustering(
            n_clusters=n,
            distance_threshold=None if n else 0.35,
            metric="cosine",
            linkage="average",
        ).fit_predict(embeddings)
    # Stable speaker IDs follow first occurrence, not arbitrary clustering IDs.
    ids = {}
    turns = []
    for (start, end), label in zip(windows, labels):
        if int(label) not in ids:
            ids[int(label)] = f"s{len(ids)}"
        turns.append(dict(start=start, end=end, speaker=ids[int(label)]))
    return turns


def asr(path, speakers=None, device="cuda"):
    from workers.studio_audio import model
    import os
    import soundfile as sf

    decoded = path.with_name("asr-16k.wav")
    run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-nostdin",
            "-protocol_whitelist",
            "file,pipe",
            "-i",
            str(path),
            "-vn",
            "-ar",
            "16000",
            "-ac",
            "1",
            str(decoded),
        ]
    )
    segments, _ = model(device).transcribe(
        str(decoded), word_timestamps=True, vad_filter=True, beam_size=5
    )
    words = []
    for segment in segments:
        for w in segment.words or []:
            words.append(
                dict(
                    w=w.word,
                    start=finite(w.start),
                    end=finite(w.end),
                    conf=finite(w.probability, 0, 1),
                )
            )
    if not words:
        raise ValueError("No speech detected")
    method = "ecapa-clustering"
    turns = None
    if os.getenv("HF_TOKEN"):
        try:
            from pyannote.audio import Pipeline
            import torch

            pipeline = Pipeline.from_pretrained(
                "pyannote/speaker-diarization-3.1",
                use_auth_token=os.environ["HF_TOKEN"],
                cache_dir="/models/pyannote",
            )
            pipeline.to(torch.device(device))
            result = pipeline(
                str(decoded), **({"num_speakers": speakers} if speakers else {})
            )
            turns = [
                dict(start=finite(t.start), end=finite(t.end), speaker=str(label))
                for t, _, label in result.itertracks(yield_label=True)
            ]
            ids = {
                label: f"s{i}"
                for i, label in enumerate(dict.fromkeys(t["speaker"] for t in turns))
            }
            turns = [{**t, "speaker": ids[t["speaker"]]} for t in turns]
            method = "pyannote-3.1"
        except Exception as error:
            print(f"podcast step=diarization_fallback {type(error).__name__}")
    if not turns:
        turns = cluster_turns(decoded, sf.info(decoded).duration, speakers)
    assigned = assign_words(words, turns)
    ids = list(dict.fromkeys(w["speaker"] for w in assigned))
    transcript = dict(
        speakers=[dict(id=s, name=f"Speaker {i+1}") for i, s in enumerate(ids)],
        words=assigned,
        segments=[],
        method=method,
    )
    for w in assigned:
        last = transcript["segments"][-1] if transcript["segments"] else None
        if (
            last
            and last["speaker"] == w["speaker"]
            and w["start"] - last["end"] < 0.8
            and len(last["text"]) < 4000
        ):
            last["text"] += " " + w["w"]
            last["end"] = w["end"]
        else:
            transcript["segments"].append(
                dict(text=w["w"], start=w["start"], end=w["end"], speaker=w["speaker"])
            )
    return validate_transcript(transcript)


def validate_transcript(t):
    if (
        not isinstance(t, dict)
        or set(t) != {"speakers", "words", "segments", "method"}
        or not 1 <= len(t["words"]) <= 60000
        or not 1 <= len(t["speakers"]) <= 100
        or len(json.dumps(t).encode()) > 16 * 1024 * 1024
    ):
        raise ValueError("Invalid transcript")
    ids = {s["id"] for s in t["speakers"]}
    if len(ids) != len(t["speakers"]):
        raise ValueError("Duplicate speakers")
    previous = -1
    for w in t["words"]:
        for k in ("start", "end"):
            w[k] = finite(w[k])
        w["conf"] = finite(w["conf"], 0, 1)
        if (
            w["end"] <= w["start"]
            or w["start"] < previous
            or w["speaker"] not in ids
            or not isinstance(w["w"], str)
        ):
            raise ValueError("Invalid word")
        previous = w["start"]
    return t


def cuts(edits):
    out = []
    for op in sorted(
        (o for o in edits["operations"] if o["op"] == "delete"),
        key=lambda o: o["start"],
    ):
        if out and op["start"] <= out[-1][1]:
            out[-1][1] = max(out[-1][1], op["end"])
        else:
            out.append([op["start"], op["end"]])
    return out


def validate_edits(edits, transcript, seconds):
    if (
        not isinstance(edits, dict)
        or set(edits)-{"timeline"} != {"operations", "corrections", "speaker_names"}
        or len(edits["operations"]) > 2000
        or len(json.dumps(edits).encode()) > 4 * 1024 * 1024
    ):
        raise ValueError("Invalid edits")
    for op in edits["operations"]:
        kind = op.get("op")
        if kind not in ("insert", "delete", "mute", "bleep") or set(op) != (
            {"op", "at", "duration"}
            if kind == "insert"
            else (
                {"op", "start", "end", "db"}
                if kind == "bleep"
                else {"op", "start", "end"}
            )
        ):
            raise ValueError("Invalid edit")
        if kind == "insert":
            finite(op["at"], 0, seconds)
            finite(op["duration"], 0.000001, 60)
        else:
            finite(op["start"], 0, seconds)
            finite(op["end"], 0, seconds)
            if op["end"] <= op["start"]:
                raise ValueError("Invalid range")
            if kind == "bleep":
                finite(op["db"], -60, 0)
    if any(
        not re.fullmatch(r"\d{1,5}", str(k))
        or not 0 <= int(k) < len(transcript["words"])
        or not isinstance(v, str)
        or not 1 <= len(v) <= 300
        for k, v in edits["corrections"].items()
    ):
        raise ValueError("Invalid corrections")
    ids = {s["id"] for s in transcript["speakers"]}
    if any(
        k not in ids or not isinstance(v, str) or not 1 <= len(v) <= 60
        for k, v in edits["speaker_names"].items()
    ):
        raise ValueError("Invalid speakers")
    if 'timeline' in edits:
        from workers.studio_audio import validate_arrangement
        timeline=validate_arrangement(edits['timeline'])
        if any((c['id']=='source' and abs(c['duration']-seconds)>.001) or (c['id']!='source' and not re.fullmatch(r'c\d{1,3}',c['id'])) for c in timeline['clips']):raise ValueError('Invalid podcast source')
    return edits


def spans(seconds, edits):
    removed = cuts(edits)
    inserts = {}
    for o in edits["operations"]:
        if o["op"] == "insert" and not any(a < o["at"] < b for a, b in removed):
            inserts[o["at"]] = inserts.get(o["at"], 0) + o["duration"]
    points = sorted(set([0, seconds] + [v for c in removed for v in c] + list(inserts)))
    result = []
    cursor = 0
    for i, a in enumerate(points):
        if a in inserts:
            result.append(
                dict(kind="gap", start=a, end=a, out=cursor, length=inserts[a])
            )
            cursor += inserts[a]
        if i == len(points) - 1:
            break
        b = points[i + 1]
        if any(a >= left and b <= right for left, right in removed):
            continue
        result.append(dict(kind="source", start=a, end=b, out=cursor, length=b - a))
        cursor += b - a
    return result, round(cursor, 6)


def remap(value, edits, include_boundary=True):
    return (
        value
        - sum(max(0, min(value, b) - a) for a, b in cuts(edits))
        + sum(
            o["duration"]
            for o in edits["operations"]
            if o["op"] == "insert"
            and (o["at"] <= value if include_boundary else o["at"] < value)
            and not any(a < o["at"] < b for a, b in cuts(edits))
        )
    )


def edited_words(transcript, edits):
    removed = cuts(edits)
    return [
        dict(
            **{
                **w,
                "w": edits["corrections"].get(str(i), w["w"]),
                "start": round(remap(w["start"], edits), 6),
                "end": round(remap(w["end"], edits, False), 6),
            }
        )
        for i, w in enumerate(transcript["words"])
        if not any(w["start"] < b and w["end"] > a for a, b in removed)
    ]


def local_edits(edits,offset,seconds):
    operations=[]
    for o in edits['operations']:
        if o['op']=='insert':
            if offset<=o['at']<=offset+seconds:operations.append(dict(o,at=o['at']-offset))
        else:
            a=max(0,o['start']-offset);b=min(seconds,o['end']-offset)
            if b>a:operations.append(dict(o,start=a,end=b))
    return dict(operations=operations,corrections={},speaker_names={})


def timeline_words(transcript,edits,rendered):
    if not edits.get('timeline'):return edited_words(transcript,edits)
    original=edits['timeline'];clips={c['id']:c for c in original['clips']};regions={r['id']:r for r in rendered['regions']};words=[]
    removed=cuts(edits)
    for i,w in enumerate(transcript['words']):
        if any(w['start']<b and w['end']>a for a,b in removed):continue
        for r in original['regions']:
            c=clips.get(r['clip']);target=regions.get(r['id'])
            if not c or not target:continue
            offset=c.get('offset',0);start=w['start']-offset;end=w['end']-offset
            if end<=r['src_start'] or start>=r['src_end']:continue
            e=edits if c['id']=='source' else local_edits(edits,offset,c['duration'])
            a=target['start']+remap(max(start,r['src_start']),e)-target['src_start'];b=target['start']+remap(min(end,r['src_end']),e,False)-target['src_start']
            if b>a:words.append(dict(w,w=edits['corrections'].get(str(i),w['w']),start=a,end=b))
    return sorted(words,key=lambda w:w['start'])


def render_clip_timeline(folder,transcript,edits,settings,clip_sources):
    import copy
    from workers.studio_audio import render as render_timeline
    a=copy.deepcopy(edits['timeline']);local={};stems={}
    for c in a['clips']:
        if c['id'] not in clip_sources:raise ValueError('Source clip unavailable')
        e=local_edits(edits,c.get('offset',0),c['duration']);local[c['id']]=e
        if remap(c['duration'],e)<=0:
            stems[c['id']]=clip_sources[c['id']];c['duration']=.001;continue
        work=folder/f"clip-{len(stems)}";work.mkdir()
        render(clip_sources[c['id']],work,transcript,e,dict(settings,formats=[],subtitles=[]),c['duration'])
        stems[c['id']]=work/'podcast-edited.wav';c['duration']=remap(c['duration'],e)
    a['duration']=remap(a['duration'],edits)
    a['regions']=[dict(r,src_start=remap(r['src_start'],local.get(r['clip'],edits)),src_end=remap(r['src_end'],local.get(r['clip'],edits),False),start=remap(r['start'],edits)) for r in a['regions'] if remap(r['src_end'],local.get(r['clip'],edits),False)>remap(r['src_start'],local.get(r['clip'],edits))]
    a['loop']=dict(a['loop'],start=min(a['duration']-.001,remap(a['loop']['start'],edits)),end=remap(a['loop']['end'],edits))
    a['markers']=[dict(m,time=remap(m['time'],edits)) for m in a['markers']]
    paths=render_timeline(dict(stems=stems),a,folder,dict(room_tone=dict(enabled=False),master_lufs=-16),dict(settings,subtitles=[],missing_lines='exclude'))
    outputs=[]
    for path in paths:
        renamed=folder/path.name.replace('studio-mix','podcast');path.rename(renamed);outputs.append(renamed)
    words=timeline_words(transcript,edits,a)
    names={s['id']:edits['speaker_names'].get(s['id'],s['name']) for s in transcript['speakers']}
    outputs+=write_subtitles([SimpleNamespace(start=w['start'],end=w['end'],text=(names[w['speaker']]+': ' if settings.get('speaker_labels') else '')+w['w']) for w in words],folder,settings['subtitles'])
    report=folder/'edited-transcript.json';report.write_text(json.dumps(dict(speakers=[dict(id=k,name=v) for k,v in names.items()],words=words),ensure_ascii=False));outputs.append(report)
    return outputs


def render(source, folder, transcript, edits, settings, seconds, clip_sources=None):
    import numpy as np
    import soundfile as sf

    validate_edits(edits, transcript, seconds)
    if edits.get('timeline') and any(c['id']!='source' for c in edits['timeline']['clips']):
        return render_clip_timeline(folder,transcript,edits,settings,clip_sources or {})
    plan, length = spans(seconds, edits)
    if not 0 < length <= 14400:
        raise ValueError("Invalid output duration")
    raw = folder / "podcast-edited.wav"
    # Stream in half-second chunks; never allocate a multi-hour waveform.
    with sf.SoundFile(source) as src, sf.SoundFile(
        raw, "w", samplerate=48000, channels=2, subtype="PCM_24", format="RF64"
    ) as dst:
        for pos, span in enumerate(plan):
            total = round((span["out"] + span["length"]) * 48000) - round(
                span["out"] * 48000
            )
            for offset in range(0, total, 24000):
                n = min(24000, total - offset)
                if span["kind"] == "gap":
                    block = np.zeros((n, 2), dtype="float32")
                else:
                    origin = round(span["start"] * 48000) + offset
                    src.seek(origin)
                    block = src.read(n, dtype="float32", always_2d=True)
                    if len(block) != n:
                        raise ValueError("Source duration changed")
                    times = (origin + np.arange(n)) / 48000
                    for op in edits["operations"]:
                        if op["op"] not in ("mute", "bleep"):
                            continue
                        mask = (times >= op["start"]) & (times < op["end"])
                        if op["op"] == "mute":
                            block[mask] = 0
                        else:
                            block[mask] = (
                                np.sin(2 * np.pi * 1000 * times[mask])
                                * 10 ** (op["db"] / 20)
                            )[:, None]
                    fade = min(240, total // 2)
                    if fade:
                        index = offset + np.arange(n)
                        if (
                            pos > 0
                            and plan[pos - 1]["kind"] == "source"
                            and plan[pos - 1]["end"] < span["start"]
                        ):
                            before = plan[pos - 1]
                            src.seek(max(0, round(before["end"] * 48000) - 1))
                            edge = src.read(1, dtype="float32", always_2d=True)[0]
                            weight = np.clip((fade - index) / (2 * fade), 0, 0.5)
                            block = (
                                block * (1 - weight[:, None]) + edge * weight[:, None]
                            )
                        if (
                            pos + 1 < len(plan)
                            and plan[pos + 1]["kind"] == "source"
                            and span["end"] < plan[pos + 1]["start"]
                        ):
                            after = plan[pos + 1]
                            src.seek(round(after["start"] * 48000))
                            edge = src.read(1, dtype="float32", always_2d=True)[0]
                            weight = np.clip(
                                (index - (total - 1 - fade)) / (2 * fade), 0, 0.5
                            )
                            block = (
                                block * (1 - weight[:, None]) + edge * weight[:, None]
                            )
                dst.write(block)
    if 'timeline' in edits:
        from workers.studio_audio import validate_arrangement,render as render_timeline
        import copy
        a=copy.deepcopy(edits['timeline']);a['duration']=remap(a['duration'],edits)
        a['clips']=[dict(id='source',name='Podcast source',duration=max(.001,length))]
        a['regions']=[dict(r,src_start=remap(r['src_start'],edits),src_end=remap(r['src_end'],edits,False),start=remap(r['start'],edits)) for r in a['regions'] if remap(r['src_end'],edits,False)>remap(r['src_start'],edits)]
        a['loop']=dict(a['loop'],start=remap(a['loop']['start'],edits),end=remap(a['loop']['end'],edits))
        a['markers']=[dict(m,time=remap(m['time'],edits)) for m in a['markers']]
        timeline_folder=folder/'timeline';timeline_folder.mkdir()
        # v2 timeline does not renormalize the mix after faders/fades.
        paths=render_timeline(dict(stems={'source':raw}),a,timeline_folder,dict(has_bed=False,room_tone=dict(enabled=False),master_lufs=-16),dict(settings,subtitles=[],missing_lines='exclude'))
        # Reuse encoding paths below without a second encode.
        raw=timeline_folder/'dialogue.wav'
    outputs = []
    for fmt in settings["formats"]:
        option = settings[fmt]
        dest = folder / f"podcast.{fmt}"
        codec = (
            ["-c:a", "libmp3lame", "-b:a", f"{option['bitrate_kbps']}k"]
            if fmt == "mp3"
            else [
                "-c:a",
                {16: "pcm_s16le", 24: "pcm_s24le", "32f": "pcm_f32le"}[
                    option["bit_depth"]
                ],
            ]
        )
        run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-i",
                str(raw),
                "-ar",
                str(option["sample_rate"]),
            ]
            + codec
            + (["-rf64", "auto"] if fmt == "wav" else [])
            + [str(dest)]
        )
        outputs.append(dest)
    words = timeline_words(transcript,edits,a) if edits.get('timeline') else edited_words(transcript, edits)
    names = {
        s["id"]: edits["speaker_names"].get(s["id"], s["name"])
        for s in transcript["speakers"]
    }
    cues = [
        SimpleNamespace(
            start=w["start"],
            end=w["end"],
            text=(names[w["speaker"]] + ": " if settings.get("speaker_labels") else "")
            + w["w"],
        )
        for w in words
    ]
    outputs += write_subtitles(cues, folder, settings["subtitles"])
    report = folder / "edited-transcript.json"
    report.write_text(
        json.dumps(
            dict(speakers=[dict(id=k, name=v) for k, v in names.items()], words=words),
            ensure_ascii=False,
            allow_nan=False,
        )
    )
    outputs.append(report)
    return outputs
