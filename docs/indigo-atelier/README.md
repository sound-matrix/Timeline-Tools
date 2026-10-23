# Indigo Atelier UI

Implements Anthony's Concept B prompt of 23 October 2026. The named SPEC-INDIGO-ATELIER.md and four reference JPGs were unavailable in the supplied workspace/file search. This implementation follows the supplied tokens and written scope; no pixel match to unavailable comps is claimed.

| Role | Value |
| --- | --- |
| Canvas / sidebar | #0F1220 / #161B2E |
| Panel / panel 2 | #1A2136 / #222A42 |
| Border / strong | #2A3148 / #3D4663 |
| Text / muted / faint | #F4F4F8 / #A8B0C4 / #6B7390 |
| Accent / hover / pressed | #6366F1 / #818CF8 / #4F46E5 |
| Accent wash / on accent | rgba(99,102,241,0.16) / #FFFFFF |
| Scope A / B | #818CF8 / #A78BFA |
| Success / warning / danger | #34D399 / #FBBF24 / #F87171 |

Tokens live in app/globals.css. The repository uses plain CSS, so no unused Tailwind configuration/dependencies were added. Inter, Cormorant Garamond and JetBrains Mono are bundled locally with OFL licenses. Fonts are subset to Latin, punctuation and INR currency; system fallbacks support other scripts.

Screens: dark landing entrance, 240px sidebar, active accent wash, user chip/plan link, all four tool desks, auth/reset and light-touch admin. Mobile uses a hamburger, stacked desks, sticky primary actions and bounded live processing panel; hero actions precede a <=40vh portal.

Motion: Canvas 2D circular spectrum/fibers and low-energy sidebar scope; existing ProcessingStatus keeps live job/upload status and waveform. No fabricated measured audio data. CSS gradient/ring survives canvas failure. Frames stop on hidden tabs, pause, reduced motion and unmount; observers/listeners are cleaned up. Reduced motion keeps static scopes and determinate upload progress. Previous landing GSAP/parallax is no longer mounted; navigation/forms/buttons have no continuous motion.

No worker, schema, billing, pricing/minutes or job/settings/ZIP contract changes. Audio Studio input/option semantics stay intact.

Validation: npm test; npm run typecheck; npm run build; fixture browser suite via playwright.desk.config.ts. Tests exercise real form requests, ZIP contents, blank defaults, status/downloads, reduced motion, canvas failure, mobile navigation and admin surfaces. Browser processing uses the local fixture rather than production DSP/payments.

Screenshots are generated into this directory by tests/browser/atelier.spec.ts.
