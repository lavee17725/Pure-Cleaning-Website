#!/usr/bin/env node
/**
 * Post-build JSON-LD injection.
 *
 * CRA's html-minifier-terser treats `<script type="application/ld+json">` as JS
 * and strips the object body, shipping an empty `{}` that destroys SEO schema.
 * Rather than ejecting CRA or adopting craco just to disable one minifier flag,
 * we re-inject the canonical JSON-LD into build/index.html after `react-scripts
 * build` finishes. The string below is the source-of-truth — it must match the
 * head block in public/index.html.
 */
const fs   = require('fs');
const path = require('path');

const JSONLD = {
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  "@id": "https://purecleaningpressurecleaning.com/",
  "name": "Pure Cleaning Pressure Cleaning",
  "alternateName": "Pure Cleaning",
  "description": "Family-owned pressure washing company serving South Florida since 1995. Specializing in roof cleaning, driveway pressure washing, house washing, and concrete sealing.",
  "url": "https://purecleaningpressurecleaning.com/",
  "telephone": "+19543892642",
  "email": "info@purecleaningpressurecleaning.com",
  "foundingDate": "1995",
  "image": "https://purecleaningpressurecleaning.com/images/hero-roof-cleaning-barrel-tile.jpg",
  "logo": "https://purecleaningpressurecleaning.com/images/logo-pure-cleaning.png",
  "priceRange": "$$",
  "address": {
    "@type": "PostalAddress",
    "streetAddress": "16621 SW 62nd Street",
    "addressLocality": "Southwest Ranches",
    "addressRegion": "FL",
    "postalCode": "33331",
    "addressCountry": "US"
  },
  "geo": {
    "@type": "GeoCoordinates",
    "latitude": 26.0418239,
    "longitude": -80.3709794
  },
  "areaServed": [
    { "@type": "AdministrativeArea", "name": "Broward County, Florida" },
    { "@type": "AdministrativeArea", "name": "Miami-Dade County, Florida" },
    { "@type": "AdministrativeArea", "name": "Palm Beach County, Florida" },
    { "@type": "City", "name": "Weston",            "containedInPlace": { "@type": "State", "name": "Florida" } },
    { "@type": "City", "name": "Davie",             "containedInPlace": { "@type": "State", "name": "Florida" } },
    { "@type": "City", "name": "Plantation",        "containedInPlace": { "@type": "State", "name": "Florida" } },
    { "@type": "City", "name": "Coral Springs",     "containedInPlace": { "@type": "State", "name": "Florida" } },
    { "@type": "City", "name": "Pembroke Pines",    "containedInPlace": { "@type": "State", "name": "Florida" } },
    { "@type": "City", "name": "Parkland",          "containedInPlace": { "@type": "State", "name": "Florida" } },
    { "@type": "City", "name": "Sunrise",           "containedInPlace": { "@type": "State", "name": "Florida" } },
    { "@type": "City", "name": "Southwest Ranches", "containedInPlace": { "@type": "State", "name": "Florida" } },
    { "@type": "City", "name": "Cooper City",       "containedInPlace": { "@type": "State", "name": "Florida" } },
    { "@type": "City", "name": "Miramar",           "containedInPlace": { "@type": "State", "name": "Florida" } },
    { "@type": "City", "name": "Hollywood",         "containedInPlace": { "@type": "State", "name": "Florida" } }
  ],
  "hasOfferCatalog": {
    "@type": "OfferCatalog",
    "name": "Pressure Washing Services",
    "itemListElement": [
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Roof Cleaning",              "description": "Soft wash and pressure roof cleaning for shingle, flat tile, and barrel tile roofs. Removes algae, mold, and mildew safely." } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Driveway Pressure Washing",  "description": "High-pressure cleaning of concrete and paver driveways. Removes oil stains, rust, dirt, and organic growth." } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "House Washing",              "description": "Exterior house washing and soft wash to clean siding, stucco, and painted surfaces safely." } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Patio & Pool Deck Cleaning", "description": "Pressure washing of patios, pool decks, sidewalks, and entranceways." } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Concrete & Paver Sealing",   "description": "Professional concrete and paver sealing to protect driveways and patios after cleaning." } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Fence & Wall Washing",       "description": "Cleaning of fences, retaining walls, screen enclosures, and exterior walls." } },
      { "@type": "Offer", "itemOffered": { "@type": "Service", "name": "Rust Removal",               "description": "Rust stain removal from concrete, pavers, walls, fences, and other exterior surfaces." } }
    ]
  },
  "sameAs": [
    "https://www.angi.com/companylist/us/fl/ft-lauderdale/pure-cleaning-pressure-cleaning-reviews-2354397.htm"
  ],
  "openingHoursSpecification": [
    {
      "@type": "OpeningHoursSpecification",
      "dayOfWeek": ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"],
      "opens": "07:00",
      "closes": "22:00"
    }
  ]
};

const BUILD_HTML = path.resolve(__dirname, '..', 'build', 'index.html');
if (!fs.existsSync(BUILD_HTML)) {
  console.error('inject-jsonld: build/index.html not found — did react-scripts build run?');
  process.exit(1);
}

const html = fs.readFileSync(BUILD_HTML, 'utf8');

// Replace the (now empty/mangled) JSON-LD script block with a single-line valid one.
// Anchor on the type attribute; tolerate either an empty body or a literal `{` from
// terser's mangled output.
const re = /<script type="application\/ld\+json">[\s\S]*?<\/script>/;
if (!re.test(html)) {
  console.error('inject-jsonld: no <script type="application/ld+json"> tag found in build/index.html');
  process.exit(1);
}

const replacement = '<script type="application/ld+json">' + JSON.stringify(JSONLD) + '</script>';
const out = html.replace(re, replacement);
fs.writeFileSync(BUILD_HTML, out);

console.log(`inject-jsonld: OK — restored JSON-LD (${replacement.length} bytes) into build/index.html`);
