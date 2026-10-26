"use client";
import { theme, trackColor } from "@/public/theme.js";

import { useEffect, useRef } from "react";
import type { Arrangement, PluginSlot } from "@/lib/arrangement";
import {
  EFFECTS,
  effectPresets,
  newEffect,
  type EffectType,
  type EffectGraph,
} from "@/lib/daw/effects";
function parameterLabel(type: EffectType, key: string) {
  if (type === "limiter" && key === "threshold") return "Ceiling dBFS";
  if (type === "eq")
    return `Band ${Number(key.slice(1)) + 1} ${key[0] === "f" ? "Hz" : key[0] === "g" ? "dB" : "Q"}`;
  const labels: Record<string, string> = {
    threshold: "Threshold dB",
    ratio: "Ratio",
    attack: "Attack s",
    release: "Release s",
    knee: "Knee dB",
    makeup: "Makeup dB",
    decay: "Decay s",
    mix: "Mix",
    beats: "Beats",
    feedback: "Feedback",
    drive: "Drive",
    frequency: "Frequency Hz",
    reduction: "Reduction dB",
  };
  return labels[key] ?? key;
}
export function Knob({
  label,
  value,
  spec,
  onChange,
}: {
  label: string;
  value: number;
  spec: readonly number[];
  onChange: (n: number) => void;
}) {
  const drag = useRef({ y: 0, value: 0 });
  const change = (v: number) =>
    onChange(
      Math.round(Math.max(spec[1], Math.min(spec[2], v)) / spec[3]) * spec[3],
    );
  return (
    <label className="fx-knob-label" title={label}>
      <span
        className="fx-knob"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={spec[1]}
        aria-valuemax={spec[2]}
        aria-valuenow={value}
        onDoubleClick={() => change(spec[0])}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp" || e.key === "ArrowRight") {
            e.preventDefault();
            change(value + spec[3]);
          }
          if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
            e.preventDefault();
            change(value - spec[3]);
          }
          if (e.key === "Home") change(spec[1]);
          if (e.key === "End") change(spec[2]);
        }}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, value };
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            change(
              drag.current.value +
                (((drag.current.y - e.clientY) * (spec[2] - spec[1])) / 150) *
                  (e.shiftKey ? 0.1 : 1),
            );
        }}
        onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
        style={
          {
            "--angle": `${-135 + ((value - spec[1]) / (spec[2] - spec[1])) * 270}deg`,
          } as React.CSSProperties
        }
      >
        <i />
      </span>
      <span>{label}</span>
      <output>{value.toFixed(spec[3] < 1 ? 2 : 0)}</output>
    </label>
  );
}
function Graph({
  slot,
  getGraph,
  onChange,
}: {
  slot: PluginSlot;
  getGraph: () => EffectGraph | undefined;
  onChange: (p: Record<string, number>) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null),
    meter = useRef<HTMLOutputElement>(null);
  useEffect(() => {
    const ctx = canvas.current!.getContext("2d")!,
      data = new Uint8Array(128);
    let frame = 0;
    const draw = () => {
      const graph = getGraph();
      ctx.clearRect(0, 0, 270, 90);
      ctx.strokeStyle = theme["border-strong"];
      ctx.lineWidth = 1;
      for (let x = 0; x < 270; x += 30) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 90);
        ctx.stroke();
      }
      if (graph) {
        graph.analyser.getByteFrequencyData(data);
        ctx.fillStyle = theme["selection-wash"];
        for (let i = 0; i < 128; i++)
          ctx.fillRect((i * 270) / 128, 90 - data[i] / 3, 2, data[i] / 3);
      }
      if (meter.current)
        meter.current.textContent = `GR ${(graph?.reductions.get(slot.id)?.reduction ?? 0).toFixed(1)} dB`;
      ctx.strokeStyle = slot.enabled ? theme["primary"] : theme["text-muted"];
      ctx.lineWidth = 2;
      ctx.beginPath();
      const p = slot.parameters;
      for (let x = 0; x < 270; x++) {
        const t = x / 269,
          input = t * 2 - 1;
        let y = 45;
        if (slot.type === "eq") {
          const freq = 20 * 1000 ** t;
          let gain = 0;
          for (let b = 0; b < 5; b++)
            gain +=
              p[`g${b}`] *
              Math.exp(-0.5 * (Math.log2(freq / p[`f${b}`]) * p[`q${b}`]) ** 2);
          y = 45 - gain * 1.5;
        } else if (slot.type === "compressor" || slot.type === "limiter") {
          const db = -60 + t * 60,
            th = p.threshold;
          y =
            85 -
            ((Math.min(db, th) +
              Math.max(0, db - th) / (p.ratio ?? 20) +
              (p.makeup ?? 0) +
              60) /
              60) *
              80;
        } else if (slot.type === "saturation")
          y = 45 - (38 * Math.tanh(input * p.drive)) / Math.tanh(p.drive);
        else if (slot.type === "gate")
          y =
            45 - (Math.abs(input) < 10 ** (p.threshold / 20) ? 0 : input * 38);
        else y = 45 - 30 * Math.sin(t * 24) * Math.exp(-t * 3);
        if (!x) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      if (slot.type === "eq")
        for (let b = 0; b < 5; b++) {
          ctx.fillStyle = theme["warning-text"];
          ctx.beginPath();
          ctx.arc(
            (Math.log(p[`f${b}`] / 20) / Math.log(1000)) * 270,
            45 - p[`g${b}`] * 1.5,
            4,
            0,
            Math.PI * 2,
          );
          ctx.fill();
        }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [slot, getGraph]);
  const drag = useRef(-1);
  return (
    <>
      <canvas
        ref={canvas}
        width={270}
        height={90}
        aria-label={`${EFFECTS[slot.type].name} response curve`}
        onPointerDown={(e) => {
          if (slot.type !== "eq") return;
          const box = e.currentTarget.getBoundingClientRect(),
            x = ((e.clientX - box.left) / box.width) * 270;
          drag.current = [0, 1, 2, 3, 4].sort(
            (a, b) =>
              Math.abs(
                (Math.log(slot.parameters[`f${a}`] / 20) / Math.log(1000)) *
                  270 -
                  x,
              ) -
              Math.abs(
                (Math.log(slot.parameters[`f${b}`] / 20) / Math.log(1000)) *
                  270 -
                  x,
              ),
          )[0];
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (
            drag.current < 0 ||
            !e.currentTarget.hasPointerCapture(e.pointerId)
          )
            return;
          const b = e.currentTarget.getBoundingClientRect(),
            t = Math.max(0, Math.min(1, (e.clientX - b.left) / b.width));
          onChange({
            ...slot.parameters,
            [`f${drag.current}`]: 20 * 1000 ** t,
            [`g${drag.current}`]: Math.max(
              -24,
              Math.min(24, (0.5 - (e.clientY - b.top) / b.height) * 60),
            ),
          });
        }}
        onPointerUp={() => {
          drag.current = -1;
        }}
      />
      {(slot.type === "compressor" || slot.type === "limiter") && (
        <output ref={meter} className="fx-gr">
          GR 0.0 dB
        </output>
      )}
    </>
  );
}
export default function EffectsRack({
  a,
  target,
  clip,
  onChange,
  getGraph,
}: {
  a: Arrangement;
  target: string;
  clip?: string;
  onChange: (a: Arrangement) => void;
  getGraph: (id: string) => EffectGraph | undefined;
}) {
  const region = clip ? a.regions.find((r) => r.id === clip) : undefined,
    track = a.lanes.find((l) => l.id === target),
    owner = region ?? (target === "master" ? a.master : track);
  if (!owner) return <p>Select a track, then open FX to add an effect.</p>;
  const slots = owner.inserts ?? [],
    edit = (inserts: PluginSlot[]) =>
      onChange(
        region
          ? {
              ...a,
              regions: a.regions.map((r) =>
                r.id === clip ? { ...r, inserts } : r,
              ),
            }
          : target === "master"
            ? { ...a, master: { ...a.master, inserts } }
            : {
                ...a,
                lanes: a.lanes.map((l) =>
                  l.id === target ? { ...l, inserts } : l,
                ),
              },
      );
  const move = (id: string, to: number) => {
    const next = [...slots],
      i = next.findIndex((s) => s.id === id);
    if (i < 0 || to < 0 || to >= next.length) return;
    next.splice(to, 0, next.splice(i, 1)[0]);
    edit(next);
  };
  return (
    <div className="fx-rack">
      <div className="fx-add">
        <b>{region?.name ?? track?.name ?? "Master"}</b>
        <label>
          Add effect
          <select
            aria-label="Add effect"
            value=""
            disabled={slots.length >= 16}
            onChange={(e) => {
              if (e.target.value)
                edit([...slots, newEffect(e.target.value as EffectType)]);
            }}
          >
            <option value="">Choose device…</option>
            {Object.entries(EFFECTS).map(([type, v]) => (
              <option key={type} value={type}>
                {v.name}
              </option>
            ))}
          </select>
        </label>
        <small>
          Drag knobs · Shift for fine
          <br />
          Double-click to reset
        </small>
      </div>
      {slots.map((slot, i) => (
        <article
          className="fx-card"
          key={slot.id}
          aria-label={`${EFFECTS[slot.type].name} insert ${i + 1}`}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            move(e.dataTransfer.getData("application/x-effect"), i);
          }}
        >
          <header
            draggable
            onDragStart={(e) =>
              e.dataTransfer.setData("application/x-effect", slot.id)
            }
          >
            <b>
              {i + 1}. {EFFECTS[slot.type].name}
            </b>
            <button
              aria-label={`Bypass ${EFFECTS[slot.type].name}`}
              aria-pressed={!slot.enabled}
              onClick={() =>
                edit(
                  slots.map((s) =>
                    s.id === slot.id ? { ...s, enabled: !s.enabled } : s,
                  ),
                )
              }
            >
              {slot.enabled ? "●" : "○"}
            </button>
            <button
              aria-label={`Move ${EFFECTS[slot.type].name} left`}
              disabled={!i}
              onClick={() => move(slot.id, i - 1)}
            >
              ←
            </button>
            <button
              aria-label={`Move ${EFFECTS[slot.type].name} right`}
              disabled={i === slots.length - 1}
              onClick={() => move(slot.id, i + 1)}
            >
              →
            </button>
            <button
              aria-label={`Remove ${EFFECTS[slot.type].name}`}
              onClick={() => edit(slots.filter((s) => s.id !== slot.id))}
            >
              ×
            </button>
          </header>
          <Graph
            slot={slot}
            getGraph={() => getGraph(region ? `region/${region.id}` : target)}
            onChange={(parameters) =>
              edit(
                slots.map((s) => (s.id === slot.id ? { ...s, parameters } : s)),
              )
            }
          />
          <select
            aria-label={`${EFFECTS[slot.type].name} preset`}
            value=""
            onChange={(e) => {
              const p = effectPresets(slot.type)[Number(e.target.value)]
                .parameters;
              edit(
                slots.map((s) =>
                  s.id === slot.id ? { ...s, parameters: p } : s,
                ),
              );
            }}
          >
            <option value="">Preset…</option>
            {effectPresets(slot.type).map((preset, i) => (
              <option key={preset.name} value={i}>
                {preset.name}
              </option>
            ))}
          </select>
          <div className="fx-knobs">
            {Object.entries(EFFECTS[slot.type].params).map(([key, spec]) => (
              <Knob
                key={key}
                label={parameterLabel(slot.type, key)}
                value={slot.parameters[key]}
                spec={spec}
                onChange={(value) =>
                  edit(
                    slots.map((s) =>
                      s.id === slot.id
                        ? {
                            ...s,
                            parameters: { ...s.parameters, [key]: value },
                          }
                        : s,
                    ),
                  )
                }
              />
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}
export function Mixer({
  a,
  onChange,
  getGraph,
  onFX,
}: {
  a: Arrangement;
  onChange: (a: Arrangement) => void;
  getGraph: (id: string) => EffectGraph | undefined;
  onFX: (id: string) => void;
}) {
  return (
    <>
      <div className="fx-mixer">
        {[
          ...a.lanes,
          {
            ...a.master,
            id: "master",
            name: "Master",
            color: theme["primary"],
            pan: 0,
            mute: false,
            solo: false,
          },
        ].map((l) => (
          <div
            key={l.id}
            className="fx-channel"
            style={{ borderTopColor: trackColor(l.color) }}
          >
            <b>{l.name}</b>
            <Meter getGraph={() => getGraph(l.id)} />
            <label>
              Level
              <input
                aria-label={`Mixer level ${l.name}`}
                type="range"
                min={-60}
                max={24}
                step={0.1}
                value={l.gain_db}
                onChange={(e) =>
                  onChange(
                    l.id === "master"
                      ? {
                          ...a,
                          master: { ...a.master, gain_db: +e.target.value },
                        }
                      : {
                          ...a,
                          lanes: a.lanes.map((x) =>
                            x.id === l.id
                              ? { ...x, gain_db: +e.target.value }
                              : x,
                          ),
                        },
                  )
                }
              />
            </label>
            <output>{l.gain_db.toFixed(1)} dB</output>
            {l.id !== "master" && (
              <>
                <Knob
                  label={`Pan ${l.name}`}
                  value={l.pan}
                  spec={[0, -1, 1, 0.01]}
                  onChange={(pan) =>
                    onChange({
                      ...a,
                      lanes: a.lanes.map((x) =>
                        x.id === l.id ? { ...x, pan } : x,
                      ),
                    })
                  }
                />
                <div>
                  {(["mute", "solo"] as const).map((k) => (
                    <button
                      key={k}
                      aria-pressed={l[k]}
                      onClick={() =>
                        onChange({
                          ...a,
                          lanes: a.lanes.map((x) =>
                            x.id === l.id ? { ...x, [k]: !x[k] } : x,
                          ),
                        })
                      }
                    >
                      {k}
                    </button>
                  ))}
                </div>
              </>
            )}
            <button onClick={() => onFX(l.id)}>FX</button>
            {l.id === "master" && (
              <button
                disabled={
                  a.master.inserts.length >= 16 ||
                  a.master.inserts.some((s) => s.type === "limiter")
                }
                onClick={() => {
                  if (!a.master.inserts.some((s) => s.type === "limiter"))
                    onChange({
                      ...a,
                      master: {
                        ...a.master,
                        inserts: [...a.master.inserts, newEffect("limiter")],
                      },
                    });
                }}
              >
                Add limiter
              </button>
            )}
          </div>
        ))}
      </div>
      <section aria-label="Master inserts">
        <h3>Master inserts</h3>
        <EffectsRack
          a={a}
          target="master"
          onChange={onChange}
          getGraph={getGraph}
        />
      </section>
    </>
  );
}
function Meter({ getGraph }: { getGraph: () => EffectGraph | undefined }) {
  const ref = useRef<HTMLMeterElement>(null);
  useEffect(() => {
    let frame = 0;
    const data = new Float32Array(256);
    const draw = () => {
      data.fill(0);
      getGraph()?.analyser.getFloatTimeDomainData(data);
      if (ref.current) ref.current.value = Math.max(...data.map(Math.abs));
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [getGraph]);
  return (
    <meter ref={ref} min={0} max={1} value={0} aria-label="Channel peak" />
  );
}
