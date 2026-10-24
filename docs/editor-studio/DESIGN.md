# Editor Studio design

Editor Studio is an original Timeline Tools interface built on Indigo Atelier.
It does not reproduce another DAW's layout, icons, artwork or colour scheme.

A minimal header holds the project name, save state, import/export and project
settings. The central, full-height shared timeline keeps transport, tools and
ruler controls together. An independent right clip bin holds imported sources,
per-file upload state and the Podcast video preview. The page has no studio
sidebar or document scrolling; the timeline and bin scroll independently.

The original SVG paths in components/daw/icons/tool-icon.tsx depict Shape,
Blade, Trim, Fade, Span, Lens and Pan Hand. Shape combines movement, edge trims
and corner fades. Free Place and Ripple Follow describe movement; Loop Window
is the repeating range. Shortcut familiarity presets are text-only options in
Settings and change keys, not the visual design.

Defaults are visible and editable: 48 kHz project rate, 120 BPM, 4/4, zero track
and master gain, centered pan, no inserts, Free Place, WAV 24-bit/48 kHz,
MP3 320 kbps and normalization off. Actions produce inline errors; the record
arm explicitly announces that recording is coming soon. The Mixer hook reports
Coming soon and leaves playback available.
