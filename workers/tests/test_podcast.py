import copy
import json
import os
import shutil
import tempfile
import unittest
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from workers.defaults import with_defaults
from workers.podcast import (
    assign_words,
    asr,
    validate_settings,
    validate_transcript,
    validate_edits,
    spans,
    edited_words,
    render,
    prepare,
    video_proxy_command,
)

ID = "11111111-1111-4111-8111-111111111111"
TRANSCRIPT = dict(
    speakers=[dict(id="s0", name="Host")],
    words=[
        dict(w="Hello", start=0.0, end=0.4, speaker="s0", conf=0.9),
        dict(w="world", start=2.0, end=2.8, speaker="s0", conf=0.8),
    ],
    segments=[],
    method="synthetic",
)


def edits(operations=None):
    return dict(operations=operations or [], corrections={}, speaker_names={})


def bundle(folder):
    source = folder / "input.zip"
    with zipfile.ZipFile(source, "w", compression=zipfile.ZIP_STORED) as z:
        z.writestr(
            "manifest.json",
            json.dumps(
                dict(
                    version=1,
                    mode="sequential",
                    media=[dict(file="one.mp4", name="one.mp4", offset=0)],
                )
            ),
        )
        z.writestr("one.mp4", b"synthetic media")
    return source


class Podcast(unittest.TestCase):
    def test_word_turn_max_overlap_and_finite_times(self):
        import numpy as np

        words = [
            dict(w="one", start=np.float32(0), end=np.float32(1), conf=np.float32(0.9)),
            dict(w="two", start=1.0, end=2.0, conf=0.8),
        ]
        turns = [
            dict(start=0, end=0.8, speaker="s0"),
            dict(start=0.8, end=2, speaker="s1"),
        ]
        out = assign_words(words, turns)
        self.assertEqual([w["speaker"] for w in out], ["s0", "s1"])
        self.assertIs(type(out[0]["start"]), float)
        with self.assertRaises(ValueError):
            assign_words([dict(w="bad", start=float("nan"), end=1)], turns)

    def test_no_token_uses_real_fallback_interface(self):
        word = SimpleNamespace(word=" Hello", start=0.0, end=1.0, probability=0.9)
        m = MagicMock()
        m.transcribe.return_value = ([SimpleNamespace(words=[word])], None)
        with patch.dict(os.environ, {}, clear=True), patch(
            "workers.studio_audio.model", return_value=m
        ), patch("workers.podcast.run"), patch(
            "soundfile.info", return_value=SimpleNamespace(duration=1)
        ), patch(
            "workers.podcast.cluster_turns",
            return_value=[dict(start=0, end=1, speaker="s0")],
        ) as cluster:
            t = asr(Path("/tmp/source.wav"), device="cpu")
        cluster.assert_called_once()
        self.assertEqual(t["method"], "ecapa-clustering")
        self.assertEqual(t["words"][0]["speaker"], "s0")
        self.assertTrue(m.transcribe.call_args.kwargs["word_timestamps"])

    def test_settings_and_edl_validation(self):
        validate_settings(with_defaults("podcast", {}))
        with self.assertRaises(ValueError):
            validate_settings(with_defaults("podcast", {"speakers": 0}))
        with self.assertRaises(ValueError):
            validate_edits(edits([dict(op="delete", start=1, end=99)]), TRANSCRIPT, 4)
        with self.assertRaises(ValueError):
            validate_edits({**edits(), "corrections": {"999": "bad"}}, TRANSCRIPT, 4)
        self.assertEqual(
            spans(
                4,
                edits(
                    [
                        dict(op="delete", start=1, end=2),
                        dict(op="delete", start=1.5, end=3),
                    ]
                ),
            )[1],
            2,
        )

    def test_video_extract_is_decode_only_and_proxy_h264(self):
        with tempfile.TemporaryDirectory() as d:
            folder = Path(d)
            source = bundle(folder)
            commands = []
            with patch("workers.podcast.duration", return_value=2), patch(
                "workers.audio.run", side_effect=lambda args: commands.append(args)
            ):
                p = prepare(source, folder, with_defaults("podcast", {}))
            command = commands[0]
            self.assertIn("-vn", command)
            self.assertEqual(command[command.index("-ar") + 1], "48000")
            self.assertEqual(p["seconds"], 2)
            proxy = video_proxy_command("source.mp4", "proxy.mp4")
            self.assertIn("libx264", proxy)
            self.assertIn("+faststart", proxy)
            self.assertIn("720", proxy[proxy.index("-vf") + 1])

    def test_billing_order_and_honest_errors(self):
        from workers.podcast_worker import handle_podcast_job

        db = MagicMock()
        events = []

        def rpc(name, *args):
            events.append(name)
            return MagicMock(execute=lambda: SimpleNamespace(data=True))

        db.rpc.side_effect = rpc
        job = dict(
            id=ID,
            user_id=ID,
            input_path=ID + "/22222222-2222-4222-8222-222222222222.zip",
            type="podcast",
            settings={},
        )
        with tempfile.TemporaryDirectory() as d:
            source = bundle(Path(d))

            def transfer(_u, _k, _p, dest):
                shutil.copyfile(source, dest)

            def asr_fail(*args):
                events.append("ASR")
                raise RuntimeError("private error detail")

            with patch(
                "workers.timeline_tools_worker.transfer_input", side_effect=transfer
            ), patch("workers.podcast.duration", return_value=2), patch(
                "workers.audio.run"
            ), patch(
                "workers.podcast_worker.build_mix", return_value=(source, [])
            ), patch(
                "workers.timeline_tools_worker.transfer_output"
            ), patch(
                "workers.timeline_tools_worker.podcast_asr.remote", side_effect=asr_fail
            ):
                handle_podcast_job(db, job, "worker", "https://invalid.test", "secret")
            self.assertLess(events.index("worker_prepare"), events.index("ASR"))
            self.assertEqual(db.rpc.call_args.args[1]["p_code"], "processing")
            events.clear()
            with patch(
                "workers.timeline_tools_worker.transfer_input", side_effect=transfer
            ), patch(
                "workers.podcast.duration", side_effect=ValueError("decode failure")
            ):
                handle_podcast_job(db, job, "worker", "https://invalid.test", "secret")
            self.assertNotIn("worker_prepare", events)
            self.assertEqual(db.rpc.call_args.args[1]["p_code"], "invalid_media")


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg required")
class Render(unittest.TestCase):
    def test_mute_bleep_ripple_gap_length_and_srt_remap(self):
        import numpy as np
        import soundfile as sf

        with tempfile.TemporaryDirectory() as d:
            folder = Path(d)
            source = folder / "source.wav"
            sf.write(
                source,
                np.ones((4 * 48000, 2), dtype="float32") * 0.2,
                48000,
                subtype="PCM_24",
            )
            e = edits(
                [
                    dict(op="mute", start=0, end=0.5),
                    dict(op="bleep", start=0.5, end=1, db=-12),
                    dict(op="delete", start=1, end=2),
                    dict(op="insert", at=3, duration=0.25),
                ]
            )
            settings = with_defaults(
                "podcast_export",
                dict(
                    revision=1,
                    formats=["wav"],
                    subtitles=["srt", "vtt"],
                    speaker_labels=True,
                ),
            )
            outputs = render(source, folder, copy.deepcopy(TRANSCRIPT), e, settings, 4)
            samples, sr = sf.read(folder / "podcast-edited.wav")
            self.assertEqual(sr, 48000)
            self.assertEqual(len(samples), round(3.25 * 48000))
            self.assertLess(np.max(abs(samples[:20000])), 0.00001)
            # Audible 1kHz tone at the requested gain, original speech replaced.
            tone = samples[26000:45000, 0]
            self.assertAlmostEqual(
                np.sqrt(np.mean(tone * tone)), 10 ** (-12 / 20) / np.sqrt(2), places=3
            )
            self.assertLess(
                np.max(abs(samples[round(2.01 * sr) : round(2.24 * sr)])), 0.00001
            )
            srt = (folder / "subtitles.srt").read_text()
            self.assertIn("00:00:01,000 --> 00:00:01,800", srt)
            self.assertIn("Host: world", srt)
            self.assertEqual(len(outputs), 4)


class ReferencedUploads(unittest.TestCase):
    def test_v2_verifies_owner_size_and_downloads_before_prepare(self):
        from workers.podcast_worker import handle_podcast_job

        db = MagicMock()
        db.table.return_value.select.return_value.eq.return_value.single.return_value.execute.return_value.data = {
            "plans": {"max_file_mb": 1}
        }
        events = []

        def rpc(name, *args):
            events.append(name)
            return MagicMock(execute=lambda: SimpleNamespace(data=True))

        db.rpc.side_effect = rpc
        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            source = folder / "v2.zip"
            clip = "33333333-3333-4333-8333-333333333333.wav"
            path = ID + "/" + clip
            manifest = dict(
                version=2,
                mode="sequential",
                media=[
                    dict(file=clip, name="recording.wav", offset=0, storage_path=path)
                ],
            )

            def write():
                with zipfile.ZipFile(source, "w", compression=zipfile.ZIP_STORED) as z:
                    z.writestr("manifest.json", json.dumps(manifest))

            write()

            def transfer(_u, _k, p, dest):
                if p.endswith(".zip"):
                    shutil.copyfile(source, dest)
                else:
                    events.append("download-media")
                    dest.write_bytes(b"wave")

            info = MagicMock()
            info.json.return_value = {"size": 4}

            def asr_fail(*args):
                events.append("ASR")
                raise RuntimeError("offline ASR")

            job = dict(
                id=ID,
                user_id=ID,
                input_path=ID + "/22222222-2222-4222-8222-222222222222.zip",
                type="podcast",
                settings={},
            )
            with patch(
                "workers.timeline_tools_worker.transfer_input", side_effect=transfer
            ), patch("httpx.get", return_value=info), patch(
                "workers.podcast.duration", return_value=2
            ), patch(
                "workers.audio.run"
            ), patch(
                "workers.podcast_worker.build_mix", return_value=(source, [])
            ), patch(
                "workers.timeline_tools_worker.transfer_output"
            ), patch(
                "workers.timeline_tools_worker.podcast_asr.remote", side_effect=asr_fail
            ):
                handle_podcast_job(db, job, "worker", "https://invalid.test", "secret")
            self.assertLess(
                events.index("download-media"), events.index("worker_prepare")
            )
            self.assertLess(events.index("worker_prepare"), events.index("ASR"))
            events.clear()
            manifest["media"][0]["storage_path"] = (
                "22222222-2222-4222-8222-222222222222/" + clip
            )
            write()
            with patch(
                "workers.timeline_tools_worker.transfer_input", side_effect=transfer
            ):
                handle_podcast_job(db, job, "worker", "https://invalid.test", "secret")
            self.assertNotIn("worker_prepare", events)
            events.clear()
            manifest["media"][0]["storage_path"] = path
            write()
            info.json.return_value = {"size": 1048577}
            with patch(
                "workers.timeline_tools_worker.transfer_input", side_effect=transfer
            ), patch("httpx.get", return_value=info):
                handle_podcast_job(db, job, "worker", "https://invalid.test", "secret")
            self.assertNotIn("worker_prepare", events)
            self.assertNotIn("download-media", events)


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg required")
class VideoPipeline(unittest.TestCase):
    def test_real_video_audio_extraction_and_proxy(self):
        from workers.audio import run, duration
        from workers.podcast import build_mix

        with tempfile.TemporaryDirectory() as tmp:
            folder = Path(tmp)
            video = folder / "input.mp4"
            run(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-y",
                    "-f",
                    "lavfi",
                    "-i",
                    "color=c=blue:s=320x180:r=15:d=1",
                    "-f",
                    "lavfi",
                    "-i",
                    "sine=frequency=440:sample_rate=48000:duration=1",
                    "-c:v",
                    "libx264",
                    "-pix_fmt",
                    "yuv420p",
                    "-c:a",
                    "aac",
                    "-shortest",
                    str(video),
                ]
            )
            source = folder / "bundle.zip"
            with zipfile.ZipFile(source, "w", compression=zipfile.ZIP_STORED) as z:
                z.writestr(
                    "manifest.json",
                    json.dumps(
                        dict(
                            version=1,
                            mode="sequential",
                            media=[
                                dict(file="one.mp4", name="interview.mp4", offset=0)
                            ],
                        )
                    ),
                )
                z.write(video, "one.mp4")
            settings = with_defaults("podcast", {})
            p = prepare(source, folder, settings)
            mix, outputs = build_mix(p, folder, settings)
            self.assertAlmostEqual(duration(mix), 1, places=1)
            self.assertTrue((folder / "proxy-0.mp4").exists())
            self.assertTrue((folder / "podcast-preview.mp3").exists())
            self.assertIn(folder / "podcast-peaks.json", outputs)
