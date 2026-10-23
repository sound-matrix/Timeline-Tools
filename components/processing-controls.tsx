"use client";

import { type Choices } from "@/lib/processing-options";
type Props = {
  values: Choices;
  setValue: (key: string, value: string | boolean) => void;
};
const on = (v: Choices, key: string) => v[key] === true;
function Toggle({
  name,
  label,
  values,
  setValue,
}: Props & { name: string; label: string }) {
  return (
    <label className="tog">
      <b>{label}</b>
      <input
        type="checkbox"
        name={name}
        checked={on(values, name)}
        onChange={(e) => setValue(name, e.target.checked)}
      />
    </label>
  );
}
function NumberField({
  name,
  label,
  unit,
  min,
  max,
  step = 0.1,
  values,
  setValue,
}: Props & {
  name: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  step?: number;
}) {
  const value = typeof values[name] === "string" ? values[name] : "";
  return (
    <label className="desk-number">
      {label}
      <input
        name={name}
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        placeholder="Enter value"
        required
        onChange={(e) => setValue(name, e.target.value)}
      />
      <output className="muted">
        {value === "" ? `Choose ${min} to ${max} ${unit}` : `${value} ${unit}`}
      </output>
    </label>
  );
}
function Segment({
  name,
  label,
  options,
  values,
  setValue,
}: Props & { name: string; label: string; options: string[] }) {
  return (
    <fieldset className="desk-segment">
      <legend>{label}</legend>
      <div className="row">
        {options.map((option) => (
          <label key={option}>
            <input
              type="radio"
              name={name}
              value={option}
              checked={values[name] === option}
              required
              onChange={() => setValue(name, option)}
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
export default function ProcessingControls({
  type,
  ...props
}: Props & { type: string }) {
  const { values, setValue } = props;
  if (type === "clean") {
    const active = ["noise", "hum", "reverb", "voice"].some((key) =>
      on(values, key),
    );
    return (
      <section className="card processing-desk">
        <h3>Clean-up options</h3>
        <p className="muted">
          Choose what to process, then set the strength. Nothing is enabled for
          you.
        </p>
        {[
          ["noise", "Noise removal"],
          ["hum", "De-hum"],
          ["reverb", "De-reverb"],
          ["voice", "Voice enhance"],
        ].map(([name, label]) => (
          <Toggle key={name} {...props} name={name} label={label} />
        ))}
        <fieldset disabled={!active}>
          <NumberField
            {...props}
            name="strength"
            label="Strength"
            unit="%"
            min={0}
            max={100}
            step={1}
          />
        </fieldset>
        <p className="muted">
          0% keeps the signal unchanged; 100% applies full strength. De-reverb
          gently gates room tails.
        </p>
      </section>
    );
  }
  if (type === "subtitles")
    return (
      <section className="card processing-desk">
        <h3>Subtitle options</h3>
        <label>
          Language
          <select
            name="language"
            aria-label="Language"
            required
            value={String(values.language ?? "")}
            onChange={(e) => setValue("language", e.target.value)}
          >
            <option value="" disabled>
              Choose language
            </option>
            {["English", "Hindi", "Telugu", "Tamil"].map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
        <div className="row">
          {["srt", "vtt"].map((f) => (
            <Toggle key={f} {...props} name={f} label={f.toUpperCase()} />
          ))}
        </div>
        <p className="muted">
          Choose at least one format. Downloads appear in Recent jobs.
        </p>
      </section>
    );
  return (
    <div className="processing-desk">
      <p className="muted">
        Build your signal chain. Only enabled stages run, in this order: EQ →
        compressor → loudness → limiter.
      </p>
      <div className="desk-grid">
        <section className="card">
          <h3>Loudness</h3>
          <Toggle
            {...props}
            name="loudness"
            label="Apply loudness normalisation"
          />
          <p className="muted">
            Set any target in range, or click a preset to fill it.
          </p>
          <fieldset disabled={!on(values, "loudness")}>
            <NumberField
              {...props}
              name="lufs"
              label="Target integrated loudness"
              unit="LUFS"
              min={-70}
              max={-5}
            />
            <div className="desk-presets">
              {[
                ["Streaming", -14],
                ["Podcast", -16],
                ["Broadcast", -23],
                ["Film", -24],
              ].map(([label, target]) => (
                <button
                  className="btn secondary"
                  type="button"
                  key={label}
                  onClick={() => setValue("lufs", String(target))}
                >
                  {label} {target}
                </button>
              ))}
            </div>
          </fieldset>
        </section>
        <section className="card">
          <h3>True peak / Limiter</h3>
          <Toggle {...props} name="limiter" label="Apply limiter" />
          <p className="muted">
            Choose the peak cap and release. Soft knee eases into limiting
            before the oversampled peak cap.
          </p>
          <fieldset disabled={!on(values, "limiter")}>
            <NumberField
              {...props}
              name="ceiling"
              label="Ceiling"
              unit="dBTP"
              min={-6}
              max={0}
            />
            <Segment
              {...props}
              name="limiterKnee"
              label="Limiter knee"
              options={["soft", "hard"]}
            />
            <NumberField
              {...props}
              name="limiterRelease"
              label="Limiter release"
              unit="ms"
              min={50}
              max={1000}
            />
          </fieldset>
        </section>
        <section className="card">
          <h3>Compressor</h3>
          <Toggle {...props} name="compressor" label="Apply compressor" />
          <p className="muted">
            Set dynamics and makeup gain. Auto compensates half the estimated
            gain reduction at 0 dBFS.
          </p>
          <fieldset disabled={!on(values, "compressor")}>
            <div className="desk-grid">
              <NumberField
                {...props}
                name="threshold"
                label="Threshold"
                unit="dB"
                min={-60}
                max={0}
              />
              <NumberField
                {...props}
                name="ratio"
                label="Ratio"
                unit=":1"
                min={1}
                max={20}
              />
              <NumberField
                {...props}
                name="attack"
                label="Attack"
                unit="ms"
                min={0.01}
                max={2000}
                step={0.01}
              />
              <NumberField
                {...props}
                name="release"
                label="Compressor release"
                unit="ms"
                min={1}
                max={9000}
              />
            </div>
            <Segment
              {...props}
              name="compressorKnee"
              label="Compressor knee"
              options={["soft", "hard"]}
            />
            <Segment
              {...props}
              name="makeup"
              label="Makeup gain"
              options={["auto", "manual"]}
            />
            {values.makeup === "manual" && (
              <NumberField
                {...props}
                name="makeupGain"
                label="Manual makeup gain"
                unit="dB"
                min={-36}
                max={36}
              />
            )}
          </fieldset>
        </section>
        <section className="card">
          <h3>Five-band EQ</h3>
          <Toggle {...props} name="eq" label="Apply EQ" />
          <p className="muted">
            Enable each band you want to use, then set its gain. Fixed Q: 1.
          </p>
          <fieldset disabled={!on(values, "eq")}>
            {["60 Hz", "250 Hz", "1 kHz", "4 kHz", "12 kHz"].map((label, i) => (
              <div className="desk-band" key={label}>
                <Toggle {...props} name={`band${i}`} label={label} />
                <fieldset disabled={!on(values, `band${i}`)}>
                  <NumberField
                    {...props}
                    name={`gain${i}`}
                    label={`${label} gain`}
                    unit="dB"
                    min={-12}
                    max={12}
                  />
                </fieldset>
              </div>
            ))}
          </fieldset>
        </section>
      </div>
      <p className="muted">
        Every master includes measured LUFS and true peak. Peaks, dynamics or
        silence may prevent an exact loudness target.
      </p>
    </div>
  );
}
