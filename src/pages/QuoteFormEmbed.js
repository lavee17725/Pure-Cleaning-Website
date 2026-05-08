import { useState, useEffect } from 'react';

const PCPC_API = 'https://purecleaning-api.tylerfumero.workers.dev';

const STANDARD_SERVICES = [
  'Driveway', 'Patio', 'Sidewalk', 'Rinse walls',
  'Prep for painting', 'Entranceway', 'Screen enclosure', 'Balcony',
];

const ROOF_METHODS = [
  { key: 'Softwash', label: 'Softwash', badge: '⭐ Most popular', desc: 'Kills algae & mold at the root. Works on all roof types — great for homes with gutters.' },
  { key: 'Traditional brush cleaning', label: 'Traditional brush cleaning', desc: 'Gentle on landscaping. Limited chemical runoff — soap and water scrub.' },
  { key: 'Water only pressure cleaning', label: 'Water only (no chemicals)', desc: 'Zero chemical exposure. Safe for all plants and soil.' },
];

function getWeekOptions() {
  const today = new Date();
  const dow = today.getDay();
  const daysToMon = dow === 0 ? -6 : 1 - dow;
  const mon = new Date(today);
  mon.setDate(today.getDate() + daysToMon);
  mon.setHours(0, 0, 0, 0);
  const labels = ['This Week', 'Next Week', 'In 2 Weeks', 'In 3 Weeks'];
  const vals = ['This week', '1 week out', '2 weeks out', '3 weeks out'];
  const fmt = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const opts = labels.map((lbl, i) => {
    const s = new Date(mon);
    s.setDate(mon.getDate() + i * 7);
    const e = new Date(s);
    e.setDate(s.getDate() + 6);
    return { label: lbl, value: vals[i], weekStart: s.toISOString().slice(0, 10), dateRange: `${fmt(s)} – ${fmt(e)}` };
  });
  opts.push({ label: 'Flexible / Whenever', value: 'Flexible / Whenever', weekStart: null, dateRange: 'Any week works for me' });
  return opts;
}

// ─── Inline style tokens ─────────────────────────────────────────────────────
const C = {
  navy: '#0a1628', blue: '#1a4a8a', sky: '#2d7dd2',
  gold: '#f4a620', green: '#1d9e75', rust: '#c2410c',
  white: '#fff', gray: '#f5f6f8', text: '#1a1f2e',
  muted: '#6b7280', border: '#e2e8f0',
};

const inp = {
  display: 'block', width: '100%', padding: '11px 13px',
  border: `1.5px solid ${C.border}`, borderRadius: 10,
  fontSize: 15, fontFamily: 'inherit', color: C.text,
  background: '#fff', outline: 'none', boxSizing: 'border-box',
};
const inpErr = { ...inp, borderColor: '#e53e3e' };
const lbl = { fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 5, display: 'block' };
const req = { color: '#e53e3e' };
const fieldWrap = { marginBottom: 14 };
const row2 = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 };
const sectionLbl = {
  fontSize: 11, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase',
  color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 20, marginTop: 24, marginBottom: 14,
};

// ─── Sub-components ──────────────────────────────────────────────────────────
function Cb({ checked, color = C.sky }) {
  return (
    <div style={{
      width: 22, height: 22, borderRadius: 6, border: `2px solid ${checked ? color : C.border}`,
      background: checked ? color : 'transparent', display: 'flex', alignItems: 'center',
      justifyContent: 'center', flexShrink: 0, transition: 'all .15s',
    }}>
      {checked && <span style={{ color: '#fff', fontSize: 13, fontWeight: 700, lineHeight: 1 }}>✓</span>}
    </div>
  );
}

function ServiceCheck({ label, checked, onClick, color }) {
  return (
    <div onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px',
      border: `1.5px solid ${checked ? (color || C.sky) : C.border}`,
      borderRadius: 10, cursor: 'pointer', background: checked ? '#f0f7ff' : '#fafafa',
      transition: 'all .15s', userSelect: 'none',
    }}>
      <Cb checked={checked} color={color || C.sky} />
      <span style={{ fontSize: 14, fontWeight: 500, color: C.text }}>{label}</span>
    </div>
  );
}

function WeekCard({ opt, selected, blocked, onSelect, onWaitlist }) {
  if (blocked) {
    return (
      <div onClick={() => onWaitlist(opt)} style={{
        padding: '14px 16px', border: `1.5px solid ${C.border}`, borderRadius: 12,
        cursor: 'pointer', background: '#f9fafb', opacity: 0.8, transition: 'all .15s',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: C.muted }}>{opt.label}</span>
          <span style={{ fontSize: 10, fontWeight: 700, background: '#fee2e2', color: '#b91c1c', padding: '2px 8px', borderRadius: 20, letterSpacing: .5 }}>Full</span>
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>{opt.dateRange}</div>
        <div style={{ fontSize: 11, color: C.rust, fontWeight: 600 }}>Tap to join waitlist →</div>
      </div>
    );
  }
  return (
    <div onClick={() => onSelect(opt)} style={{
      padding: '14px 16px', border: `1.5px solid ${selected ? C.sky : C.border}`,
      borderRadius: 12, cursor: 'pointer', background: selected ? '#eff6ff' : '#fff',
      transition: 'all .15s',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div style={{
          width: 18, height: 18, borderRadius: '50%', border: `2px solid ${selected ? C.sky : C.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          {selected && <div style={{ width: 8, height: 8, borderRadius: '50%', background: C.sky }} />}
        </div>
        <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{opt.label}</span>
        {!opt.weekStart && <span style={{ fontSize: 10, fontWeight: 700, background: '#f0fdf4', color: '#16a34a', padding: '2px 8px', borderRadius: 20, letterSpacing: .5 }}>Flexible</span>}
      </div>
      <div style={{ fontSize: 12, color: C.muted, paddingLeft: 26 }}>{opt.dateRange}</div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
export default function QuoteFormEmbed() {
  const [form, setForm] = useState({ firstName: '', lastName: '', phone: '', email: '', address: '', city: '', zip: '', notes: '', otherServices: '' });
  const [services, setServices] = useState(new Set());
  const [roofChecked, setRoofChecked] = useState(false);
  const [roofMethod, setRoofMethod] = useState('');
  const [fenceChecked, setFenceChecked] = useState(false);
  const [fenceType, setFenceType] = useState('');
  const [sealChecked, setSealChecked] = useState(false);
  const [sealSurfaces, setSealSurfaces] = useState(new Set());
  const [rustChecked, setRustChecked] = useState(false);
  const [rustArea, setRustArea] = useState('');
  const [selectedWeek, setSelectedWeek] = useState(null);
  const [blockedWeeks, setBlockedWeeks] = useState([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [weekError, setWeekError] = useState(false);
  const [fieldErrors, setFieldErrors] = useState(new Set());
  const [reviewCount, setReviewCount] = useState(101);
  const [waitlistFor, setWaitlistFor] = useState(null);
  const [waitlistForm, setWaitlistForm] = useState({ name: '', phone: '', email: '' });
  const [waitlistSent, setWaitlistSent] = useState(false);

  useEffect(() => {
    const CACHE_KEY = 'pcpc_blocked_weeks_v2';
    const TTL = 5 * 60 * 1000;
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < TTL) { setBlockedWeeks(data || []); return; }
      }
    } catch (_) {}
    fetch(`${PCPC_API}/blocked-weeks`)
      .then(r => r.ok ? r.json() : {})
      .then(d => {
        const fresh = d.blockedWeeks || [];
        try { localStorage.setItem('pcpc_blocked_weeks_v2', JSON.stringify({ data: fresh, timestamp: Date.now() })); } catch (_) {}
        setBlockedWeeks(fresh);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const CACHE_KEY = 'pcpc_google_reviews_quote';
    const TTL = 24 * 60 * 60 * 1000;
    try {
      const cached = localStorage.getItem(CACHE_KEY);
      if (cached) {
        const { data, timestamp } = JSON.parse(cached);
        if (Date.now() - timestamp < TTL && data.count) { setReviewCount(data.count); return; }
      }
    } catch (_) {}
    fetch(`${PCPC_API}/reviews`)
      .then(r => r.json())
      .then(d => {
        if (d && d.count) {
          setReviewCount(d.count);
          try { localStorage.setItem('pcpc_google_reviews_quote', JSON.stringify({ data: d, timestamp: Date.now() })); } catch (_) {}
        }
      })
      .catch(() => {});
  }, []);

  const weekOpts = getWeekOptions();

  function setField(key, val) { setForm(f => ({ ...f, [key]: val })); }

  function toggleService(svc) {
    setServices(prev => { const n = new Set(prev); n.has(svc) ? n.delete(svc) : n.add(svc); return n; });
  }
  function toggleSealSurface(svc) {
    setSealSurfaces(prev => { const n = new Set(prev); n.has(svc) ? n.delete(svc) : n.add(svc); return n; });
  }

  function handleSelectWeek(opt) {
    setSelectedWeek(opt);
    setWeekError(false);
    setWaitlistFor(null);
  }

  function handleWaitlistClick(opt) {
    setWaitlistFor(opt);
    setWaitlistSent(false);
    setWaitlistForm({ name: '', phone: '', email: '' });
  }

  async function submitWaitlist() {
    const ph = waitlistForm.phone.replace(/\D/g, '');
    if (!waitlistForm.name.trim() || ph.length < 10) {
      alert('Please enter your name and a 10-digit phone number.'); return;
    }
    try {
      await fetch(`${PCPC_API}/incoming`, {
        method: 'POST', keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: Date.now().toString(), submittedAt: new Date().toISOString(),
          status: 'waitlist', quotedAt: null,
          customerData: {
            firstName: waitlistForm.name.split(' ')[0], lastName: waitlistForm.name.split(' ').slice(1).join(' '),
            phone: ph, email: waitlistForm.email, address: '', city: '', services: [],
            timeframe: waitlistFor?.label,
            notes: `Waitlist: wants ${waitlistFor?.label} (${waitlistFor?.weekStart})`
          }
        })
      });
      setWaitlistSent(true);
    } catch (e) {
      alert('Could not add to waitlist. Please call 954-389-2642.');
    }
  }

  async function handleSubmit() {
    const required = ['firstName', 'lastName', 'phone', 'address', 'city'];
    const errors = new Set();
    required.forEach(f => { if (!form[f].trim()) errors.add(f); });
    setFieldErrors(errors);
    if (errors.size > 0) { alert('Please fill in all required fields.'); return; }

    const allServices = [];
    if (roofChecked) { allServices.push('Roof cleaning' + (roofMethod ? ` (${roofMethod})` : '')); allServices.push('Rinse walls & windows'); }
    services.forEach(s => allServices.push(s));
    if (fenceChecked) allServices.push(fenceType || 'Fence');
    if (rustChecked) allServices.push(`Rust removal — ${rustArea || 'area TBD'}`);
    if (sealChecked) allServices.push('Sealing quote requested');

    if (allServices.length === 0) { alert('Please select at least one service.'); return; }
    if (!selectedWeek) { setWeekError(true); document.getElementById('qfe-week-section')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }

    setSubmitting(true);

    const slim = { n: `${form.firstName} ${form.lastName}`, p: form.phone, a: `${form.address}, ${form.city} ${form.zip}`, s: allServices.join(', ') };
    const qbLink = 'https://purecleaningpressurecleaning.com/pure_cleaning_quote_builder_v2.html?customer=' + encodeURIComponent(btoa(unescape(encodeURIComponent(JSON.stringify(slim)))));

    fetch(`${PCPC_API}/incoming`, {
      method: 'POST', keepalive: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: Date.now().toString(),
        customer_name: `${form.firstName} ${form.lastName}`,
        submittedAt: new Date().toISOString(),
        status: 'new', quotedAt: null, source: 'homepage',
        customerData: {
          firstName: form.firstName, lastName: form.lastName,
          phone: form.phone, email: form.email,
          address: form.address, city: form.city, zip: form.zip,
          services: allServices,
          sealing: { requested: sealChecked, surfaces: [...sealSurfaces] },
          rustRemoval: { requested: rustChecked, area: rustArea },
          timeframe: selectedWeek.value,
          notes: form.notes, otherServices: form.otherServices
        }
      })
    }).catch(e => console.warn('[incoming]', e.message));

    const fd = new FormData();
    fd.append('_subject', '🧽 New Quote Request (Homepage) — Pure Cleaning');
    fd.append('Customer Name', `${form.firstName} ${form.lastName}`);
    fd.append('Phone', form.phone);
    fd.append('Email', form.email || 'Not provided');
    fd.append('Address', `${form.address}, ${form.city} ${form.zip}`);
    fd.append('Services Requested', allServices.join(', '));
    fd.append('Sealing Surfaces', [...sealSurfaces].join(', ') || 'Not requested');
    fd.append('Preferred Timeframe', selectedWeek.value);
    fd.append('Notes', form.notes || 'None');
    fd.append('🔗 Open Quote Builder', qbLink);
    if (form.email) fd.append('_replyto', form.email);

    const zapData = {
      customer_name: `${form.firstName} ${form.lastName}`,
      phone: form.phone, email: form.email,
      address: `${form.address}, ${form.city} ${form.zip}`,
      services: allServices.join(', '), dates: selectedWeek.value,
      notes: form.notes || 'None', source: 'homepage',
      quote_builder_link: qbLink,
    };

    try {
      await Promise.all([
        fetch('https://formspree.io/f/xlgaylyd', { method: 'POST', body: fd, headers: { 'Accept': 'application/json' } }),
        fetch('https://hooks.zapier.com/hooks/catch/27394065/uvhnkqh/', {
          method: 'POST',
          body: new URLSearchParams(zapData),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }).catch(() => {}),
      ]);
      setSubmitted(true);
      window.scrollTo({ top: document.getElementById('quote-form')?.offsetTop || 0, behavior: 'smooth' });
    } catch (e) {
      alert('Something went wrong. Please call us at 954-389-2642 or try again.');
    } finally {
      setSubmitting(false);
    }
  }

  // ─── Success state ────────────────────────────────────────────────────────
  if (submitted) {
    return (
      <section id="quote-form" style={{ background: '#f5f6f8', padding: '4rem 1.25rem' }}>
        <div style={{ maxWidth: 520, margin: '0 auto', background: '#fff', borderRadius: 20, padding: '2.5rem 2rem', boxShadow: '0 4px 24px rgba(0,0,0,0.08)', textAlign: 'center' }}>
          <div style={{ fontSize: 56, marginBottom: '1rem' }}>✅</div>
          <h2 style={{ fontFamily: '"Bebas Neue", sans-serif', fontSize: 30, color: C.navy, letterSpacing: 2, marginBottom: 10 }}>Request Sent!</h2>
          <p style={{ fontSize: 15, color: C.muted, lineHeight: 1.7 }}>
            Thanks{form.firstName ? `, ${form.firstName}` : ''}! We'll review your request and get back to you{form.phone ? ` at ${form.phone}` : ''} <strong style={{ color: C.text }}>same day</strong> with pricing and available dates.
          </p>
          <p style={{ fontSize: 14, color: C.muted, marginTop: 14 }}>
            Questions? Call us at{' '}
            <a href="tel:9543892642" style={{ color: C.sky, fontWeight: 700, textDecoration: 'none' }}>954-389-2642</a>
          </p>
          <div style={{ marginTop: '1.5rem', borderTop: `1px solid ${C.border}`, paddingTop: '1.5rem', textAlign: 'left' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: 12 }}>What happens next</div>
            {[
              { icon: '📲', text: "We text you pricing today" },
              { icon: '📅', text: 'Confirm your preferred date' },
              { icon: '✅', text: 'We show up and get it spotless' },
            ].map((s, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 0', borderBottom: i < 2 ? `1px solid ${C.border}` : 'none' }}>
                <span style={{ fontSize: 22, flexShrink: 0 }}>{s.icon}</span>
                <span style={{ fontSize: 14, color: C.text }}>{s.text}</span>
              </div>
            ))}
          </div>
        </div>
      </section>
    );
  }

  // ─── Form ─────────────────────────────────────────────────────────────────
  return (
    <section id="quote-form" style={{ background: '#f5f6f8', padding: '3.5rem 0 4rem' }}>

      {/* Section header */}
      <div style={{ textAlign: 'center', padding: '0 1.25rem 2rem' }}>
        <div style={{ display: 'inline-block', background: C.gold, color: C.navy, fontSize: 10, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase', padding: '4px 14px', borderRadius: 20, marginBottom: 12 }}>
          Free Same-Day Quote
        </div>
        <h2 style={{ fontFamily: '"Bebas Neue", sans-serif', fontSize: 34, color: C.navy, letterSpacing: 2, marginBottom: 8, lineHeight: 1.1 }}>
          Get a Free Quote Today
        </h2>
        <p style={{ fontSize: 15, color: C.muted, maxWidth: 460, margin: '0 auto 1.5rem' }}>
          Fill out the form and we'll text you pricing <strong style={{ color: C.text }}>same day</strong> — no waiting, no callbacks.
        </p>

        {/* Review badges */}
        <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <a href="https://share.google/ChFC1uAe9Xdveb8XN" target="_blank" rel="noopener noreferrer" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, background: '#fff', border: `1.5px solid ${C.border}`, borderRadius: 14, padding: '10px 18px', textDecoration: 'none', cursor: 'pointer' }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#4285f4' }}>Google</span>
            <span style={{ color: C.gold, fontSize: 13 }}>⭐⭐⭐⭐⭐</span>
            <span style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>{reviewCount}+ reviews</span>
          </a>
          <a href="https://www.angi.com/companylist/us/fl/ft-lauderdale/pure-cleaning-pressure-cleaning-reviews-2354397.htm" target="_blank" rel="noopener noreferrer" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, background: '#fff', border: `1.5px solid ${C.border}`, borderRadius: 14, padding: '10px 18px', textDecoration: 'none', cursor: 'pointer' }}>
            <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: '#e86128' }}>Angi</span>
            <span style={{ color: C.gold, fontSize: 13 }}>⭐⭐⭐⭐⭐</span>
            <span style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>388 reviews</span>
          </a>
        </div>
      </div>

      {/* Form card */}
      <div style={{ maxWidth: 600, margin: '0 auto', padding: '0 1.25rem' }}>
        <div style={{ background: '#fff', borderRadius: 20, padding: '1.75rem 1.5rem 2rem', boxShadow: '0 4px 24px rgba(0,0,0,0.07)', border: `1px solid ${C.border}` }}>

          {/* Your info */}
          <div style={sectionLbl}>Your info</div>

          <div style={{ ...row2, '@media(maxWidth:480px)': { gridTemplateColumns: '1fr' } }}>
            <div style={fieldWrap}>
              <label style={lbl}>First name <span style={req}>*</span></label>
              <input style={fieldErrors.has('firstName') ? inpErr : inp} value={form.firstName} onChange={e => setField('firstName', e.target.value)} autoComplete="given-name" />
            </div>
            <div style={fieldWrap}>
              <label style={lbl}>Last name <span style={req}>*</span></label>
              <input style={fieldErrors.has('lastName') ? inpErr : inp} value={form.lastName} onChange={e => setField('lastName', e.target.value)} autoComplete="family-name" />
            </div>
          </div>

          <div style={row2}>
            <div style={fieldWrap}>
              <label style={lbl}>Phone <span style={req}>*</span></label>
              <input type="tel" style={fieldErrors.has('phone') ? inpErr : inp} value={form.phone} onChange={e => setField('phone', e.target.value)} autoComplete="tel" placeholder="(954) 000-0000" />
            </div>
            <div style={fieldWrap}>
              <label style={lbl}>Email <span style={{ fontSize: 12, fontWeight: 400, color: C.muted }}>(optional)</span></label>
              <input type="email" style={inp} value={form.email} onChange={e => setField('email', e.target.value)} autoComplete="email" />
            </div>
          </div>

          <div style={fieldWrap}>
            <label style={lbl}>Street address <span style={req}>*</span></label>
            <input style={fieldErrors.has('address') ? inpErr : inp} value={form.address} onChange={e => setField('address', e.target.value)} autoComplete="street-address" placeholder="123 Palm St" />
          </div>

          <div style={row2}>
            <div style={fieldWrap}>
              <label style={lbl}>City <span style={req}>*</span></label>
              <input style={fieldErrors.has('city') ? inpErr : inp} value={form.city} onChange={e => setField('city', e.target.value)} autoComplete="address-level2" placeholder="Davie" />
            </div>
            <div style={fieldWrap}>
              <label style={lbl}>Zip code</label>
              <input style={inp} value={form.zip} onChange={e => setField('zip', e.target.value)} autoComplete="postal-code" placeholder="33024" maxLength={5} />
            </div>
          </div>

          {/* Services */}
          <div style={sectionLbl}>Services needed</div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>

            {/* Roof — full width */}
            <div style={{ gridColumn: 'span 2' }}>
              <ServiceCheck
                label="🏠 Roof cleaning"
                checked={roofChecked}
                color={C.sky}
                onClick={() => { setRoofChecked(r => !r); if (roofChecked) setRoofMethod(''); }}
              />
              {roofChecked && (
                <div style={{ marginTop: 8, border: `1.5px solid ${C.sky}`, borderRadius: 12, overflow: 'hidden' }}>
                  <div style={{ background: '#f0f7ff', padding: '8px 14px', fontSize: 12, color: C.sky, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>
                    Select roof cleaning method <span style={req}>*</span>
                  </div>
                  <div style={{ background: '#fff0f0', padding: '8px 14px', fontSize: 12, color: '#c0392b', fontWeight: 500, borderBottom: `1px solid ${C.border}` }}>
                    ⚠️ We do not service metal roofs.
                  </div>
                  {ROOF_METHODS.map(m => (
                    <div key={m.key} onClick={() => setRoofMethod(m.key)} style={{
                      padding: '12px 14px', borderBottom: `1px solid ${C.border}`, cursor: 'pointer',
                      background: roofMethod === m.key ? '#f0f7ff' : '#fff', transition: 'background .15s',
                    }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                        <div style={{ width: 18, height: 18, borderRadius: '50%', border: `2px solid ${roofMethod === m.key ? C.sky : C.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                          {roofMethod === m.key && <div style={{ width: 8, height: 8, borderRadius: '50%', background: C.sky }} />}
                        </div>
                        <span style={{ fontWeight: 600, fontSize: 14, color: C.text }}>{m.label}</span>
                        {m.badge && <span style={{ marginLeft: 'auto', background: C.gold, color: C.navy, fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 20 }}>{m.badge}</span>}
                      </div>
                      <p style={{ fontSize: 12, color: C.muted, paddingLeft: 28, margin: 0, lineHeight: 1.5 }}>{m.desc}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Standard services */}
            {STANDARD_SERVICES.map(s => (
              <ServiceCheck key={s} label={s} checked={services.has(s)} onClick={() => toggleService(s)} />
            ))}

            {/* Fence — full width */}
            <div style={{ gridColumn: 'span 2' }}>
              <ServiceCheck label="🪟 Fence" checked={fenceChecked} onClick={() => { setFenceChecked(f => !f); if (fenceChecked) setFenceType(''); }} />
              {fenceChecked && (
                <div style={{ marginTop: 8, border: `1.5px solid ${C.sky}`, borderRadius: 12, overflow: 'hidden' }}>
                  <div style={{ background: '#f0f7ff', padding: '8px 14px', fontSize: 12, color: C.sky, fontWeight: 600, borderBottom: `1px solid ${C.border}` }}>
                    What type of fence? <span style={req}>*</span>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', background: '#fff' }}>
                    {[['Wood fence', '🪵', 'Wood'], ['Plastic / vinyl fence', '🏗️', 'Plastic/Vinyl'], ['Metal fence', '⚙️', 'Metal']].map(([val, icon, lbText]) => (
                      <div key={val} onClick={() => setFenceType(val)} style={{
                        padding: '12px 8px', cursor: 'pointer', textAlign: 'center',
                        borderRight: val !== 'Metal fence' ? `1px solid ${C.border}` : 'none',
                        background: fenceType === val ? '#f0f7ff' : '#fff', transition: 'background .15s',
                      }}>
                        <div style={{ fontSize: 22, marginBottom: 6 }}>{icon}</div>
                        <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{lbText}</div>
                        <div style={{ width: 14, height: 14, borderRadius: '50%', border: `2px solid ${fenceType === val ? C.sky : C.border}`, margin: '6px auto 0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                          {fenceType === val && <div style={{ width: 6, height: 6, borderRadius: '50%', background: C.sky }} />}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Sealing — full width */}
            <div style={{ gridColumn: 'span 2', border: `1.5px solid ${C.gold}`, borderRadius: 12, overflow: 'hidden', background: '#fff8ed' }}>
              <div style={{ padding: '14px 16px' }}>
                <div style={{ fontWeight: 700, color: C.text, fontSize: 15, marginBottom: 6 }}>Interested in sealing?</div>
                <p style={{ fontSize: 13, color: C.muted, lineHeight: 1.6, marginBottom: 12 }}>
                  We quote sealing in person after we pressure clean. Tap below if you'd like us to take a look while we're there.
                </p>
                <button type="button" onClick={() => setSealChecked(s => !s)} style={{
                  width: '100%', padding: '11px', background: sealChecked ? C.green : C.rust,
                  color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700,
                  cursor: 'pointer', transition: 'background .2s', fontFamily: 'inherit',
                }}>
                  {sealChecked ? '✓ Selected — we\'ll discuss in person' : '✓ I\'m interested in sealing — quote in person'}
                </button>
              </div>
              {sealChecked && (
                <div style={{ borderTop: `1.5px solid ${C.gold}`, padding: '14px 16px', background: '#fff' }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#7a5c00', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>Which surface(s)?</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {['Driveway', 'Patio'].map(s => (
                      <ServiceCheck key={s} label={s} checked={sealSurfaces.has(s)} onClick={() => toggleSealSurface(s)} color={C.gold} />
                    ))}
                    <div style={{ gridColumn: 'span 2' }}>
                      <ServiceCheck label="Add paver joint sand quote" checked={sealSurfaces.has('Sand in joints')} onClick={() => toggleSealSurface('Sand in joints')} color={C.gold} />
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Rust removal — full width */}
            <div style={{ gridColumn: 'span 2' }}>
              <div onClick={() => { setRustChecked(r => !r); if (rustChecked) setRustArea(''); }}
                style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 13px', border: `1.5px solid ${rustChecked ? C.rust : '#f5c4a0'}`, borderRadius: 10, cursor: 'pointer', background: rustChecked ? '#fff5ed' : '#fafafa', transition: 'all .15s', userSelect: 'none' }}>
                <Cb checked={rustChecked} color={C.rust} />
                <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>🔴 Rust removal</span>
                <span style={{ fontSize: 11, color: C.muted, marginLeft: 'auto' }}>$25–$100 est.</span>
              </div>
              {rustChecked && (
                <div style={{ marginTop: 8, border: `1.5px solid ${C.rust}`, borderRadius: 12, overflow: 'hidden' }}>
                  <div style={{ background: '#fff5ed', padding: '8px 14px', fontSize: 12, color: C.rust, fontWeight: 600, borderBottom: '1px solid #f5c4a0' }}>
                    What surfaces need rust removal?
                  </div>
                  <div style={{ padding: 12, background: '#fff' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                      {[['Walls', '🧱'], ['Floors', '⬛'], ['Both', '🔄']].map(([area, icon]) => (
                        <div key={area} onClick={() => setRustArea(area)} style={{
                          padding: '12px 8px', border: `1.5px solid ${rustArea === area ? C.rust : C.border}`,
                          borderRadius: 10, cursor: 'pointer', textAlign: 'center',
                          background: rustArea === area ? '#fff5ed' : '#f9fafb', transition: 'all .15s',
                        }}>
                          <div style={{ fontSize: 22, marginBottom: 6 }}>{icon}</div>
                          <div style={{ fontSize: 12, fontWeight: 600, color: C.text }}>{area}</div>
                          <div style={{ width: 14, height: 14, borderRadius: '50%', border: `2px solid ${rustArea === area ? C.rust : C.border}`, margin: '6px auto 0', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                            {rustArea === area && <div style={{ width: 6, height: 6, borderRadius: '50%', background: C.rust }} />}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Other services */}
          <div style={{ ...fieldWrap, marginTop: 8 }}>
            <label style={lbl}>Anything else not listed above?</label>
            <textarea style={{ ...inp, height: 64, resize: 'vertical' }} value={form.otherServices} onChange={e => setField('otherServices', e.target.value)} placeholder="e.g. walkways, pool deck, stepping stones…" />
          </div>

          {/* Remote quoting note */}
          <div style={{ background: '#f0f7ff', border: `1.5px solid ${C.sky}`, borderRadius: 12, padding: '12px 14px', marginBottom: '1.25rem', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ fontSize: 18, flexShrink: 0 }}>🛰️</span>
            <p style={{ fontSize: 13, color: C.blue, lineHeight: 1.6, margin: 0 }}>
              <strong>How we quote remotely</strong> — We use property appraiser records for Broward, Miami-Dade, and Palm Beach counties along with satellite imagery to accurately measure your property.
            </p>
          </div>

          {/* Week selection */}
          <div id="qfe-week-section">
            <div style={{ ...sectionLbl, display: 'flex', alignItems: 'center', gap: 8 }}>
              When would you like service?
              <span style={{ fontSize: 10, fontWeight: 700, background: '#fee2e2', color: '#b91c1c', padding: '3px 8px', borderRadius: 20, letterSpacing: .5 }}>Required</span>
            </div>
            <p style={{ fontSize: 13, color: C.muted, marginBottom: 12, lineHeight: 1.6 }}>
              Choose a week — we'll confirm the exact day after reviewing your request.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
              {weekOpts.map(opt => {
                const blocked = opt.weekStart && blockedWeeks.some(bw => bw.weekStart === opt.weekStart);
                return (
                  <WeekCard
                    key={opt.value}
                    opt={opt}
                    selected={selectedWeek?.value === opt.value}
                    blocked={blocked}
                    onSelect={handleSelectWeek}
                    onWaitlist={handleWaitlistClick}
                  />
                );
              })}
            </div>
            {weekError && (
              <div style={{ fontSize: 13, color: '#e53e3e', fontWeight: 600, marginBottom: 10, padding: '8px 12px', background: '#fee2e2', borderRadius: 8 }}>
                Please choose a week so we can find a spot for you.
              </div>
            )}

            {/* Waitlist */}
            {waitlistFor && (
              <div style={{ background: '#f0f7ff', border: `1.5px solid ${C.sky}`, borderRadius: 12, padding: '14px 16px', marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: C.navy, marginBottom: 10 }}>
                  Get notified if {waitlistFor.label} opens up
                </div>
                {waitlistSent ? (
                  <p style={{ fontSize: 13, color: C.green, fontWeight: 600 }}>✓ Added — we'll reach out if a spot opens.</p>
                ) : (
                  <>
                    <input style={{ ...inp, marginBottom: 8 }} placeholder="Your name" value={waitlistForm.name} onChange={e => setWaitlistForm(f => ({ ...f, name: e.target.value }))} autoComplete="name" />
                    <input type="tel" style={{ ...inp, marginBottom: 8 }} placeholder="Phone number" value={waitlistForm.phone} onChange={e => setWaitlistForm(f => ({ ...f, phone: e.target.value }))} autoComplete="tel" />
                    <input type="email" style={{ ...inp, marginBottom: 10 }} placeholder="Email (optional)" value={waitlistForm.email} onChange={e => setWaitlistForm(f => ({ ...f, email: e.target.value }))} autoComplete="email" />
                    <button type="button" onClick={submitWaitlist} style={{ width: '100%', padding: 11, background: C.sky, color: '#fff', border: 'none', borderRadius: 10, fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                      Add me to the waitlist →
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          {/* Notes */}
          <div style={{ ...fieldWrap, marginTop: 8 }}>
            <label style={lbl}>Anything else we should know?</label>
            <textarea style={{ ...inp, height: 72, resize: 'vertical' }} value={form.notes} onChange={e => setField('notes', e.target.value)} placeholder="Gate code, special instructions…" />
          </div>

          {/* Submit */}
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            style={{
              width: '100%', padding: '16px', background: submitting ? '#6b7280' : C.navy,
              color: '#fff', border: 'none', borderRadius: 14,
              fontFamily: '"Bebas Neue", sans-serif', fontSize: 22, letterSpacing: 2,
              cursor: submitting ? 'not-allowed' : 'pointer', transition: 'all .2s', marginBottom: 16,
            }}
          >
            {submitting ? 'Sending…' : 'Send My Quote Request →'}
          </button>

          {/* Trust row */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: '1.5rem', flexWrap: 'wrap', marginBottom: 14 }}>
            {['Family owned since 1995', 'South Florida\'s best', 'Same-day response'].map(t => (
              <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: C.muted }}>
                <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.gold, flexShrink: 0, display: 'inline-block' }} />
                {t}
              </span>
            ))}
          </div>
          <p style={{ textAlign: 'center', fontSize: 13, color: C.muted }}>
            Questions? Call us at{' '}
            <a href="tel:9543892642" style={{ color: C.sky, fontWeight: 600, textDecoration: 'none' }}>954-389-2642</a>
          </p>
        </div>
      </div>
    </section>
  );
}
