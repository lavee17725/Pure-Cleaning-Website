import React, { useEffect, useState } from "react";

const REVIEWS_BIN = "69f4f09836566621a8144a10";
const REVIEWS_KEY = "$2a$10$CPlkZPaDq7IChEHDKrwWBeF5ltP4WsR1XQgcachhQUdf2Penp7f/i";
const CACHE_TTL   = 24 * 60 * 60 * 1000; // 24 hours
const ANGI_URL    = "https://www.angi.com/companylist/us/fl/ft-lauderdale/pure-cleaning-pressure-cleaning-reviews-2354397.htm";
const GOOGLE_URL  = "https://share.google/ChFC1uAe9Xdveb8XN";

const STATIC_REVIEWS = [
  {
    author: "Ana B.",
    stars: 5,
    text: "Absolutely amazing service! Tony and his crew pressure washed our roof and driveway — it looks brand new. Professional, quick, and reasonably priced. Highly recommend!",
  },
  {
    author: "Michael R.",
    stars: 5,
    text: "Used Pure Cleaning for our roof soft wash and sealing. They were on time, thorough, and the results speak for themselves. Our neighbors asked who we used!",
  },
  {
    author: "Sandra L.",
    stars: 5,
    text: "Tony has been cleaning my home for over 10 years. Always consistent, always professional. Would never use anyone else.",
  },
  {
    author: "James K.",
    stars: 5,
    text: "Incredible results. Our driveway had rust stains that had been there for years — completely gone after one visit. Fast, friendly, and fair pricing.",
  },
];

function StarRow({ count = 5, size = 18 }) {
  return (
    <span style={{ color: "#f4a620", fontSize: size, letterSpacing: 1 }}>
      {"★".repeat(count)}
    </span>
  );
}

export default function Reviews() {
  const [googleData, setGoogleData] = useState({ rating: 5.0, count: 101 });

  useEffect(() => {
    // Check localStorage cache first
    try {
      const cached = localStorage.getItem("pcpc_reviews");
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < CACHE_TTL) {
          if (data.google) setGoogleData(data.google);
          return;
        }
      }
    } catch (_) {}

    // Fetch from JSONbin
    fetch(`https://api.jsonbin.io/v3/b/${REVIEWS_BIN}/latest`, {
      headers: { "X-Master-Key": REVIEWS_KEY },
    })
      .then((r) => r.json())
      .then((d) => {
        const rec = d.record || {};
        if (rec.google) {
          setGoogleData(rec.google);
          localStorage.setItem(
            "pcpc_reviews",
            JSON.stringify({ data: rec, timestamp: Date.now() })
          );
        }
      })
      .catch(() => {
        /* keep fallback */
      });
  }, []);

  return (
    <div className="reviews-section">
      {/* ── Section header ── */}
      <div className="reviews-hero">
        <h2 className="reviews-headline">What South Florida Homeowners Say</h2>
        <p className="reviews-sub">
          30 years of family service, thousands of homes cleaned.
        </p>

        {/* ── Review platform badges ── */}
        <div className="review-badges">
          <a
            href={GOOGLE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="review-badge google-badge"
            aria-label="See our Google reviews"
          >
            <span className="badge-platform">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ verticalAlign: "middle", marginRight: 5 }}>
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Google
            </span>
            <div className="badge-stars">
              <StarRow />
              <span className="badge-rating">{googleData.rating.toFixed(1)}</span>
            </div>
            <div className="badge-count">{googleData.count}+ reviews</div>
          </a>

          <a
            href={ANGI_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="review-badge angi-badge"
            aria-label="See our Angi reviews"
          >
            <span className="badge-platform">
              <span style={{ fontSize: 16, marginRight: 5 }}>🔧</span>
              Angi
            </span>
            <div className="badge-stars">
              <StarRow />
              <span className="badge-rating">5.0</span>
            </div>
            <div className="badge-count">388 reviews</div>
          </a>
        </div>
      </div>

      {/* ── Review cards ── */}
      <div className="review-cards-wrap">
        {STATIC_REVIEWS.map((r, i) => (
          <div className="review-card" key={i}>
            <div className="review-card-stars">
              <StarRow size={15} />
            </div>
            <p className="review-card-text">"{r.text}"</p>
            <div className="review-card-author">— {r.author}</div>
          </div>
        ))}
      </div>

      {/* ── CTA ── */}
      <div className="reviews-cta">
        <a href={GOOGLE_URL} target="_blank" rel="noopener noreferrer" className="reviews-cta-link">
          See all {googleData.count}+ Google reviews →
        </a>
      </div>
    </div>
  );
}
