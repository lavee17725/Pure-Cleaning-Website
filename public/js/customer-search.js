/* ONE customer search engine — the only implementation.
 *
 * 2026-08-04. Darla's mental model is a phone book: type any piece of what you
 * know, get everyone it could be. Recall beats precision here — five plausible
 * rows beat zero.
 *
 * THE LOAD-BEARING FIX: phones are compared DIGITS-ONLY on both sides. The old
 * code did `c.phone.includes(query)` against a raw query, so "786-229-7178"
 * could never match the stored "7862297178". Darla writes numbers with dashes,
 * so every punctuated search silently returned nothing.
 *
 * Fields searched: first, last, business name, alternate-contact names, email,
 * every phone (primary + alt + alternate contacts + numbers carried over from
 * merged records), full address, house number, street name, city, ZIP.
 *
 * Indexing is done ONCE at load (buildIndex) and reused per keystroke, so
 * typing stays instant on the full customer set.
 *
 * Guardrail: the directory AND the quote modal both call this. No second
 * implementation to drift.
 */
(function () {
  'use strict';

  // ── Normalizers ────────────────────────────────────────────────────────────
  function digits(s) { return String(s == null ? '' : s).replace(/\D/g, ''); }

  // US numbers are stored and typed inconsistently (+1 prefix, 11 digits, bare
  // 10). Compare on the last 10 so every form lines up.
  function phone10(s) {
    const d = digits(s);
    return d.length > 10 && d.startsWith('1') ? d.slice(1) : d;
  }

  const ADDR_DICT = {
    northwest: 'nw', northeast: 'ne', southwest: 'sw', southeast: 'se',
    north: 'n', south: 's', east: 'e', west: 'w',
    avenue: 'ave', street: 'st', drive: 'dr', road: 'rd', court: 'ct', circle: 'cir',
    boulevard: 'blvd', lane: 'ln', place: 'pl', terrace: 'ter', trail: 'trl',
    highway: 'hwy', parkway: 'pkwy',
  };
  // Unchanged behaviour from the July Todd Griffin fix — long forms map DOWN to
  // the short token, per-token, applied to BOTH query and stored address.
  function normAddr(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/\./g, '').replace(/,/g, ' ')
      .split(/\s+/).filter(Boolean)
      .map(t => ADDR_DICT[t] || t)
      .join(' ');
  }

  const NICKNAMES = {
    william: ['bill','billy','will','willy'], robert: ['bob','bobby','rob','robby'], charles: ['chuck'],
    richard: ['dick','rich','richie'], james: ['jim','jimmy'], joseph: ['joe','joey'], kenneth: ['ken','kenny'],
    michael: ['mike','mikey'], nicholas: ['nick','nicky'], patrick: ['pat'], ronald: ['ron','ronny'],
    samuel: ['sam','sammy'], samantha: ['sam','sammy'], steven: ['steve','stevie'], stephen: ['steve','stevie'],
    theodore: ['ted','teddy'], edward: ['ted','teddy'], thomas: ['tom','tommy'], anthony: ['tony'],
    vincent: ['vinny','vince'], christopher: ['chris'], christina: ['chris'], christian: ['chris'],
    catherine: ['cathy','kathy','kate','katie'], katherine: ['cathy','kathy','kate','katie'], deborah: ['debbie'],
    jennifer: ['jen','jenny'], elizabeth: ['liz','lizzy','beth'], margaret: ['maggie','meg','peggy'],
    megan: ['meg'], mary: ['molly'], sarah: ['sally'], susan: ['sue','susie'], susanna: ['sue','susie'],
    teresa: ['terry'], theresa: ['terry'],
  };
  function expandNicknames(word) {
    const n = String(word || '').toLowerCase().trim();
    const out = new Set([n]);
    (NICKNAMES[n] || []).forEach(v => out.add(v));
    // Reverse direction too: typing the formal name should find the nickname
    // spelling on the record ("Thomas" → a row stored as "Tommy").
    for (const formal in NICKNAMES) {
      if (NICKNAMES[formal].includes(n)) out.add(formal);
    }
    return [...out];
  }

  // ── Index (built once per data load) ───────────────────────────────────────
  function indexOne(c) {
    const names = [c.firstName, c.lastName, c.businessName].filter(Boolean).join(' ').toLowerCase().trim();

    const altNames = (Array.isArray(c.alternateContacts) ? c.alternateContacts : [])
      .map(a => (a && a.name) || '').filter(Boolean).join(' ').toLowerCase();

    // Every number this customer could be reached on, digits-only. altPhoneDigits
    // already carries legacy altPhone + alternateContacts + merged-record numbers.
    const phoneSet = new Set();
    [c.phone, c.altPhone].forEach(p => { const d = phone10(p); if (d) phoneSet.add(d); });
    digits(c.altPhoneDigits).length && String(c.altPhoneDigits).split(/\D+/).forEach(p => {
      const d = phone10(p); if (d) phoneSet.add(d);
    });
    (Array.isArray(c.alternateContacts) ? c.alternateContacts : []).forEach(a => {
      const d = phone10(a && a.phone); if (d) phoneSet.add(d);
    });
    const phones = [...phoneSet];

    const addr = normAddr(c.address);
    const addrTokens = addr.split(' ').filter(Boolean);
    // Numbers appearing in the address (house number, "85th" → 85, unit).
    const addrNums = (String(c.address || '').match(/\d+/g) || []);

    c._sx = {
      names,
      nameWords: names.split(/\s+/).filter(Boolean),
      altNames,
      phones,
      phoneBlob: phones.join(' '),
      email: String(c.email || '').toLowerCase(),
      addr,
      addrTokens,
      addrNums,
      city: String(c.city || '').toLowerCase(),
      zip: String(c.zip || '').toLowerCase(),
    };
    // Back-compat with the directory's existing render/sort code.
    c._name = names;
    c._normAddr = addr;
    c._normAddrTokens = addrTokens;
    return c;
  }

  function buildIndex(list) { (list || []).forEach(indexOne); return list; }

  // ── Scoring ────────────────────────────────────────────────────────────────
  function nameScore(q, sx) {
    const words = sx.nameWords;
    if (!q) return 0;
    if (sx.names.includes(q)) return 100;
    if (words.some(w => w.startsWith(q))) return 90;

    const qTok = q.split(/\s+/).filter(t => t.length > 1);

    let nick = 0;
    for (const qt of (qTok.length ? qTok : [q])) {
      for (const v of expandNicknames(qt)) {
        if (v === qt) continue;
        for (const w of words) {
          if (w === v) nick = Math.max(nick, 80);
          else if (w.startsWith(v)) nick = Math.max(nick, 60);
        }
      }
    }
    if (nick) return nick;

    if (qTok.length >= 2 && words.length) {
      const hits = qTok.filter(qt => words.some(w => w === qt || w.startsWith(qt) || qt.startsWith(w)));
      if (hits.length) return Math.max(45, Math.round(70 * hits.length / qTok.length));
    }

    // Per-word bigram typo tolerance with a first-letter anchor — keeps "Smyth"
    // matching "Smith" without letting "Smith" reach "Mitchell".
    if (q.length < 4) return 0;
    const qq = q.replace(/\s+/g, '');
    const qBi = new Set();
    for (let i = 0; i < qq.length - 1; i++) qBi.add(qq[i] + qq[i + 1]);
    if (!qBi.size) return 0;
    let best = 0;
    for (const w of words) {
      if (w.length < 3) continue;
      let shared = 0;
      for (const bg of qBi) if (w.includes(bg)) shared++;
      const overlap = shared / qBi.size;
      if (overlap >= 0.66 || (w[0] === qq[0] && overlap >= 0.50)) best = Math.max(best, Math.round(overlap * 60));
    }
    return best;
  }

  function addrScore(nq, nqTokens, sx) {
    if (!nq || !sx.addr) return 0;
    if (sx.addr.includes(nq)) return 95;
    const at = sx.addrTokens;
    outer:
    for (let i = 0; i + nqTokens.length <= at.length; i++) {
      for (let j = 0; j < nqTokens.length; j++) {
        const a = at[i + j], q = nqTokens[j];
        if (a !== q && !a.startsWith(q)) continue outer;
      }
      return 85;
    }
    return 0;
  }

  /**
   * Score one customer against a prepared query. 0 = no match.
   * A purely numeric query deliberately searches BOTH phone digits and address
   * numbers, so "915" surfaces a 915 house number AND anyone whose phone
   * contains 915 — both kinds together, per the phone-book model.
   */
  function score(c, p) {
    const sx = c._sx || indexOne(c)._sx;
    let best = 0;

    // Phone digits are searched when the query is PURELY numeric (she's typing a
    // number) — not when digits are merely part of a text query. "918 Hunting
    // Lodge Drive" is an address search; dragging in everyone whose phone
    // contains 918 is noise, and the house number is already covered below.
    if (p.digits && p.numericOnly) {
      for (const ph of sx.phones) {
        if (ph === p.digits) { best = Math.max(best, 100); break; }
        if (ph.includes(p.digits)) {
          // Trailing fragments (last-4) and area codes both count; a longer
          // fragment is a stronger signal.
          best = Math.max(best, p.digits.length >= 7 ? 96 : p.digits.length >= 4 ? 88 : 70);
        }
      }
    }

    // Address numbers are searched for ANY query containing digits, so a house
    // number works alone ("918") and inside a fuller address. An exact house
    // number outranks an incidental substring (918 beats 9180), and both
    // outrank a partial phone hit so a bare number surfaces the house first.
    if (p.digits) {
      for (const n of sx.addrNums) {
        if (n === p.digits) best = Math.max(best, 94);
        else if (n.includes(p.digits)) best = Math.max(best, 74);
      }
      if (sx.zip && sx.zip.includes(p.digits)) best = Math.max(best, 60);
    }

    if (p.text) {
      best = Math.max(best, nameScore(p.text, sx));
      best = Math.max(best, addrScore(p.nq, p.nqTokens, sx));
      if (sx.altNames.includes(p.text)) best = Math.max(best, 75);
      if (sx.email && sx.email.includes(p.text)) best = Math.max(best, 70);
      if (sx.city && sx.city.includes(p.text)) best = Math.max(best, 50);
    }
    return best;
  }

  // Prepare a query once per search, never per customer.
  function prepare(raw) {
    const q = String(raw == null ? '' : raw).trim().toLowerCase();
    const d = digits(q);
    // A query is "numeric" when it is digits + punctuation only. Mixed queries
    // ("918 hunting") keep their text path and still expose their digits.
    const numericOnly = !!q && /^[\d\s().+\-/]*$/.test(q) && !!d;
    const nq = normAddr(q);
    return {
      raw: q,
      digits: d.length ? (d.length > 10 && d.startsWith('1') ? d.slice(1) : d) : '',
      numericOnly,
      text: numericOnly ? '' : q,
      nq, nqTokens: nq.split(' ').filter(Boolean),
      empty: !q,
    };
  }

  /** Ranked search. Returns customers, best match first. */
  function search(list, raw) {
    const p = prepare(raw);
    if (p.empty) return (list || []).slice();
    const out = [];
    for (const c of (list || [])) {
      const s = score(c, p);
      if (s > 0) out.push({ c, s });
    }
    out.sort((a, b) => b.s - a.s || String(a.c._name || '').localeCompare(String(b.c._name || '')));
    return out.map(x => x.c);
  }

  window.CustomerSearch = { search, score, prepare, buildIndex, indexOne, digits, phone10, normAddr, expandNicknames };
})();
