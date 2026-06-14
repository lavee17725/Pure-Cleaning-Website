# Pure Cleaning — SEO Action Plan
### Goal: the best-ranked pressure-washing company in South Florida
*Research compiled June 14, 2026. Cross-checked across Google Search Central, Whitespark 2026, Sterling Sky, BrightLocal, web.dev. Sources at the end.*

---

## The 5 highest-ROI moves (if you do nothing else, do these)

1. **Optimize the Google Business Profile.** GBP is ~**32% of local-pack ranking** — it outweighs the entire website for the map. Right category + services + reviews + freshness is the single biggest lever, and it's free.
2. **Make each city page genuinely unique — or Google buries them.** The 6 near-identical city pages are in Google's *doorway / scaled-content* risk zone. The **March 2026 core update specifically hit "templated location pages that swap in a city name."** This is existential for those pages.
3. **Run a relentless monthly review drip.** You have 120 at 5.0 (excellent) — but **velocity and recency beat raw count.** New, text-rich reviews every week that name the service + city is the lever now. Don't let it stall (rankings can drop after ~3 weeks of silence).
4. **Pull the self-serving star rating out of the site code.** Our pages currently mark up `aggregateRating` (5.0/120). Google has **ignored self-serving review stars since 2019** — it does nothing for us and carries slight manual-action risk. Earn stars where they actually show: GBP, Yelp, Angi.
5. **Fix Google Search Console + image speed.** Get the new pages indexed (GSC + sitemap) and fast (images are the bottleneck on a static site like ours).

---

## ⚠️ THE #1 RISK — your 6 city pages can get buried as "doorway pages"

Every source flagged this independently. Google's spam policy explicitly names *"creating substantially similar pages"* and *"pages targeted at specific cities that funnel users to one page"* as **doorway abuse**, and the **March 2024 + March 2026** updates demote templated city-swap pages. Templated location pages have been documented losing **~80% of rankings** after these updates.

**The test:** if you could swap the city name and the rest of the page still reads fine, the page fails. Right now our city pages share an identical services grid, before/after set, and reviews strip — only the hero stat, lived-in paragraph, and FAQ differ. **That's not enough.**

**The fix (non-negotiable for these pages to survive):**
- **600–1,200 words of genuinely city-specific copy** per page (we're well under that).
- **Real before/after photos from jobs in that city** (ties to the photo pass — no recycling).
- **A real customer testimonial or two from that city.**
- **Neighborhood + condition specifics** (barrel-tile HOAs in Weston, coastal salt-air algae, etc.) — you already started this in the lived-in paragraph; expand it.
- **6 cities is a manageable number — fully differentiate all six** rather than scaling to dozens of thin ones. If a city can't get unique 600+ words, don't publish it yet.

> **This also answers your "remove the FAQs" question: KEEP them.** The per-city FAQs (zips, HOA detail) are exactly the *unique local content* that keeps each page from looking like a duplicate. Removing them makes the doorway risk worse. Add a *general* FAQ to the homepage too — but don't strip the city ones.

---

## DO FIRST — this week (highest ROI, mostly free, mostly GBP/Mom-Tyler)

**Google Business Profile (biggest lever):**
- Set **primary category = "Pressure Washing Service"** (specific beats generic "Cleaning Service").
- Add every **relevant** secondary category: Power Washing Service, Roof Cleaning Service, Building/Exterior Cleaning Service. (Adding *relevant* categories does NOT dilute ranking — verified by a Feb 2026 study; only irrelevant ones hurt.)
- **Fully populate the Services list** — prefer Google's pre-defined options (they move rankings more than custom), then add custom for the rest. Effect shows in **24–72 hours**.
- Keep **hours accurate** (now Mon–Sun 7am–10pm — Google favors currently-open businesses).
- Reviews: respond to **100% of reviews** within 24–48h, personalized (lifts conversions ~16%); keep coaching customers to name the **service + city** in the text (you already do this — it's correct and it feeds Google's "justifications").

**Website code (I can do these now — the research surfaced them):**
- **Remove the self-serving `aggregateRating`** from the LocalBusiness/Service JSON-LD on every page (it's ignored + slight risk).
- **Keep all FAQ content; do NOT add FAQPage schema** — FAQ rich results were killed for ordinary businesses (gov/health only since 2023; gone entirely **May 7 2026**). The content still helps AI Overviews + conversions; the schema buys nothing now.
- **Add `BreadcrumbList` schema** (Home › Service Areas › Weston) — still a live rich result and helps crawl.

**Tyler home task:**
- **Google Search Console** — verify the domain, submit `sitemap.xml`, request indexing on the 5 new city pages. (Still pending — this is what gets the new pages found.)

**Strategic decision to make (flagged, your call):**
- **The address question.** Sterling Sky's Nov-2025 study (8,186 businesses) found that *hiding* your address as a service-area business **correlated with worse map-pack rankings** — and they reproduced it live (hid address → rankings fell; restored → recovered). Google ranks you from your **verified address location**, not the service-area list. If privacy allows, showing a real verified address in/near your densest target city likely helps. This contradicts Google's "hide it" advice for SABs — so **test it, don't blindly flip it.** Worth a conversation.

---

## DO NEXT — this month

**City-page differentiation** (the #1 risk fix above): unique 600–1,200 words + real per-city photos + testimonials. Pairs with the photo pass.

**Schema cleanup:** specific LocalBusiness subtype; `Service` schema on the paver-sealing page with `areaServed`; `BreadcrumbList` everywhere; NAP (name/address/phone) **identical** to GBP and all listings. Validate in Google's Rich Results Test.

**Citations + NAP** (Tyler): lock identical NAP everywhere; claim/optimize the Tier-1 set — **Apple Business Connect** (Apple Maps — often missed), **Bing Places**, **Yelp**, Facebook; then BBB, Foursquare, Nextdoor, and the home-services directories (Angi — already strong at 388 — HomeAdvisor, Thumbtack, Houzz). Push the 3 data aggregators that feed everything else: **Data Axle, Neustar Localeze, Foursquare**. Consistent NAP makes you ~40% more likely to appear in the local pack.

**Image speed** (pairs with photo pass): serve **AVIF → WebP → JPEG** via `<picture>`; **explicit width/height on every image** (kills layout shift / CLS); `loading="lazy"` on below-the-fold images **only** (never the hero); **`fetchpriority="high"` on the hero** (one study cut load time 2.6s→1.9s); responsive `srcset`; target <200KB/image. (INP replaced FID in 2024, but a low-JS static site passes INP easily — images are our real battleground.)

**Money content pages** (these win both classic search AND AI Overviews):
- **"Roof soft-wash vs pressure washing"** — the #1 topic in the niche; frame around algae-at-the-root, ARMA approval, "stays clean 4–5× longer."
- **"How much does paver sealing / roof cleaning cost in South Florida"** — cite real ranges ($1.25–$4.00/sqft for paver clean+seal).
- **"How often should you pressure wash in South Florida"** — house 1×/yr (2× near coast), driveways 12–18mo, roof soft-wash every 1–2yr, pre-rainy-season.
- **HOA / property-manager pillar page** — underserved, high-value; FL HOAs *mandate* algae-free roofs/driveways. Target the decision-maker (compliance docs, photo records, neighborhood-day discounts). This is a real lead vein for you.

---

## DO LATER — the ongoing engine

- **Local link building (~5–10/month):** Chamber of Commerce + BBB (easy trusted links), local sponsorships (youth sports, charity 5Ks — best bang-for-buck), supplier/manufacturer "find a pro" pages (paver-sealer brands), realtor / property-manager / HOA partnerships (links *and* leads). **Skip HARO** — it declined and shut down/rebranded; low ROI for a local pressure-washer.
- **Local/seasonal blog** as a supporting engine (not the main play): rainy-season algae, HOA compliance, per-city "why your driveway in [city] stays dirty" angle posts. Generic "10 tips" blogging is a waste — only local/seasonal/linkable pieces earn their keep.
- **On-site reviews ticker** (your "passing reviews" idea): Google's API only returns ~5 reviews and scraping breaks their terms, so to scroll more we'd use a **compliant widget** (Featurable, Elfsight, etc.) or import via the **GBP API**, or curate testimonials. It's purely conversion/social-proof (won't generate SERP stars). Won't slow the site.
- **Quarterly NAP audit;** monitor GSC for "Crawled – currently not indexed" on city pages (the early warning that a page reads as thin).

---

## Schema corrections to make on the pages we built (concrete)

| Change | Why |
|---|---|
| **Remove** `aggregateRating` from LocalBusiness/Service JSON-LD | Self-serving stars ignored since 2019; no benefit, slight risk |
| **Keep** FAQ content, **don't add** FAQPage schema | FAQ rich result dead for our type (gone May 2026); content still helps AI + conversion |
| **Add** `BreadcrumbList` | Still a live rich result; helps crawl + hierarchy |
| **Keep** `areaServed` (already in our schema) | Correct way to express a service-area business |
| Use specific LocalBusiness subtype; NAP matches GBP exactly | Relevance + consistency |

---

## Competitor teardown — who to copy and beat

- **WashPro Florida (Weston-based) — copy heavily.** Strong UX: a side-by-side **soft-wash vs pressure-wash comparison table**, a real **FAQ**, **service-area cards**, and **stat counters** (reviews, properties, years), multiple sticky CTAs. *Beat them:* their per-city depth is thin (cards, not real pages) and no blog — out-content them with genuine city pages + the money content above.
- **Riverview Pressure Cleaning (Tampa) — copy the content model.** High-cadence local blog + a deep, owner-voiced **HOA pillar guide** with inline testimonials. The blueprint for your content engine. *Beat them:* dated template + Tampa-only — you can match the engine with a better-looking Broward site.
- **AR&D + Surface Clean (Broward) — beatable now.** Wix/EZ-template sites, duplicated copy, no schema, no FAQ, no city pages. Direct local competitors you can outrank on paver/sealing keywords with the work in this plan.
- **Window Hero (national) — copy the architecture.** `/locations/[city]/` page + localized blog per city — the scalable, non-doorway way to do multi-city. Google's own guidance: **15–20 strong unique city pages beat hundreds of thin ones.**

---

## AI Overviews — where local search is going

- **Local intent is a natural shield.** A 237K-query home-services study found **"pressure washing [city]" / "near me" queries trigger AI Overviews far less** than informational ones. Your bread-and-butter queries are comparatively safe; cost/how-to content is where AI Overviews show (so structure those answer-first).
- **To get cited / keep the click:** a fully-optimized GBP + real reviews, unique local pages, clean schema, concise answer-shaped passages — and lean into **before/after galleries + the quote tool**, the things AI can't replicate that pull the click to your site. ~38% of AI Overview citations come from the top-10 organic results, so the work above compounds.

---

## Sources
**Google (primary):** Search Central spam policies (doorway/scaled-content) · FAQPage deprecation doc · LocalBusiness / Breadcrumb / Service structured-data docs · 2024 core-update + spam-policy post · web.dev Core Web Vitals (INP) · Google Maps Platform ToS (review caching/scraping) · GBP chat/call-history sunset.
**Local-SEO authorities:** Whitespark 2026 Local Search Ranking Factors · Sterling Sky (near-me study Nov 2025; service-area & services-impact studies; reviews study) · BrightLocal (local algorithm, review schema, Local Consumer Review Survey 2025) · RicketyRoo (location-page spam) · GSQI/Glenn Gabe (spam-update case studies).
**Technical/content:** web.dev · Search Engine Land/Journal/Roundtable · WebFX AI-Overviews home-services study · Ahrefs AIO citations.
**Competitors examined:** washproflorida.com · riverviewpressurecleaning.com · ardcleaningservices.com · surfacecleanpressuresoftwash.com · windowhero.com.

*Full URL list retained in the research notes — ask and I'll drop them inline anywhere you want to dig deeper.*
