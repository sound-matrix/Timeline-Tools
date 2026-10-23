import Link from "next/link";
export default function Home() {
  return (
    <>
      <header className="top">
        <Link className="logo" href="/">
          Timeline Tools
        </Link>
        <nav />
        <Link href="/signin">Sign in</Link>
        <Link className="btn" href="/signup">
          Start free
        </Link>
      </header>
      <section className="hero">
        <h1>Studio-clean audio in one click</h1>
        <p>
          Remove noise, master to LUFS targets and generate subtitles — in your
          browser.
        </p>
        <Link className="btn" href="/signup">
          Upload your first file
        </Link>
        <p className="muted">
          Early access: upload and save your settings now. Processing arrives in
          Phase 1B.
        </p>
      </section>
      <div className="wrap grid">
        {[
          [
            "🎧 Noise removal",
            "Background noise, hum and reverb controls for podcasts and films.",
          ],
          ["🎚 Mastering", "EQ, compressor, limiter and loudness targets."],
          ["💬 Subtitles", "Prepare transcription jobs for SRT and VTT."],
        ].map(([title, text]) => (
          <div className="card" key={title}>
            <h3>{title}</h3>
            <p className="muted">{text}</p>
          </div>
        ))}
      </div>
    </>
  );
}
