import type { ReactNode } from "react";
import type { JobType } from "@/lib/settings";
import type { Choices } from "@/lib/processing-form";

export default function ProcessingControls({
  type,
  values,
  setValues,
}: {
  type: JobType;
  values: Choices;
  setValues: (values: Choices) => void;
}) {
  const set = (key: string, value: string | boolean) =>
    setValues({ ...values, [key]: value });
  const toggle = (key: string, label: string) => (
    <label className="tog">
      <b>{label}</b>
      <input
        type="checkbox"
        checked={values[key] === true}
        onChange={(e) => set(key, e.target.checked)}
      />
    </label>
  );
  const numeric = (
    key: string,
    label: string,
    min: number,
    max: number,
    unit: string,
    step = 0.1,
  ) => (
    <label className="desk-number">
      {label}
      <input
        type="number"
        aria-label={label}
        name={key}
        min={min}
        max={max}
        step={step}
        required
        value={typeof values[key] === "string" ? values[key] : ""}
        placeholder={`${min} to ${max}`}
        onChange={(e) => set(key, e.target.value)}
      />
      <span className="muted">
        {values[key] === undefined || values[key] === ""
          ? "Not selected"
          : `${values[key]} ${unit}`}
      </span>
    </label>
  );
  const segmented = (key: string, label: string, options: string[]) => (
    <fieldset className="desk-segment">
      <legend>{label}</legend>
      <div className="row">
        {options.map((option) => (
          <label key={option}>
            <input
              type="radio"
              name={key}
              value={option}
              required
              checked={values[key] === option}
              onChange={() => set(key, option)}
            />
            {option[0].toUpperCase() + option.slice(1)}
          </label>
        ))}
      </div>
    </fieldset>
  );
  const section = (
    key: string,
    title: string,
    help: string,
    children: ReactNode,
  ) => (
    <section className="card desk-section">
      <h3>{title}</h3>
      <p className="muted">{help}</p>
      {toggle(key, `Apply ${title.toLowerCase()}`)}
      <fieldset disabled={!values[key]} className="desk-fields">
        {children}
      </fieldset>
    </section>
  );
  if (type === "clean")
    return (
      <section className="card desk-section">
        <h3>Clean-up options</h3>
        <p className="muted">
          Choose one or more processes, then set the strength yourself.
        </p>
        {toggle("noise", "Noise removal")}
        {toggle("hum", "De-hum")}
        {toggle("reverb", "De-reverb")}
        {toggle("voice", "Voice enhance")}
        <fieldset
          disabled={
            !["noise", "hum", "reverb", "voice"].some((k) => values[k] === true)
          }
        >
          {numeric("strength", "Strength", 0, 100, "%", 1)}
        </fieldset>
      </section>
    );
  if (type === "subtitles")
    return (
      <section className="card desk-section">
        <h3>Subtitle options</h3>
        <label>
          Language
          <select
            required
            value={String(values.language || "")}
            onChange={(e) => set("language", e.target.value)}
          >
            <option value="" disabled>
              Choose language
            </option>
            {["English", "Hindi", "Telugu", "Tamil"].map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <p className="muted">Choose at least one download format.</p>
        {toggle("srt", "SRT")}
        {toggle("vtt", "VTT")}
      </section>
    );
  return (
    <div className="master-desk">
      <p className="muted">
        Enable the stages you want and enter your settings. Signal order: EQ →
        compressor → loudness → limiter. Every master includes a measured
        report.
      </p>
      <div className="desk-grid">
        {section(
          "loudness",
          "Loudness",
          "Set any target from −70 to −5 LUFS. Presets fill only this field when clicked.",
          <>
            {numeric(
              "lufs",
              "Target integrated loudness (LUFS)",
              -70,
              -5,
              "LUFS",
            )}
            <div className="row desk-presets">
              {[
                ["Streaming", -14],
                ["Podcast", -16],
                ["Broadcast", -23],
                ["Film", -24],
              ].map(([name, target]) => (
                <button
                  key={name}
                  type="button"
                  className="btn ghost sm"
                  onClick={() => set("lufs", String(target))}
                >
                  {name} {target}
                </button>
              ))}
            </div>
          </>,
        )}
        {section(
          "limiter",
          "Limiter",
          "Four-times oversampled peak limiting. Soft knee rounds the transition; hard knee starts at the ceiling.",
          <>
            {numeric("ceiling", "True-peak ceiling (dBTP)", -6, 0, "dBTP")}
            {segmented("limiterKnee", "Limiter knee", ["soft", "hard"])}
            {numeric("limiterRelease", "Limiter release (ms)", 50, 1000, "ms")}
          </>,
        )}
        {section(
          "compressor",
          "Compressor",
          "Control dynamics. Auto makeup compensates half the estimated gain reduction at 0 dBFS; manual uses your gain.",
          <>
            <div className="desk-grid">
              {numeric("threshold", "Threshold (dB)", -60, 0, "dB")}
              {numeric("ratio", "Ratio", 1, 20, ":1")}
              {numeric("attack", "Attack (ms)", 0.01, 2000, "ms", 0.01)}
              {numeric(
                "release",
                "Compressor release (ms)",
                0.01,
                9000,
                "ms",
                0.01,
              )}
            </div>
            {segmented("compressorKnee", "Compressor knee", ["soft", "hard"])}
            {segmented("makeup", "Makeup gain", ["auto", "manual"])}
            {values.makeup === "manual" &&
              numeric("makeupGain", "Manual makeup gain (dB)", -24, 24, "dB")}
          </>,
        )}
        {section(
          "eq",
          "EQ",
          "Enable individual bands and enter −12 to +12 dB. Each band uses Q = 1; disabled bands are bypassed.",
          <div className="eq-bands">
            {["60 Hz", "250 Hz", "1 kHz", "4 kHz", "12 kHz"].map((freq, i) => (
              <div className="eq-band" key={freq}>
                {toggle(`band${i}`, freq)}
                <fieldset disabled={!values[`band${i}`]}>
                  {numeric(`gain${i}`, `${freq} gain (dB)`, -12, 12, "dB")}
                </fieldset>
              </div>
            ))}
          </div>,
        )}
      </div>
    </div>
  );
}
