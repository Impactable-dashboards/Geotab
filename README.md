# Geotab · Operating Room

ABM intelligence and field-activation surfaces for the Geotab Field Service program, built by Impactable. One scored signal model (Account x Persona x Topic x Time), read at three altitudes: leadership, marketing, and the field.

## Surfaces (Vercel clean URLs)

| Route | File | Layer | Notes |
|-------|------|-------|-------|
| `/` | `index.html` | Entry | Operating Room home |
| `/executive` | `executive.html` | Front door | Board-level Executive Review |
| `/account-signals` | `account-signals.html` | Intelligence | Heat-ranked leaderboard (verified spine) |
| `/program` | `program.html` | Intelligence | Funnel, region, and spend (verified Windsor) |
| `/segments` | `segments.html` | Intelligence | Buying centers and NA demographics |
| `/creative` | `creative.html` | Intelligence | Message and creative (directional) |
| `/orchestration` | `orchestration.html` | Strategy | The Orchestration Model |
| `/field` | `field.html` | Field | My Accounts (per-rep: Zach / Onur) |
| `/top25` | `top25.html` | Field | Top 25 Exec Prep |
| `/report-v2` | `report-v2.html` | Archive | Prior standalone v2 report |

## Access
All surfaces share a client-side gate (SHA-256, sessionStorage key `implab`). Note: the gate is obscurity, not security. The hash ships in the page and the data is confidential, so it should not be treated as real auth.

## Data provenance
- Engagement spine: LinkedIn Company Hub snapshots (Apr to May).
- Spend, region, reach, demographics: Windsor, trailing 90 days (about Mar 20 to Jun 18, 2026), spend >= 1, EMEA kept in EUR, four live accounts. YTD headline $377,570 (Jan to May).
- Blocked: GA4 web-visit volume (no Geotab GA4 property connected to Windsor).

## Deploy
Static project on Vercel (`geotab-abm-reports`), Node 24, clean URLs on. Each `.html` at the repo root serves at its clean route.
