"""Podcast lifecycle uses the existing atomic prepare/complete billing RPCs."""

import json
import tempfile
import uuid
from pathlib import Path
from workers.defaults import with_defaults
from workers.podcast import (
    validate_settings,
    prepare,
    build_mix,
    render,
    spans,
    validate_transcript,
)


def handle_podcast_job(db, job, worker_id, url, key):
    from workers.timeline_tools_worker import (
        transfer_input,
        transfer_output,
        transfer_stem,
        podcast_asr,
    )
    from workers.studio_export import validate_export

    job_id = job["id"]
    paths = []
    committed = False
    completion_attempted = False
    step = "podcast_validate"
    code = "processing"

    def at(name):
        nonlocal step, code
        step = name
        code = (
            "invalid_media"
            if name in ("podcast_probe", "podcast_decode")
            else "processing"
        )

    def log(error):
        print(f"podcast step={step} {type(error).__name__}")

    try:
        expected = str(uuid.UUID(job["user_id"]))
        settings = with_defaults(job["type"], job["settings"])
        parent = None
        if job["type"] == "podcast_export":
            if type(settings.get("speaker_labels")) is not bool:
                raise ValueError("Invalid labels")
            validate_export(
                {k: v for k, v in settings.items() if k != "speaker_labels"}
            )
            if "wav" in settings and settings["wav"]["sample_rate"] not in (
                44100,
                48000,
            ):
                raise ValueError("Invalid Podcast sample rate")
            parent = (
                db.table("jobs")
                .select("*")
                .eq("id", job["parent_job_id"])
                .eq("user_id", expected)
                .eq("type", "podcast")
                .eq("status", "done")
                .single()
                .execute()
                .data
            )
            if not parent:
                raise ValueError("Parent unavailable")
        else:
            validate_settings(settings)
        with tempfile.TemporaryDirectory(prefix="podcast-") as directory:
            folder = Path(directory)
            if parent:
                snapshot = job["arrangement_snapshot"]
                transcript = validate_transcript(snapshot["transcript"])
                edits = snapshot["edits"]
                from workers.podcast import validate_edits

                validate_edits(edits, transcript, snapshot["duration"])
                _, seconds = spans(snapshot["duration"], edits)
                source_path = snapshot["source_path"]
                if (
                    source_path != f"{expected}/{parent['id']}/podcast-source.wav"
                    or source_path not in parent["output_paths"]
                ):
                    raise ValueError("Invalid source")
                source = folder / "podcast-source.wav"
                at("podcast_source_transfer")
                transfer_stem(url, key, source_path, source)
            else:
                parts = job["input_path"].split("/")
                if len(parts) != 2 or parts[0] != expected or not re_bundle(parts[1]):
                    raise ValueError("Invalid input owner")
                source = folder / "input.zip"
                at("podcast_input_transfer")
                transfer_input(url, key, job["input_path"], source)
                consumed = 0
                limit = None

                def fetch_media(item, target):
                    nonlocal consumed, limit
                    from urllib.parse import quote
                    import httpx

                    path = item["storage_path"]
                    if path != expected + "/" + item["file"]:
                        raise ValueError("Invalid media owner")
                    if limit is None:
                        profile = (
                            db.table("profiles")
                            .select("plans(max_file_mb)")
                            .eq("id", expected)
                            .single()
                            .execute()
                            .data
                        )
                        limit = int(profile["plans"]["max_file_mb"]) * 1048576
                    info = httpx.get(
                        f'{url}/storage/v1/object/info/uploads/{quote(path,safe="/")}',
                        headers={"Authorization": f"Bearer {key}", "apikey": key},
                        timeout=60,
                    )
                    info.raise_for_status()
                    size = info.json().get("size")
                    if type(size) is not int or size <= 0:
                        raise ValueError("Invalid object size")
                    consumed += size
                    if consumed + source.stat().st_size > limit:
                        raise ValueError("Project exceeds plan upload limit")
                    transfer_input(url, key, path, target)
                    if target.stat().st_size != size:
                        raise ValueError("Object size changed")

                project = prepare(
                    source, folder, settings, on_step=at, fetch_media=fetch_media
                )
                seconds = project["seconds"]
            at("worker_prepare")
            if (
                not db.rpc(
                    "worker_prepare",
                    {
                        "p_job_id": job_id,
                        "p_worker_id": worker_id,
                        "p_duration": seconds,
                    },
                )
                .execute()
                .data
            ):
                return
            if parent:
                at("podcast_export_render")
                outputs = render(
                    source, folder, transcript, edits, settings, snapshot["duration"]
                )
            else:
                at("podcast_clean_mix")
                mix, outputs = build_mix(project, folder, settings)
                source_path = f"{expected}/{job_id}/podcast-source.wav"
                paths.append(source_path)
                at("podcast_mix_transfer")
                transfer_output(url, key, source_path, mix)
                at("podcast_asr")
                transcript = validate_transcript(
                    podcast_asr.remote(url, key, source_path, settings.get("speakers"))
                )
                if any(
                    w["end"] > project["duration"] + 0.001 for w in transcript["words"]
                ):
                    raise ValueError("Transcript exceeds media duration")
                report = folder / "transcript.json"
                report.write_text(
                    json.dumps(transcript, ensure_ascii=False, allow_nan=False)
                )
                outputs.append(report)
            at("podcast_output_transfer")
            for output in outputs:
                path = f"{expected}/{job_id}/{output.relative_to(folder).as_posix()}"
                paths.append(path)
                transfer_output(url, key, path, output)
            if not parent:
                at("podcast_save")
                db.table("podcast_projects").insert(
                    dict(
                        job_id=job_id,
                        user_id=expected,
                        duration=project["duration"],
                        source_path=source_path,
                        peaks_path=f"{expected}/{job_id}/podcast-peaks.json",
                    )
                ).execute()
                db.table("podcast_media").insert(
                    [
                        dict(
                            project_id=job_id,
                            user_id=expected,
                            media_index=m["index"],
                            name=m["name"],
                            offset_sec=m["offset"],
                            duration=m["duration"],
                            proxy_path=(
                                f"{expected}/{job_id}/{m['proxy_file']}"
                                if m["proxy_file"]
                                else None
                            ),
                        )
                        for m in project["media"]
                    ]
                ).execute()
                db.table("podcast_transcripts").insert(
                    dict(project_id=job_id, user_id=expected, transcript=transcript)
                ).execute()
                db.table("podcast_edits").insert(
                    dict(
                        project_id=job_id,
                        user_id=expected,
                        edits=dict(operations=[], corrections={}, speaker_names={}),
                    )
                ).execute()
            at("worker_complete")
            completion_attempted = True
            committed = bool(
                db.rpc(
                    "worker_complete",
                    {"p_job_id": job_id, "p_worker_id": worker_id, "p_outputs": paths},
                )
                .execute()
                .data
            )
    except Exception as error:
        log(error)
    finally:
        if not committed:
            safe = not completion_attempted
            if completion_attempted:
                try:
                    status = (
                        db.table("jobs")
                        .select("status")
                        .eq("id", job_id)
                        .single()
                        .execute()
                        .data["status"]
                    )
                    committed = status == "done"
                    safe = status == "failed"
                except Exception as error:
                    log(error)
                    safe = False
            if not committed:
                try:
                    safe = (
                        bool(
                            db.rpc(
                                "worker_fail",
                                {
                                    "p_job_id": job_id,
                                    "p_worker_id": worker_id,
                                    "p_code": code,
                                },
                            )
                            .execute()
                            .data
                        )
                        or safe
                    )
                except Exception as error:
                    log(error)
                if safe and paths:
                    try:
                        db.storage.from_("outputs").remove(paths)
                    except Exception as error:
                        log(error)


def re_bundle(name):
    import re

    return bool(re.fullmatch(r"[0-9a-f-]+\.zip", name))
