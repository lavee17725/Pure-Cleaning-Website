# Quoting Engine — Pricing Intelligence & Measurement (Living Doc)

> The copilot that turns **address → measured surfaces → suggested itemized quote.**
> This is a LIVING document. The rate card (§3), strategy (§4), and ground-truth log (§5) grow
> every session as real jobs come in. Started 2026-06-17 from Tyler's vision conversations —
> deliberately captured so it does **not** live and die in a chat.

## 0. How to use this doc
- Every real job that gives a **surface measurement + price** → add a row to §5 and update §3.
- Every time Tyler **overrides a suggested quote** → that's a training signal; capture the lesson.
- Cowork updates this each session; Claude Code reads it for the build. Keep it committed.

---

## 1. The model — copilot, not auto-quote (yet)
- **Near-term (the actual product):** the system measures the surfaces, applies Tyler's
  per-surface rates, and hands **Tyler** a suggested, itemized quote. He verifies/adjusts line by
  line and sends it to the customer. **The owner is always the gate.** Zero risk of a bad number
  reaching a customer.
- **North Star (later, earned):** auto-send — only after the system has been right a few hundred
  times. Not a watered-down goal; the smart way to ship it.
- **Itemized, line by line** — driveway $X, house wash $Y, patio $Z — shown to Tyler to verify,
  and itemized to the customer so the quote reads justified, not a mystery lump sum.
- **Request-driven:** only price the surfaces the customer asked to be cleaned.
- **Add-on radar:** from the same satellite tile, flag cleanable surfaces they did NOT ask for
  (patio, perimeter walls) as upsell suggestions for Tyler to approve. Revenue found automatically
  on every property.
- **The flywheel:** every line Tyler verifies or overrides is a training example. Corrections →
  rates + boundary-detection get smarter. A few hundred jobs in, the numbers barely change.

## 2. The measurement engine
Pipeline: **address → geocode (rooftop) → satellite tile (zoom 19) → trace cleanable surface → sq ft × rate.**
- **Scale (calibrated + verified):** zoom 19, scale=2 Google Static Maps ≈ **0.44 ft/px** at SW
  Broward latitude. Validated on Tom Shelton (manual trace ≈ his taped 3,846 sq ft).
- **Geocoding:** ~89% of properties are Google **ROOFTOP**. The 2026-06-17 re-geocode sweep
  upgraded 85 Nominatim/census pins → ROOFTOP (address normalized "Southwest"→"SW"); manual_override
  (Tom) preserved; upgrade-only contract. **Phase 2:** BCPA parcel-centroid fallback for the ~48
  set-back lots Google returns as interpolated/center/approximate (+2 deferred).
- **Boundary drawing:** TODAY a human traces the surface boundary — the part the AI can't see
  (material transitions). LATER the model learns to draw it from the accumulated human-drawn
  examples.
- **Confidence gate:** clean, open, single-material surfaces auto-suggest; long / canopy-covered /
  material-ambiguous ones flag for a human glance. (Tyler's own drive = textbook flag.)

### Known failure modes (from real tests)
- **Tree canopy** hides surfaces → under-measure (Tom + Tyler both).
- **Same-color material transition** (concrete ↔ white rock): no visible edge → trace runs too far
  → **over-count.** Tyler's drive: satellite read ~2,900, true cleanable concrete is 975 — the rock
  approach got counted as driveway. Lesson: only count the cleanable surface; flag suspected
  material change.
- **Roof type from overhead is unreliable** (shingle vs tile look alike top-down). Roof type is a
  **captured field** (crew sets it), not inferred — it drives method + price. *Future:* with enough
  labeled image→type pairs, a classifier can learn to suggest it.

## 3. Rate card — $/sq ft by surface (the copilot's pricing brain)
Rates are **per surface, scaled by cleaning difficulty.** Concrete is the floor (easiest to clean).
Fill rows from real jobs.

| Surface | $/sq ft | Status / source |
|---|---|---|
| **Concrete driveway** | **~$0.10–0.13** | 🔒 Tyler's house: 975 sq ft → $125 (incl. tree-hidden entranceway) |
| Roof — soft wash / pressure | TBD | sq ft solved via BCPA; needs rate |
| Patio / pool deck | TBD | |
| Walls / fence / screen enclosure | TBD | |
| Paver clean + seal | TBD | multi-day process; higher rate |
| House wash (stucco / siding) | TBD | |
| **$150 job minimum** | — | DL-05 floor; flag any job under it |

## 4. Pricing strategy — the margin engine (future build)
- **Target gross margin:** ~40–45% (to confirm). Goal: **$1M annual gross.**
- **Elasticity testing:** push rates up in steps (concrete $0.13 → $0.15 → $0.17 → $0.20) and watch
  acceptance — learn how elastic each surface's price is, raise where the market doesn't flinch.
- **Win/loss tracking:** log quote → accepted/declined per surface + segment, so the system learns
  the acceptable ceiling.
- **Undercut detection:** Tyler suspects he prices low (concrete at $0.13 may be under market). The
  system should flag likely-undercut quotes and suggest increases within customer tolerance.
- **The recommendation form:** "to hit 45% margin this driveway should be $X (you'd normally do $Y);
  market tolerance says it lands." Tyler decides.

## 5. Ground-truth log (calibration dataset — grows every job)
| Property | Surface | Field measure | Price | Notes |
|---|---|---|---|---|
| Tom Shelton — 11918 (Davie) | Driveway / entranceway | **3,846 sq ft** | — | satellite trace ≈ matched; **0.44 ft/px calibration anchor** |
| Lourdes Fortune — 1629 Orchid Bend, Weston | Driveway 684 + sidewalk 315 | **999 sq ft** concrete | roof+driveway **$350** (bundled — no per-sqft) | roof via BCPA `Property.sqft` 2661 |
| Tyler — 16621 SW 62nd St, SW Ranches | Concrete driveway 65×15 (+ tree-hidden entranceway) | **975 sq ft** | **$125** (≈$0.10–0.13/sqft) | roof = **shingle**; satellite over-read ~3× (rock blend) → low-confidence case |
| Zinz — paver re-seal | Regular pavers (octagon-dot), 35×16 (+ small walkway) | **560 sq ft** | ~**$104 material** (Cobble Coat ~2 gal + brush; bill rounded-up) | **first seal-consumables seed**: ~280 sq ft/gal coverage; **RE-SEAL ~2 yr**; no sand; photo-documented (detail → §13) |

## 6. Open threads / next
- Fill the rate card: patio, walls, roof, paver, house-wash rates from real jobs.
- Phase-2 geocode: BCPA parcel-centroid snap for the ~50 set-back lots.
- Boundary-draw UI: tablet trace → sq ft → suggested quote (the copilot's front end).
- Add-on radar: flag unrequested cleanable surfaces from the tile.
- Margin / elasticity model + win-loss logging.
- Roof-type classifier (once enough labeled examples accumulate).

## 7. How it lives in the CRM (build architecture)
The engine becomes a **Quote Engine room** in the CRM. It has TWO layers of intelligence — keep them
separate:

**Layer A — deterministic math (NO LLM; build this first).**
- Rate card (a D1 table) × measured sq ft per surface = base line items.
- Pull the customer's history from D1 (past jobs, prices, loyalty) and carry it forward.
- Margin math: cost model → price to hit the target gross margin.
- Output: a sloppy-but-real itemized suggested quote. Exact, auditable, free. **Never let an LLM do
  the arithmetic on a customer's bill** — this layer owns the numbers.

**Layer B — reasoning (the Claude API; the "intellect").**
- The Worker gathers context (history + measured surfaces + rate card + margin params) and sends a
  structured prompt to the **Claude API** — a server-side `fetch` to api.anthropic.com with the key
  stored as a **Worker secret** (the same pattern already used for Google Geocoding / Static Maps /
  Pushover).
- Claude returns: the suggested quote + the **reasoning** ("concrete driveway 975 sq ft × $0.13 =
  $127; repeat customer, held the rate; shingle roof → soft wash"), add-on suggestions, and answers
  when Tyler asks "why this price? why should it be higher?"
- Cost: pennies per quote; trivial at this volume.

**The growth loop:** job in → pull history (D1) → apply rate card (Layer A) → Claude reasons +
explains + flags add-ons (Layer B) → Tyler edits/approves line by line → the edit is logged as a
training signal that nudges the rate card and adds to the ground-truth log (§5). Starts sloppy,
crisps up every day.

**Phasing:**
1. Quote Engine room with Layer A only — deterministic suggested quotes (rate card + history + margin).
2. Bolt on the Claude API (Layer B) for reasoning, messy-request parsing, add-on phrasing, and the
   correction conversation.
3. As corrections accumulate, rates dial in and edits shrink — the runway to auto-send.

## 8. Research — how the market does it + what's buildable (2026-06-17 deep research)

### 8.1 Market landscape — this already exists
- **Pressure-washing-specific (closest competitors):** **QuoteIQ** (MapMeasure Pro measures driveways/roofs/decks from satellite + an AI Estimator that line-items from surface type, sq ft, method, story height, condition, and can analyze an uploaded photo; $30–700/mo), **SatQuote** (map-based satellite measurement for PW), WorkQuote, FieldPulse, ResponsiBid. → Tyler's concept is **proven and already productized.** Not a first-mover. The edge is being wired into *his own CRM + his ground-truth pricing*, not the measurement tech itself. (myquoteiq.com, satquote.com, fieldpulse.com)
- **Roofing:** EagleView / Hover / GAF QuickMeasure / Nearmap = measurement-as-a-service ($12–24/report), **no auto-quote.** **Roofr's Instant Estimator** is the one true address→satellite→measure→priced-quote loop — but a deliberate **ballpark** ("accurate enough to have a real pricing conversation," finalized after inspection). (roofr.com/blog/roofr-instant-estimator-guide, 1esx.com)
- **Solar (most mature auto-pipeline):** Google Solar API / Project Sunroof + Aurora Solar = fully automated address → 3D roof model → instant estimate in <1 min. But they need a **DSM/LIDAR** for pitch + shading (3D solar yield). Pressure washing prices off **2D area**, so it can skip the hardest/most expensive parts. (developers.google.com/maps/documentation/solar/methodology, arxiv.org/abs/2408.14400, aurorasolar.com/aurora-ai)
- **Universal pattern (validates the copilot model):** keep **measurement and pricing as two separate stages**, and present an **editable, confirmable estimate — never a silent auto-commit.** Even the most automated player frames it as a ballpark. That is exactly §1's copilot.

### 8.2 Technical — what's feasible
- **Measurement:** Web Mercator m/px with a **cos(latitude)** factor — Tyler's **0.44 ft/px @ zoom 19** is the textbook calibration. **Flat surfaces (driveways, decks, sidewalks) are the sweet spot: ±3–7% of a tape, often better** (high-contrast edges, no pitch). Roofs need a pitch multiplier (`true area = footprint / cos(pitch)`, e.g. ×1.118 for 6/12) — **but roof sq ft already comes from BCPA, so the pitch problem is sidestepped.** Free data: Microsoft US Building Footprints (129M, free; vintage ~2012–2020 caveat); BCPA parcel (note: its sq ft = *living area*, not roof footprint). Lawn-care analogs (Deep Lawn, RealGreen) measure driveways from satellite and use **leaves-off winter imagery to see through canopy** — a usable trick for FL tree cover. (en.wikipedia.org/wiki/Web_Mercator_projection, github.com/microsoft/USBuildingFootprints, deeplawn.com)
- **Material classification:** an established research problem (RoofNet 51k tiles/14 classes; Open AI Caribbean Challenge ~84% with a pretrained CNN; Nacala "segment-then-classify"). Recipe: **fine-tune a pretrained model, never train from scratch.** **SAM / `segment-geospatial`** draws surface boundaries with near-zero training **but does NOT assign material** — pair it with a classifier. **Hardest case: tile vs asphalt shingle from straight-down imagery** (spectral similarity) — needs oblique imagery or pitch cues; tree occlusion + coarse resolution degrade it further. (arxiv.org/html/2505.19358v1, arxiv.org/pdf/2004.11482, samgeo.gishub.org)
- **Active learning validates the "narrow it down" instinct:** "candidates narrow 7→4→2→1" **is uncertainty / margin sampling** — a real, standard technique, not a fantasy. Human-in-the-loop bootstrap is how **DoorDash and Facebook (SEALS)** cold-started real labeling systems. Few-shot reality: expect **dozens (~20–100+) of labels per category** for useful accuracy; active learning makes those labels count by only asking about ambiguous cases. (eugeneyan.com/writing/bootstrapping-data-labels, encord.com/blog/active-learning-machine-learning-guide)

### 8.3 The key build insight — Claude is the classifier on day one
The fastest, cheapest path: **don't build or train a computer-vision model first.** Claude (vision-language) **is** the early classifier + reasoner — show it the satellite tile + a candidate material list, it picks and explains, Tyler corrects. **Every correction is persisted (Rule 22) → that is the active-learning dataset.** Feed the verified examples back as few-shot prompts. A custom fine-tuned CV model is a *later optimization* once hundreds of labels accrue — not a prerequisite. Pricing: nearest-neighbor **comparables** from the CSV ("3,000 sq ft shingle soft-wash → past jobs ≈ $400") + regression, shown alongside Claude's reasoned estimate. His own data beats generic $/sqft tables. (Industry $/sqft: residential $0.10–0.50; roof soft-wash $0.30–0.60 — Tyler's concrete $0.13 sits low, consistent with "concrete is easiest.")

### 8.4 Phased build plan
1. **Flat-surface measurement first** (driveways/decks — the accurate sweet spot): human traces the polygon (SAM can assist) on the calibrated tile → sq ft. **✅ SHIPPED 2026-06-17** — `Surface` + `RateCard` D1 tables (migration 0026), `pure_cleaning_measure_v2.html`, 📐 Measure button in the customer profile, scale verified 0.44 ft/px, round-trip tested. Commit 5ec6dad. (RateCard is now the live, editable mirror of §3.)
2. **Claude as material classifier + quote reasoner:** tile + candidates → pick + explain → Tyler confirms → persist every correction.
3. **Price from the CSV comparables + rate card** → suggested itemized quote → Tyler approves/sends (the copilot).
4. **Accumulate labels through normal job flow** — every confirmed roof/driveway becomes a training label.
5. **Later:** fine-tuned CV model for auto-boundary + auto-material; oblique imagery to crack tile-vs-shingle; auto-send earned once trust is proven.

### 8.5 Honest cautions
- **Tile vs shingle from top-down is the last/hardest class** — plan on needing oblique imagery; until then keep capturing roof type by hand (already the rule).
- **Tree canopy is the recurring enemy** in South Florida; leaves-off/seasonal imagery + the confidence flag are the mitigations.
- **Don't promise day-one accuracy** — it climbs over weeks of corrections; that's the design, not a flaw.
- **You're not first** (QuoteIQ, SatQuote). The moat is your own pricing data + CRM integration, not the measurement.

## 9. The grand-vision flow (end-to-end) + the scheduling layer

**The full target-state loop:**
1. Customer submits an **online quote request** → address + desired services.
2. System pulls the **satellite tile** (already done) → identifies **materials** (driveway, patio, roof) + measures **sq ft** of each.
3. Reconciles its own estimate against **historical cold facts**: if a returning customer, pull prior charges + metrics; cross-check the AI's sqft guess against known/BCPA data. **AI estimates first, then verifies against the evidence** → gets smarter as Tyler corrects.
4. Produces a **suggested itemized quote + a confidence % (variance)**.
5. **Margin-aware scheduling:** recommends WHERE to slot the job to hit gross-margin / daily-revenue targets, using the job's estimated **labor hours**, without exceeding the crew's daily labor cap.

**The scheduling / capacity module (a second engine ON TOP of the quote):**
- Needs three inputs:
  - **(a) Estimated job duration** — already captured via **Bouncie GPS** (`Job.actualDuration` /
    `actualArrival` / `actualDeparture` + the `TruckEvent` table). So the system can learn
    "3,000 sq ft barrel tile + concrete driveway ≈ X hrs" from real tracked job times. **This data is
    already accruing automatically.**
  - **(b) Margin / throughput target** — to hit ~45% margin toward $1M gross, derive a required
    **$/day**; the scheduler packs days to that number.
  - **(c) Labor-hour cap per crew per day** — Tyler sets it, then tunes by watching whether the guys
    are over/under-worked, converging on a consistent, humane sweet spot.
- Output: "schedule this Tuesday with these jobs — it fits the labor cap and hits the day's revenue
  target." Downstream of the quote: quote → price + estimated hours → scheduler.

**How this actually "grows" (NOT via a chat session):**
- The persistent brain = **(1) the data** (D1 jobs/customers/durations + CSV history + every labeled
  correction), **(2) this doc**, **(3) the CRM's Claude-API integration** that runs the loop at
  runtime. A Cowork chat is stateless — it reads these fresh each time; it does not learn by being
  talked to.
- **Start-now actions that compound:** log every job's surfaces + materials + sq ft + price +
  **duration**; keep the rate card (§3) + ground-truth log (§5) current; build the §8.4 phases.
  Quoting work stays in *this* project (CRM + D1 + durations + this doc all in one place).

## 10. Autonomy model — "can it run without me?" (refinement)
- **Flip the loop: AI-first, human-adjudicates.** Don't make Tyler the tracer. The system
  auto-processes every property — **SAM** auto-traces the surface, **Claude** zero-shot classifies
  the material, **historical comps** price it — each with a **confidence score**. Tyler reviews only
  the LOW-confidence flags (~10–20%), not all of them. Phase 1's manual tool stays as the
  *adjudication surface*: AI pre-fills the trace/material/price; Tyler confirms or corrects.
- **Run it without him: a scheduled agent.** A recurring task (same mechanism as the GBP check)
  processes the backlog + any new properties, logs draft surfaces/materials/quotes + confidence, and
  pings Tyler only for the flags. Runs on a schedule, not on his time.
- **Irreducible human minimum (honest floor):** a few dozen verified ground-truths (wheel + pricing
  calls) are required to calibrate confidence and to learn *his* margins, not generic ones. Not zero,
  not 100/night forever — minimal, high-leverage, then occasional flag-clearing. **A confident wrong
  number is worse than no number.**
- **Buy-vs-build reality:** the measurement/tracing is a commodity (QuoteIQ, SatQuote already do it).
  The moat is the **pricing model built from Pure Cleaning's own ~1,800-job history** — buildable now
  and the actual money-maker. **Returning customers skip measurement entirely** (pull the prior price);
  measurement only matters for *new* properties.

## 11. Pricing model refinements (2026-06-17, Tyler)
- **Measure EVERY property — returning customers included.** (Corrects §9/§10's "returning customers
  skip measurement.") The sq ft is universally valuable: it's what lets you re-price an old customer to
  margin. Tyler is actively raising prices, so even loyal customers may get modest increases — you need
  their measurement to compute the margin-correct number. History is a *second* input, not a substitute
  for measuring.
- **Two pricing reference points, reconciled per customer:**
  - **Current rate card = forward truth** (margin-driven; reflects what Tyler charges NOW / is moving
    toward). The target.
  - **Customer history = loyalty / grandfather anchor** (what this customer has paid). Sets how
    aggressively to raise: modest bump for loyal/grandfathered, full current rate for new.
  - New customer → measured sq ft × current rate. Returning → suggest history + a modest step toward
    the current rate ("paid $350; current rate ≈ $420; loyal → suggest ~$385"). Tyler decides the bump.
- **Price-regime shift (important):** historical CSV prices reflect the OLD (undercut) pricing Tyler is
  climbing out of. **Do NOT train the rate on the historical average** — it would bake in the undercut
  permanently. **Anchor the rate LEVEL to current/recent pricing as the truth;** use older jobs only for
  *structure* (sq-ft↔price relationships, surface mix, per-customer loyalty pattern), recency-weighted.
  History = the shape; current pricing = the level. The engine should pull prices UP toward margin, not
  back to last year's.
- **Trust/calibration phase:** early on Tyler checks *every* draft — that's how the system earns trust.
  Confidence scores indicate which to scrutinize hardest, not what to skip. Checking narrows naturally
  as accuracy proves out.

## 12. Crew-time & gross-per-crew-hour (the optimization spine)
Time is the **bridge between pricing and capacity.** sq ft × material → predicted **labor hours**
(learned from Bouncie `actualDuration` + crew size); hours are **finite per day.**
- **Optimize for gross-per-crew-hour, NOT gross-per-job.** A $500 job that eats a full day is worse
  than two $300 half-day jobs. Yardstick: **~$100/hr gross solo** (<$70–100 underpriced, ~$100 good,
  $100+ well-priced). Protect this number — pure win-rate optimization just learns to drop prices.
- Inputs already captured: Bouncie duration + **crew size** per job. Crew is all experienced →
  tenure-noise not a concern now; keep logging crew size (2-man vs 3-man on the same sq ft = different
  hours/man).
- **Labor is non-linear** (Field Ops master): 2 guys ≠ half the time — the 2nd works the small machine
  (slower, less reach); solo always runs the main machine. Never assume hours × crew.

## 13. Sealing — the priority measurement use-case
**Build the measurement engine for sealing FIRST.** It unlocks a capability Tyler doesn't have today:
**remote seal quoting.** He can already eyeball-quote washing, but he does **not** trust his judgment
on floor sq ft → seal jobs currently require an **in-person visit.** Satellite measurement removes that
bottleneck — categorical change, not incremental. Plus sealing is the **highest-margin service** and the
**biggest untapped lever (~2.5% attach rate).**

Sealing has significant, **variable material cost** (washing is mostly labor + chlorine + gas + equipment
depreciation — low and uniform; sealing swings a lot with sq ft + surface). **Capture on every seal job**
(low volume = every point precious):
`surface type · sq ft · sealer type + gallons used · polymeric sand bags · brush/other · labor time + crew size · seal history`
→ learn **coverage rate per surface (sq ft/gallon)** + time per sq ft. Coverage varies by **porosity**
(rough pavers drink more than smooth travertine/marble) → need several jobs per surface type first.

**13.1 Seal history = two-tier input.** Re-sealing a recently-sealed surface uses **less** sealer;
first-time / long-overdue uses **more.**
- **Existing customer → KNOWN** from `jobHistory[]` (last-seal date, accurate — unlike dirtiness, this
  IS in our records; a real advantage).
- **New customer → UNKNOWABLE** (their number is probably wrong) → default **conservative**
  (more-porous, higher-consumption) so we never under-buy.

**13.2 Material billing — round up to purchase increments (INTENTIONAL MARGIN — do NOT optimize away).**
Tyler buys sealer in **5-gallon increments, always rounds the purchase UP** (est 7.5 → buy 10; est 11 →
buy 15) and **charges the customer for the rounded-up amount, not exact gallons used.** Leftover carries
to the next job — which is **also** charged a full increment. Net = leftover is margin. **The engine MUST
bill material in whole 5-gal increments rounded up — NEVER exact-gallons-consumed.** A naive
"gallons × cost" model quotes UNDER Tyler's real price and silently erases this. Intentional + fair (he
carries the over-buy cost/risk as overage protection).

**13.3 Seed seal data point** (the seal template — like Tom's 0.44 ft/px anchor): regular pavers
(octagon-dot, photo-documented) · **35×16 = 560 sq ft** (+ small walkway) · Cobble Coat 5-gal ~$211
(~$42/gal), **~2 gal used** · no sand · brush ~$20 · material ≈ **$104 (~$0.19/sq ft)** but billed
rounded-up · implied coverage **≈ 280 sq ft/gal** · **RE-SEAL ~2 yr.** (Logged in §5.)

## 14. Capture-from-day-one (irreplaceable if missed)
Add to every quote/job record **now**, even before the engine exists — can't be reconstructed later:
1. **Lead source** — DONE ✓ (channel: GBP, organic, city page, partner, reactivation).
2. **Quote timestamp + response time** — speed-to-quote predicts close rate.
3. **Win/loss outcome** — accept/reject (reason OPTIONAL, usually blank — people ghost; default
   "price/competitor" when unstated; don't build a workflow around data you can't get).
4. **Quoted vs final invoiced price** — log silently; the delta = estimating error.
5. **Repeat cadence per customer per service** — real rebook interval; sharpens reactivation timing.
6. **Season/month tag** — future seasonal elasticity.
7. **Photos linked to the job record** — condition data + marketing content + dispute proof
   (parcel-geo prototype exists; attach going forward).

**Start-now, most irreplaceable:** #1 (done) + #2 response time.

## 15. Guardrails surfaced this session
- **Attach-rate upsell engine = HIGH PRIORITY, not polish.** On every quote, surface add-on prices
  ("add sealing +$X") for one-tap add. Sealing attach ~2.5% is the biggest untapped lever → auto-surfacing
  it on every quote is one of the highest-ROI features. Lives in the revenue engine (§1 add-on radar, elevated).
- **Material-learning layer never blocks the quote.** Candidate-narrowing (6–7 guesses → fewer as it
  learns) rides alongside; **honest confidence** (early on it's guessing — say so, Tyler is truth every
  time); the labeled dataset is a **first-class asset** (clean storage, snapshot) — future accuracy + a
  possible standalone product. Must be rippable-out without breaking quoting.
- **BCPA: use the footprint field, not living area.** 2-story living area ≈ 2× footprint; calibrating
  against the wrong field bakes in a consistent error. (The one trap in the BCPA fast-training plan, §2/§8.2.)
- **90–95%, never 100%.** Target a confident estimate that's right most of the time and that Tyler can
  **override** — not a perfect oracle. The variance buffer absorbs irreducible variance (porosity, last-seal
  wear, weather). 90–95% with override is a winning target, not a compromise.

## 16. Cost & Profitability Hub — the COGS head (build symbiotically with the quoting head)
The COGS/cost tracking and the satellite-quoting engine are **two heads of one system, built together,
feeding each other**: real COGS → accurate per-job profit + the **margin target** the quote engine prices
toward; the quote engine's predicted time/material → checked against **actual Bouncie time + logged costs**.
Build both at once; neither in isolation. (Design origin: Tyler's May 25 "Unified Operations Cost +
Profitability Hub" Google Doc — `14JvHVdAstWEckBPVZKHqw86htlXkUKIr`.)

- **Where it lives:** a dedicated **Operations / Costs tab** — NOT the calendar. Entry + dashboards in the
  hub; the calendar only shows a read-only **per-job profit chip** on each card (+ customer profile).
- **Engine:** one `CostEntry` log (date · type · rigId · optional jobId · amount · quantity · notes) →
  allocation engine splits each cost across jobs by Bouncie miles + on-site hours → per-job profit +
  weekly/monthly P&L (per-rig / per-service / per-market).
- **Labor = flat DAY RATE, read from the calendar (NOT hourly):** $150 gross/day per guy; **Jonathan $160**;
  **half-day = half** (~$75, rare). Already set on the calendar (crew assignment per rig/day + half-day
  toggle + Jonathan's rate) — the engine **reads it**, no new entry. Per-job labor = the rig's crew
  day-rates that day, allocated across that rig's jobs. (Corrects the earlier "hourly rate" assumption.)
- **Gas = receipts only:** prices too volatile to track $/gal. Log the **receipt $** per rig per fill
  (optional photo); allocate by that rig's Bouncie miles + hours. ~98% of receipts kept → optional light
  backfill, but **start forward now** (slow-season pipes).
- **Chlorine = manual split now → learned later:** not bought daily; log gallons per rig per fill. Tyler
  **manually allocates** across the day's jobs (e.g. 30 gal across a $400 roof + $150 driveway ≈ 20–23 /
  8–10). System **learns gallons-per-service** from his corrections → predicts → he corrects (same
  predict→correct loop as pricing). Chlorine **$2/gal** (editable — stable, but can change).
- **Seal-job materials (service-triggered):** when a job's services include sealing, completion prompts for
  **sealer gallons + sand bags + their prices** (prefilled last-known, editable). Same capture as §13's
  seal-consumables — one entry feeds both COGS *and* the sealing rate-learning (the two heads).
- **Equipment registry = serial + HOURS (Tyler's seasonal insight):** key each item by **serial last-4** (or
  a label) · type · rig/truck · **installAt** · **brokenAt**. **Lifespan in operating HOURS, not calendar** —
  a hose "2 months" in Nov = same hours as 4 months in summer; hours from that truck's **Bouncie active
  time** over install→break. Outlier flags on **both** axes (hours + calendar) to catch a bad rig/practice.
  Seed list: **large machine** (~$5k, bought ~June 2026, ~2-yr life — first entry, backfill hours from start
  date) · small machines · guns · hoses (start fresh) · hover-cover **wear parts** (bearings, hoses — body
  "lasts forever") · ball valve · chlorine injector.
- **Per-job profit (output both heads need):** Revenue − labor (day-rate share) − gas − chlorine − equipment
  wear ($/hr × job hrs) − fixed (insurance/rent, % of revenue) = net profit + margin → calendar chip +
  profile + hub.
- **Build order (cost head):** P1 schema + fast daily per-rig entry (gas $, chlorine gal, equipment change) +
  equipment registry — capture only, start now. P2 allocation engine → per-job profit + per-rig P&L. P3
  weekly/monthly P&L dashboard. (Measurement / tiered pricing stay on the quoting head.)
- **Phase 2 locked inputs (2026-06-19):** large machine estimatedLifetimeHours **≈3000 hrs** → **$1.67/hr**
  wear (editable; true-up on break) · fixed costs allocated **flat per-job** = month's fixed ÷ that month's
  job count ("evens out by volume"), finalizes at month close (mid-month uses running/prior-month count) ·
  labor pay-rates **already on the calendar** (Jonathan $160 / $80-half, others $150 / $75-half) — engine
  reads them, no new pay-rate table.
- **Labor allocation refinement (2026-06-19, Tyler's capacity insight):** do NOT split the day's fixed $150
  across that day's jobs by hours — that makes a job look unprofitable just because a slow (summer) day had
  few jobs to share the cost, conflating job quality with day-fullness. Instead value labor at a **STANDARD
  per-crew-hour rate** = day-rate ÷ a standard full-day on-site hours (≈6–8h, TBD/editable). Per-job labor =
  job onSiteHrs × crew × standardRate — stable, reflects the JOB not the schedule. The leftover on a thin day
  [(actual day labor paid) − (Σ standard labor charged to that day's jobs)] = **idle / unfilled-capacity
  cost**, tracked at the DAY level (never smeared onto a job). That gap IS the summer-slowness / utilization
  signal and feeds the scheduling optimizer — surfaces the volume problem instead of poisoning a job's margin.
  **Open input:** standard full-day on-site hours. (Revises the Phase-2 labor bucket Code already shipped.)
- **Seasonality (2026-06-19, Tyler) — the model must READ differently by season, not just compute:** the
  standard day FLEXES HARD — ~3.5 on-site hrs in **summer** (100°F roofs + chlorine heat = brutal; do NOT push the
  guys; crew retention is non-negotiable — "without them we can't operate"), up to ~5 in **winter** (70–80°F,
  easier, can push a little). Keep standard-hours an **editable config**; **season-tag all cost/profit data**
  so summer and winter are never compared on one yardstick — they're two different businesses under one name.
  **Idle-capacity reads differently by season:** summer slack is PARTLY intentional (low volume + protecting
  the crew), NOT purely a failure to fill; winter slack is a real missed-revenue opportunity. **Winter
  concentrates the profit** (Dec ~$40–50k/mo vs summer ~$18–25k/mo) via volume × higher prices × easier
  conditions compounding; summer = slow + harsh + must price LOWER to win jobs. **Humane ceiling (hard
  guardrail):** any gross-per-crew-hour / scheduling optimization is bounded by crew wellbeing — never push
  the guys in summer heat. Strategic payoff once cost engine + season data run: quantify how low summer prices
  can go and still clear the floor (fill capacity + keep guys working + cash moving), and how hard to push
  winter price in the window where the margin actually lives.
- **Seasonal strategy — the two seasons are OPPOSITE problems (2026-06-19):** **SUMMER = demand-constrained**
  (not enough work; harsh heat; rain blocks sealing 4–7 days/wk vs winter going ~20 dry days) → the cost
  engine's job is the **price FLOOR** (how low summer prices can go to fill days without bleeding) + a
  **commercial pipeline** to fill capacity (consistent hours, high margin). HONEST caveat: commercial also
  wants winter + is a long in-person cycle, so it's ONE lever, not a silver bullet — target schedule-flexible
  commercial clients and pitch summer as a feature (faster turnaround, more attention). **WINTER =
  capacity-constrained** (booming, dry, already 7 days/wk Mon–Sun; marketing could OVERWHELM beyond what they
  can finish) → flip the engine to **TRIAGE**: when you can't do everything, take the highest per-job-profit
  work and **RAISE prices** — if you literally can't fit all the work, that's the signal you're still
  underpriced in winter (demand > capacity = pricing power left on the table). **Sealing runs YEAR-ROUND (only the sealant TYPE is seasonal — summer water-based, winter oil/solvent):**
  dry winter is sealing's window → the attach-rate engine should be **season-aware** (push seal upsells
  ALL YEAR — winter with the premium oil/solvent (better finish, dry window), summer with water-based
  (rain-forgiving). Summer sealing has materially helped summer profit; do NOT ease off it in summer). **Cash-flow:** winter IS the profit; reserve it to carry the lean summer.
- **Fixed / overhead (monthly entry, PREFILL-and-confirm):** the monthly screen prepopulates last month's
  numbers; Tyler confirms or tweaks (insurance/phone drift). Confirmed: **rent $4,400/mo** · vehicle insurance
  (1 policy semi-annual + 2 monthly) · business insurance monthly · phone monthly. Occasional variable:
  truck/rig repairs + tires (NOT the rigs/trucks themselves — aluminum rigs last long). Plus **2 truck payments**/mo, **SunPass/tolls**, and registration/tags +
  licenses/permits — Tyler lumps these vehicle items under one **'truck' bucket**. **Dropped (confirmed):**
  card fees (Zelle / cash / check / Venmo only, no cards) · Bouncie GPS sub (~$24/mo, de minimis) · marketing
  (defer until ad spend is real).
- **Labor confirmed:** calendar logs who worked + which truck + half-day → engine reads it. Crew paid
  **cash** now → labor = flat day rate only ($150 / Jonathan $160 / half $75), **no payroll-tax /
  workers'-comp line** for now (Tyler formalizes later; revisit then).

---
*Maintained by Cowork. Last updated 2026-06-18. §12–§15 pricing-system session; §16 Cost & Profitability
Hub (two-heads COGS layer — day-rate labor from calendar, receipts-only gas, manual→learned chlorine,
equipment registry by serial+hours). Strategy mirror: "Intelligent Pricing System — Master Roadmap" Google Doc.*
