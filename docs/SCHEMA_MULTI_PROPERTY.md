# Multi-Property Customer Schema — Phase 2 Design

**Status:** Deferred — designed 2026-05-13, not yet implemented  
**Trigger:** Christina Seeber (real estate agent, pays for cleaning at 3 Hollywood properties)  
**Current workaround:** Per-job address on jobHistory entries + dedup logic in getExtraCompletedJobsForRig  
**Scope of this change:** 152 references to scheduledStatus in calendar.html, 17 in customer_profile.html, 24 in worker index.js — multi-session project

---

## Problem

Current schema: ONE `scheduledStatus` per customer. Multi-property customers (realtors, property managers, investors) scheduling same-day jobs at different addresses collide. `getScheduledForRig()` returns only one card per customer per date, forcing extra cards to render as stripped-down "jobCardHistoryExtra" chips.

**Today's count:** 2 customers with alternate job addresses in DB (Kristina Seeber + Keith Wolf false-positive). Expected to grow as Tyler targets commercial/property-manager clients.

---

## New Schema

```javascript
customer = {
  // --- UNCHANGED ---
  phone: '9542493300',        // primary key — unchanged
  firstName: 'Kristina',
  lastName: 'Seeber',
  email, zip, notes, alerts, tags, tier, vip, optOut,
  totalJobs, lifetimeSpend, lastService,   // stale aggregates — getEffectiveStats() still canonical
  jobHistory: [...],          // per-job entries — add propertyId field (see below)
  quoteStatus, quoteLifecycle, quoteHistory,
  leadSource, source,
  paymentMethod, paymentInfo, receiptInfo,  // customer-level preferred method + last payment
  coordinates, geocoded,
  isReferralOnly, isTest,

  // --- NEW ---
  properties: [
    {
      id: 'prop_9542493300_a1b2',    // unique within customer — phone + random suffix
      address: '2419 Marathon Lane',
      city: 'Fort Lauderdale',
      zip: '33331',
      label: 'Home (billing)',        // optional friendly name
      isPrimary: true,                // exactly one per customer
      createdAt: '2026-01-01T...',
    },
    {
      id: 'prop_9542493300_c3d4',
      address: '5501 Monroe St',
      city: 'Hollywood',
      label: 'Managed property',
      isPrimary: false,
      createdAt: '2026-05-13T...',
    },
    {
      id: 'prop_9542493300_e5f6',
      address: '7000 Hope St',
      city: 'Hollywood',
      label: 'Managed property',
      isPrimary: false,
      createdAt: '2026-05-13T...',
    },
  ],

  // REPLACES scheduledStatus (singular) with scheduledStatuses (array)
  scheduledStatuses: [
    {
      propertyId: 'prop_9542493300_c3d4',  // links to a property
      state: 'completed',
      scheduledDate: '2026-05-05',
      rig: 'rig_2',
      approvedAmount: 300,
      completedDate: '2026-05-05',
      jobNotes: 'Rinse Walls / Patio / Driveway / Sidewalk / Entranceway',
      window: 'morning',
      crew: [],
      paymentInfo: { method: 'zelle', totalPaid: 300, paidAt: '...' },
      // ... all other existing scheduledStatus fields ...
    },
    {
      propertyId: 'prop_9542493300_e5f6',
      state: 'completed',
      scheduledDate: '2026-05-05',
      rig: 'rig_2',
      approvedAmount: 300,
      // ...
    },
  ],

  // jobHistory entries gain propertyId
  jobHistory: [
    {
      date: '2026-05-05',
      amount: 300,
      propertyId: 'prop_9542493300_c3d4',  // NEW
      address: '5501 Monroe St',            // kept for backwards compat / denormalized
      // ... all existing fields ...
    },
    {
      date: '2026-05-05',
      amount: 300,
      propertyId: 'prop_9542493300_e5f6',  // NEW
      address: '7000 Hope St',
      // ...
    },
  ],

  // DEPRECATED (kept for backwards compat during migration)
  // scheduledStatus: { ... }   ← read-only, not written by new code
  // customer.address            ← derived from primary property
  // customer.city               ← derived from primary property
};
```

---

## Migration Plan (1,239 customers)

**Script:** `scripts/migrate-multi-property.js` — idempotent (safe to re-run)

For each customer:

1. **Skip if already migrated** — check `c.properties && c.properties.length > 0`

2. **Create primary property** from `c.address / c.city / c.zip`:
   ```js
   { id: `prop_${phone}_${nanoid(6)}`, address: c.address, city: c.city, zip: c.zip,
     label: 'Primary', isPrimary: true, createdAt: c.customerSince || now }
   ```

3. **Scan jobHistory for alternate addresses** — build a map of unique job addresses that differ from primary:
   ```js
   const altAddrs = new Map(); // address → propertyId
   for (const j of c.jobHistory) {
     if (j.address && j.address !== c.address) {
       if (!altAddrs.has(j.address)) {
         altAddrs.set(j.address, `prop_${phone}_${nanoid(6)}`);
         properties.push({ id: altAddrs.get(j.address), address: j.address, city: j.city || c.city, isPrimary: false, ... });
       }
       j.propertyId = altAddrs.get(j.address);
     } else {
       j.propertyId = primaryPropId;
     }
   }
   ```

4. **Convert scheduledStatus → scheduledStatuses**:
   - If `c.scheduledStatus` exists: match to property by address, wrap in array
   - If no scheduledStatus: empty array

5. **Result for single-address customers (1,237 of 1,239):** 1 property, 0 or 1 scheduledStatuses entry, all jobHistory linked to primary propertyId.

6. **Result for Christina Seeber:** 3 properties, 2 scheduledStatuses entries (both May 5), jobHistory entries each linked to their respective Hollywood property.

---

## Backend Handler Changes (cloudflare-worker/src/index.js — 24 references)

New endpoints:
- `POST /customers/{phone}/property` — add property
- `PUT /customers/{phone}/property/{propertyId}` — edit property
- `DELETE /customers/{phone}/property/{propertyId}` — remove (blocks if jobHistory references it)

Modified endpoints:
- `GET /customers` — returns scheduledStatuses[] (singular still included for compat)
- `PUT /customers` — validates scheduledStatuses propertyIds reference existing properties
- `POST /payment/{phone}/log` — accepts optional `propertyId` param; writes to matching scheduledStatuses entry
- `GET /admin/day-route` — reads jobHistory.propertyId to join address for route segments

---

## Frontend Changes

### calendar.html (152 references — primary concern)

- `getScheduledForRig(date, rig)`: iterate `scheduledStatuses[]` instead of `scheduledStatus`; each entry renders as a full primary card via `jobCardScheduled`
- `getExtraCompletedJobsForRig`: simplified — only needed for genuine double-completion artifacts, not multi-property
- `jobCardScheduled`: reads `ss.propertyId`, looks up `properties.find(p => p.id === propertyId)` for address
- `openEditModal(phone, propertyId?)`: edit by propertyId, writes to correct scheduledStatuses entry
- `openPaymentModal(phone, propertyId?)`: payment by propertyId

### customer_profile.html (17 references)

- New "Properties" section showing all properties with per-property jobHistory
- Add/edit/remove property inline

### new_customer.html

- "+ Add another property" button below address field
- Multiple properties at intake

### incoming.html

- Schedule modal: if customer has multiple properties, show property picker
- Defaults to primary property if one property

---

## Implementation Estimate

| Phase | Effort | Risk |
|-------|--------|------|
| Migration script + dry-run | 2h | Low (non-destructive) |
| Worker handler updates | 3h | Medium |
| calendar.html (152 refs) | 6h | High — must ship atomically with worker |
| customer_profile.html | 2h | Medium |
| new_customer + incoming | 2h | Low |
| Verify-browser tests | 1h | Low |
| **Total** | **~16h** | **Plan for 2 focused sessions** |

**Recommended window:** Sunday morning 9 AM or dedicated weekday session. Do NOT start mid-week during active job days.

---

## Open Questions Before Implementation

1. Should `customer.address` and `customer.city` become derived getters (from primary property) or stay as denormalized copies?
2. What happens to `homeDistMi(c)` which uses `c.coordinates`? Coordinates should be per-property, not per-customer.
3. Bouncie GPS matching: currently matches by proximity to `c.address`. For multi-property customers, should it match against ALL properties and pick the closest?
4. The `BCPA` chip on job cards: currently uses `c.city/c.address`. Switch to property city/address.
5. ML features: `geocodedCoords` currently on customer. Should move to per-property.
