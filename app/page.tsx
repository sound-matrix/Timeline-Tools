import Link from "next/link";
import Visualizer from "@/components/visualizer";
const plans = [
  {
    name: "Free",
    price: 0,
    minutes: 30,
    copy: "Find your sound.",
    features: ["30 processing minutes", "200 MB per file", "Private uploads"],
  },
  {
    name: "Creator",
    price: 499,
    minutes: 300,
    copy: "Make every take count.",
    features: [
      "300 processing minutes",
      "1 GB per file",
      "Clean, master & subtitle",
    ],
  },
  {
    name: "Pro",
    price: 1499,
    minutes: 1200,
    copy: "Keep the stories coming.",
    features: [
      "1,200 processing minutes",
      "4 GB per file",
      "Room for bigger projects",
    ],
  },
  {
    name: "Studio",
    price: 4999,
    minutes: 5000,
    copy: "Space for your next big idea.",
    features: [
      "5,000 processing minutes",
      "10 GB per file",
      "A studio-sized allowance",
    ],
  },
];
function Wave({ noisy = false }: { noisy?: boolean }) {
  return (
    <div className={"wave-bars" + (noisy ? " noisy" : "")} aria-hidden="true">
      {Array.from({ length: 64 }, (_, i) => (
        <i
          key={i}
          style={{
            height: `${12 + Math.abs(Math.sin(i * 0.47) * Math.cos(i * 0.13)) * 78}%`,
          }}
        />
      ))}
    </div>
  );
}
export default function Home() {
  return (
    <div className="landing" id="landing">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="marketing-header">
        <Link className="brand" href="/" aria-label="Timeline Tools home">
          <span className="brand-mark" aria-hidden="true">
            Ⅱ
          </span>{" "}
          Timeline<span>Tools</span>
          <small>BY SOUND MATRIX</small>
        </Link>
        <nav aria-label="Main navigation">
          <a href="#tools">The tools</a>
          <a href="#pricing">Pricing</a>
        </nav>
        <div className="header-actions">
          <Link className="btn ghost" href="/signin">
            Sign in
          </Link>
          <Link className="btn" href="/signup">
            Start free <span aria-hidden="true">↗</span>
          </Link>
        </div>
      </header>
      <main id="main">
        <section className="sound-hero">
          <div className="hero-orbit orbit-one" aria-hidden="true" />
          <div className="hero-orbit orbit-two" aria-hidden="true" />
          <div className="hero-copy">
            <p className="eyebrow">
              <span className="signal-dot" /> YOUR SOUND. A LITTLE MORE
              EXTRAORDINARY.
            </p>
            <h1>
              Less noise.
              <br />
              More <em>feeling.</em>
            </h1>
            <p className="hero-description">
              From the first rough take to the final moment.
              <br />
              Clean, master and subtitle your audio in one creative flow.
            </p>
            <div className="hero-ctas">
              <Link className="btn" href="/signup">
                Start free <span aria-hidden="true">↗</span>
              </Link>
              <a className="text-link" href="#tools">
                Explore the tools <span aria-hidden="true">↓</span>
              </a>
            </div>
            <p className="hero-note">30 free minutes. No credit card needed.</p>
          </div>
          <div className="sound-stage">
            <Visualizer />
          </div>
          <div className="hero-bottom">
            <span>FOR PODCASTERS · FILMMAKERS · STORYTELLERS</span>
            <a href="#tools">
              SCROLL TO TUNE IN <span aria-hidden="true">↓</span>
            </a>
          </div>
        </section>
        <div className="tool-strip" aria-label="Tools">
          <span>ONE WORKSPACE. YOUR ENTIRE SOUND.</span>
          <span>01 / CLEAN-UP</span>
          <span>02 / MASTERING</span>
          <span>03 / SUBTITLES</span>
          <span>04 / AUDIO STUDIO</span>
        </div>
        <section className="story-section cleanup-story" id="tools">
          <div className="story-copy">
            <p className="eyebrow">01 / CLEAR THE WAY</p>
            <h2>
              Keep the voice.
              <br />
              <em>Lose the noise.</em>
            </h2>
            <p>
              The hum of a fan. The room around you. Let the story take the
              foreground with noise reduction, de-hum and dialogue clarity
              controls.
            </p>
            <Link className="text-link" href="/signup">
              Give your audio a fresh start ↗
            </Link>
            <div className="feature-pills">
              <span>Noise reduction</span>
              <span>De-hum</span>
              <span>Voice clarity</span>
            </div>
          </div>
          <div className="cleanup-visual scene-card">
            <div className="scene-top">
              <span>TAKE_001.WAV</span>
              <span>✦ CLEAN-UP</span>
            </div>
            <div className="wave-lane">
              <span>BEFORE / THE DISTRACTIONS</span>
              <Wave noisy />
            </div>
            <div className="clean-divider">
              <span>↓</span>
              <span>MAKE ROOM FOR THE MOMENT</span>
            </div>
            <div className="wave-lane clean-lane">
              <span>AFTER / THE STORY</span>
              <Wave />
              <canvas data-wave="clean" aria-hidden="true" />
            </div>
            <div className="scene-bottom">
              <span className="signal-dot" /> Illustrative waveform · your
              settings, your result
            </div>
          </div>
        </section>
        <section className="story-section mastering-story">
          <div className="mastering-visual scene-card">
            <div className="scene-top">
              <span>THE FINISHING TOUCH</span>
              <span>02 / MASTER</span>
            </div>
            <div className="meter-head">
              <span>LOUDNESS</span>
              <b>
                <span data-lufs>-14.0</span>
                <small> LUFS</small>
              </b>
            </div>
            <div className="meter-track">
              <i data-meter="lufs" />
            </div>
            <div className="meter-scale">
              <span>-36</span>
              <span>-23</span>
              <span>-16</span>
              <span>-14</span>
              <span>0</span>
            </div>
            <div className="meter-head peak-head">
              <span>TRUE PEAK</span>
              <b>
                <span data-peak>-1.0</span>
                <small> dBTP</small>
              </b>
            </div>
            <div className="meter-track peak-track">
              <i data-meter="peak" />
            </div>
            <div className="eq-art" aria-hidden="true">
              {[40, 65, 88, 58, 45].map((h, i) => (
                <div key={i}>
                  <i style={{ height: h }} />
                  <span>{["60", "250", "1k", "4k", "12k"][i]}</span>
                </div>
              ))}
            </div>
            <div className="scene-bottom">
              Illustrative meters · measured report with every master
            </div>
          </div>
          <div className="story-copy">
            <p className="eyebrow">02 / FIND YOUR BALANCE</p>
            <h2>
              Small details.
              <br />
              <em>A bigger sound.</em>
            </h2>
            <p>
              Set your own LUFS target, true-peak ceiling and dynamics, with
              five optional EQ bands. Get a WAV master and a report of its
              measured LUFS and true peak.
            </p>
            <Link className="text-link" href="/signup">
              Make the final mix yours ↗
            </Link>
            <div className="feature-pills">
              <span>User-set LUFS</span>
              <span>True-peak control</span>
              <span>Optional dynamics</span>
            </div>
          </div>
        </section>
        <section className="story-section subtitles-story">
          <div className="story-copy">
            <p className="eyebrow">03 / LET THE STORY TRAVEL</p>
            <h2>
              Every voice.
              <br />
              <em>More ways to connect.</em>
            </h2>
            <p>
              Turn speech into timed SRT and VTT subtitles in English, Hindi,
              Telugu and Tamil. Review your transcript, then take it wherever
              your story goes.
            </p>
            <Link className="text-link" href="/signup">
              Put your story into words ↗
            </Link>
            <p className="future-note">
              Bring your script and audio clips together in Audio Studio.
            </p>
          </div>
          <div className="timeline-visual scene-card">
            <div className="scene-top">
              <span>STORY / SCENE 01</span>
              <span>03 / SUBTITLES</span>
            </div>
            <div className="script-lines">
              <p data-script>“Every story starts with a voice.”</p>
              <p data-script>“Give yours a little more room.”</p>
            </div>
            <div className="timeline-ruler">
              <span>00:00</span>
              <span>00:05</span>
              <span>00:10</span>
            </div>
            <div className="timeline-track">
              <i data-clip>VOICE / TAKE 01 ▂▅▃▇▂▅▃</i>
              <i data-clip>TAKE 02 ▂▅▃▇▂</i>
            </div>
            <div className="timeline-track sub-track">
              <i data-clip>Every story starts…</i>
              <i data-clip>Give yours…</i>
            </div>
            <div className="srt-preview">
              <span>SRT / PREVIEW</span>
              <p data-caption>
                00:00:00,000 → 00:00:05,000
                <br />
                Every story starts with a voice.
              </p>
            </div>
          </div>
        </section>
        <section className="pricing-section" id="pricing">
          <div className="pricing-heading">
            <p className="eyebrow">LESS FRICTION. MORE CREATING.</p>
            <h2>
              A little room to start.
              <br />
              <em>A lot of room to grow.</em>
            </h2>
            <p>
              Simple monthly allowances. All prices in Indian rupees. No GST.
            </p>
          </div>
          <div className="pricing-grid">
            {plans.map((plan) => (
              <article
                key={plan.name}
                className={
                  "plan-card " + (plan.name === "Creator" ? "featured" : "")
                }
              >
                <p className="eyebrow">
                  {plan.name}
                  {plan.name === "Creator" && <span>CREATOR FAVOURITE</span>}
                </p>
                <h3>
                  ₹{plan.price.toLocaleString("en-IN")}
                  <small>/month</small>
                </h3>
                <p>{plan.copy}</p>
                <ul>
                  {plan.features.map((f) => (
                    <li key={f}>✓ {f}</li>
                  ))}
                </ul>
                <Link
                  href="/signup"
                  className={"btn " + (plan.name === "Creator" ? "" : "ghost")}
                >
                  {plan.name === "Free" ? "Start free" : "Choose " + plan.name}{" "}
                  ↗
                </Link>
              </article>
            ))}
          </div>
          <p className="pricing-note">
            One minute charged per started minute of successfully processed
            audio. Payments and paid plan activation will be added separately.
          </p>
        </section>
        <section className="closing-section">
          <p className="eyebrow">LET’S MAKE SOMETHING WORTH HEARING.</p>
          <h2>
            Your next great take
            <br />
            starts <em>here.</em>
          </h2>
          <Link className="btn" href="/signup">
            Start with 30 free minutes ↗
          </Link>
          <div className="closing-wave" aria-hidden="true">
            <Wave />
          </div>
        </section>
      </main>
      <footer className="marketing-footer">
        <Link className="logo" href="/">
          Timeline Tools
        </Link>
        <span>A Sound Matrix creation.</span>
        <Link href="/signin">Back to your studio ↗</Link>
      </footer>
    </div>
  );
}
