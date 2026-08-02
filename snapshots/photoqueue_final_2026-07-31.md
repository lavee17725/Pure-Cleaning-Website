# PhotoQueue — final archive before table drop (2026-07-31)

The GBP M/W/F photo pipeline was removed on 2026-07-31 (Tyler: Google deprecated
the photo-upload API for standard profiles, so it could never do the one thing
it was built for — auto-post — making it dead weight).

`PhotoQueue` held **1,536 rows**: 1,509 `untagged`, 7 `queued`, 20 `skipped`.

The 1,509 untagged rows were only filename records pointing at photos in
`website-assets/` on Tyler's Mac — no human work in them, and **those photo files
are untouched**. The 27 rows below are the only ones holding human decisions, so
they are preserved here verbatim.

## Queued slots (7) — tagged, captioned, scheduled, never posted

| Slot | City | Service | Type | Source file |
|---|---|---|---|---|
| 2026-07-27 | Davie | roof | after | `before-after/roof before and after 1/IMG_5240.HEIC` |
| 2026-07-29 | Weston | roof | general | `before-after/roof before and after 1/IMG_5370.JPG` |
| 2026-07-31 | Plantation | roof | before | `before-after/roof before and after 1/IMG_5858.JPG` |
| 2026-08-03 | Cooper City | roof | after | `before-after/roof before and after 1/IMG_5859.JPG` |
| 2026-08-05 | Sunrise | roof | general | `before-after/roof before and after 1/IMG_8386.PNG` |
| 2026-08-07 | Coral Springs | seal | general | `before-after/sealing and sand photos/62984075847__FFF0FC8E-7B1F-4393-BB72-C3F71DFC56C6.HEIC` |
| 2026-08-10 | Sunrise | roof | after | `before-after/roof before and after 1/IMG_8387.PNG` |

Generated captions followed two templates, e.g.:

- `Davie, FL — fresh roof cleaning by Pure Cleaning 💦 Trusted by your neighbors since 1995. 📞 954-389-2642 · purecleaningpressurecleaning.com`
- `Roof cleaning completed in Cooper City, FL ✨ Family-owned Pure Cleaning has been keeping South Florida homes spotless since 1995. 📞 954-389-2642 · purecleaningpressurecleaning.com`

SEO filenames followed `{service}-{city}-fl-pure-cleaning-{YYYY-MM-DD}.jpg`.

If Tyler ever wants to post these manually, the source files above are still in
`website-assets/` and the captions are reproducible from this table.

## Skipped (20) — deliberately excluded from posting

Contact sheets and triage composites, not real job photos:

`before-after/new photos/_triage/contact_00.jpg` … `contact_05.jpg` (6),
`before-after/sheets/sheet_1.jpg` … `sheet_6.jpg` (6),
`before-after/sheets/wave2_1.jpg` … `wave2_8.jpg` (8).

## What was NOT touched

- `website-assets/` — Tyler's ~5.5GB of real photos on his Mac, untouched.
- The crew/job photo system: `PHOTOS` R2 bucket, `/photos`, `/admin/photos/*`,
  `Job.photoKeys`, `Property.photoKeys`, completion-modal photo upload. That is
  a completely separate system and remains fully operational.
