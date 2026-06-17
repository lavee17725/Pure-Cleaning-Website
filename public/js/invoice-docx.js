// Invoice → .docx export — client-side, lazy-loaded.
//
// Why client-side: the structured `docx` UMD bundle is ~330 KB minified. Loading
// it on the worker would either bloat the bundle (we don't want to pay that on
// every other route's cold start) or require a sub-module split that isn't
// worth it for a single export route. Client-side, the library is fetched the
// first time the operator clicks "Download as Word" and then cached by the
// browser for the rest of the session. Zero cost when not exporting.
//
// The structured `docx` library (NOT html-docx-js) produces real paragraphs +
// tables. Line items become an editable Word table — Darla can change a row
// without fighting HTML wrappers. That's the whole reason for this export.
//
// Surface: pure_cleaning_invoice_admin.html and the calendar invoice-link modal
// both call window.PCPC_InvoiceDocx.download(invoice) once this file is loaded.

(() => {
  // docx@8.5.0 ships a real UMD build (368 KB minified). v9.x went pure ESM
  // with no UMD — would require <script type="module"> + import maps which
  // doesn't degrade gracefully on older browsers. v8.5.0's API is identical
  // for everything we use (Document, Paragraph, Table, ImageRun, Packer).
  const DOCX_CDN = 'https://cdn.jsdelivr.net/npm/docx@8.5.0/build/index.umd.min.js';
  const LOGO_URL = '/images/logo-pure-cleaning.png';

  let _docxPromise = null;  // cache so successive clicks don't re-load
  let _logoPromise = null;  // cache logo bytes

  // Lazy script loader — resolves with window.docx once the UMD bundle is in.
  function _loadDocx() {
    if (_docxPromise) return _docxPromise;
    _docxPromise = new Promise((resolve, reject) => {
      if (window.docx) return resolve(window.docx);
      const s = document.createElement('script');
      s.src   = DOCX_CDN;
      s.async = true;
      s.crossOrigin = 'anonymous';
      s.onload  = () => window.docx ? resolve(window.docx) : reject(new Error('docx library loaded but window.docx undefined'));
      s.onerror = () => reject(new Error('failed to load docx library from CDN'));
      document.head.appendChild(s);
    }).catch(e => { _docxPromise = null; throw e; });   // allow retry on next click
    return _docxPromise;
  }

  // Fetch the letterhead logo as an ArrayBuffer for ImageRun.
  function _loadLogo() {
    if (_logoPromise) return _logoPromise;
    _logoPromise = fetch(LOGO_URL)
      .then(r => { if (!r.ok) throw new Error('logo HTTP ' + r.status); return r.arrayBuffer(); })
      .catch(e => { _logoPromise = null; throw e; });
    return _logoPromise;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  const COLORS = {
    navy:  '0a1628',
    gold:  'f4a620',
    muted: '6b7280',
    text:  '1a1f2e',
    rule:  'cbd5e1',
  };

  function _money(n) {
    return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _fmtDate(s) {
    if (!s) return '';
    const d = new Date(s.length === 10 ? s + 'T12:00:00' : s);
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }

  function _safeFilenamePart(s) {
    return String(s || '').replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 40) || 'unknown';
  }

  // ── Document builder ───────────────────────────────────────────────────────
  // Lays out: letterhead (logo + biz block) → INVOICE title + number + status
  // → bill-to / service address two-column table → invoice meta row → line
  // items table (editable) → totals box → paid-stamp or balance-due banner →
  // notes block (if any) → payment methods + terms footer.
  //
  // All in a single section with margins 0.4" matching the print rule (Rule 23).
  function _buildDocument(inv, logoBytes, d) {
    const {
      AlignmentType, BorderStyle, Document, Footer, HeadingLevel, ImageRun,
      Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType,
      VerticalAlign, HeightRule,
    } = d;

    const _para = (children, opts = {}) =>
      new Paragraph({ children, alignment: opts.alignment, spacing: opts.spacing, alignment: opts.alignment });

    const _run = (text, opts = {}) =>
      new TextRun({ text: text == null ? '' : String(text), bold: !!opts.bold, color: opts.color, size: opts.size, font: 'Calibri' });

    const _label = (text) => _run(text, { bold: true, color: COLORS.muted, size: 22 });
    const _value = (text, opts = {}) => _run(text, { color: COLORS.text, size: opts.size || 26, bold: opts.bold });

    // Letterhead: a 2-column table with logo on left, business meta right-aligned.
    // Table is the most reliable way to align an image + text horizontally in Word.
    // Sizing rescaled UP 2026-06-17 (R2-3) — round 1 was too tight; this version
    // fills a full letter-size page while still holding one page (Rule 23).
    const letterhead = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top:    { style: BorderStyle.NONE,   size: 0, color: 'FFFFFF' },
        bottom: { style: BorderStyle.SINGLE, size: 8, color: COLORS.navy },
        left:   { style: BorderStyle.NONE,   size: 0, color: 'FFFFFF' },
        right:  { style: BorderStyle.NONE,   size: 0, color: 'FFFFFF' },
        insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        insideVertical:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 30, type: WidthType.PERCENTAGE },
              verticalAlign: VerticalAlign.CENTER,
              children: [
                new Paragraph({
                  children: logoBytes ? [
                    new ImageRun({ data: logoBytes, transformation: { width: 200, height: 134 } }),
                  ] : [_run('PURE CLEANING', { bold: true, size: 44, color: COLORS.navy })],
                }),
              ],
            }),
            new TableCell({
              width: { size: 70, type: WidthType.PERCENTAGE },
              verticalAlign: VerticalAlign.CENTER,
              children: [
                _para([_run('PURE CLEANING PRESSURE CLEANING, LLC', { bold: true, size: 36, color: COLORS.navy })], { alignment: AlignmentType.RIGHT }),
                _para([_run('Family-owned · South Florida · Since 1995', { size: 24, color: COLORS.muted })], { alignment: AlignmentType.RIGHT }),
                _para([_run('954-389-2642 · pure_cleaning@live.com', { size: 24, color: COLORS.muted })], { alignment: AlignmentType.RIGHT }),
                _para([_run('purecleaningpressurecleaning.com', { size: 24, color: COLORS.muted })], { alignment: AlignmentType.RIGHT }),
              ],
            }),
          ],
        }),
      ],
    });

    // INVOICE title + number + status badge
    const _paid = inv.paidInFull;
    const _due  = Math.max(0, Number(inv.total || 0) - Number(inv.amountPaid || 0));
    const statusText = _paid ? 'PAID IN FULL' : `BALANCE DUE — ${_money(_due)}`;
    const statusColor = _paid ? '0d6940' : '92400e';

    const titleBlock = [
      new Paragraph({
        spacing: { before: 480, after: 160 },
        children: [
          _run('INVOICE', { bold: true, size: 64, color: COLORS.navy }),
          _run('     ', { size: 64 }),
          _run(inv.invoiceNumber || inv.invoiceId || '—', { bold: true, size: 36, color: COLORS.muted }),
        ],
      }),
      new Paragraph({
        spacing: { after: 480 },
        children: [_run(statusText, { bold: true, size: 32, color: statusColor })],
      }),
    ];

    // Bill-To + Service Address row (2-col table for clean alignment)
    const bt = inv.billTo || inv.customer || {};
    const sa = inv.serviceAddress || {};
    const _billLines = [];
    const _bizName = bt.companyName || bt.businessName;
    const _contact = bt.contactName || `${(bt.firstName||'') + ' ' + (bt.lastName||'')}`.trim();
    if (_bizName) {
      _billLines.push([_run(_bizName, { bold: true, size: 34, color: COLORS.navy })]);
      if (_contact && _contact !== _bizName) _billLines.push([_run('Attn: ' + _contact, { size: 28, color: COLORS.text })]);
    } else if (_contact) {
      _billLines.push([_run(_contact, { bold: true, size: 34, color: COLORS.navy })]);
    } else {
      _billLines.push([_run('Customer', { bold: true, size: 34, color: COLORS.navy })]);
    }
    if (bt.phone) _billLines.push([_run(bt.phone, { size: 26, color: COLORS.muted })]);
    if (bt.email) _billLines.push([_run(bt.email, { size: 26, color: COLORS.muted })]);

    const _saLines = [];
    if (sa.address) _saLines.push([_run(sa.address, { size: 28, color: COLORS.text })]);
    const _cityZip = [sa.city, sa.state || 'FL', sa.zip].filter(Boolean).join(' ');
    if (_cityZip) _saLines.push([_run(_cityZip, { size: 28, color: COLORS.text })]);
    if (!_saLines.length) _saLines.push([_run('Address on file', { size: 26, color: COLORS.muted })]);

    const addrTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top:    { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        left:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        right:  { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        insideVertical:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      },
      rows: [
        new TableRow({
          children: [
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              children: [
                new Paragraph({ children: [_label('BILL TO')], spacing: { after: 40 } }),
                ..._billLines.map(c => new Paragraph({ children: c })),
              ],
            }),
            new TableCell({
              width: { size: 50, type: WidthType.PERCENTAGE },
              children: [
                new Paragraph({ children: [_label('SERVICE ADDRESS')], spacing: { after: 40 } }),
                ..._saLines.map(c => new Paragraph({ children: c })),
              ],
            }),
          ],
        }),
      ],
    });

    // Invoice meta row: Invoice Date | Paid On | Method | Due Date — only show
    // what's set, two columns each so it stays compact.
    const metaCells = [];
    metaCells.push({ label: 'INVOICE DATE', value: _fmtDate(inv.invoiceDate) });
    if (inv.paidAt)        metaCells.push({ label: 'PAID ON',  value: _fmtDate(inv.paidAt) });
    if (inv.paymentMethod) metaCells.push({ label: 'METHOD',   value: String(inv.paymentMethod).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) });
    if (!inv.paidAt && inv.dueDate) metaCells.push({ label: 'DUE DATE', value: _fmtDate(inv.dueDate) });

    const metaRow = new Paragraph({
      spacing: { before: 480, after: 480 },
      children: metaCells.flatMap((c, i) => [
        ...(i > 0 ? [_run('     ', { size: 22 })] : []),
        _run(c.label + ': ', { bold: true, size: 22, color: COLORS.muted }),
        _run(c.value, { size: 26, color: COLORS.text }),
      ]),
    });

    // Line items table — the editable surface. Description / Qty / Unit /
    // Unit Price / Line Total. Header row uses navy bg + gold text to match
    // brand. Per-row cells are plain so Darla can click in and edit.
    const headerCell = (text, opts = {}) => new TableCell({
      shading: { type: ShadingType.CLEAR, fill: COLORS.navy, color: 'auto' },
      children: [new Paragraph({
        alignment: opts.alignment || AlignmentType.LEFT,
        spacing: { before: 120, after: 120 },
        children: [_run(text, { bold: true, size: 26, color: 'ffffff' })],
      })],
      width: { size: opts.width, type: WidthType.PERCENTAGE },
    });
    const bodyCell = (children, opts = {}) => new TableCell({
      children: Array.isArray(children) ? children : [new Paragraph({
        alignment: opts.alignment || AlignmentType.LEFT,
        spacing: { before: 140, after: 140 },
        children: [_value(children, { size: 26 })],
      })],
      width: { size: opts.width, type: WidthType.PERCENTAGE },
      verticalAlign: VerticalAlign.CENTER,
    });

    const lineItems = inv.lineItems || [];
    const itemRows = lineItems.length
      ? lineItems.map(li => new TableRow({
          children: [
            bodyCell(li.description || 'Service',                          { width: 50 }),
            bodyCell(String(li.quantity ?? 1),                              { width: 10, alignment: AlignmentType.CENTER }),
            bodyCell(li.unit || '',                                         { width: 12, alignment: AlignmentType.CENTER }),
            bodyCell(_money(li.unitPrice),                                  { width: 14, alignment: AlignmentType.RIGHT }),
            bodyCell(_money(li.lineTotal),                                  { width: 14, alignment: AlignmentType.RIGHT }),
          ],
        }))
      : [new TableRow({
          children: [
            bodyCell('No line items.',          { width: 50 }),
            bodyCell('',                        { width: 10 }),
            bodyCell('',                        { width: 12 }),
            bodyCell('',                        { width: 14 }),
            bodyCell('',                        { width: 14 }),
          ],
        })];

    const itemsTable = new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top:    { style: BorderStyle.SINGLE, size: 4, color: COLORS.rule },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.rule },
        left:   { style: BorderStyle.SINGLE, size: 4, color: COLORS.rule },
        right:  { style: BorderStyle.SINGLE, size: 4, color: COLORS.rule },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: COLORS.rule },
        insideVertical:   { style: BorderStyle.SINGLE, size: 4, color: COLORS.rule },
      },
      rows: [
        new TableRow({
          tableHeader: true,
          children: [
            headerCell('Description', { width: 50 }),
            headerCell('Qty',         { width: 10, alignment: AlignmentType.CENTER }),
            headerCell('Unit',        { width: 12, alignment: AlignmentType.CENTER }),
            headerCell('Unit Price',  { width: 14, alignment: AlignmentType.RIGHT }),
            headerCell('Line Total',  { width: 14, alignment: AlignmentType.RIGHT }),
          ],
        }),
        ...itemRows,
      ],
    });

    // Totals box — right-aligned, 3 rows max (subtotal, discount, total). When
    // paid, also add Amount Paid + Status rows for clarity.
    const subtotal = Number(inv.subtotal || 0);
    const disc     = Number(inv.discountAmt || 0);
    const total    = Number(inv.total || 0);

    const _totalsRows = [];
    _totalsRows.push(['Subtotal', _money(subtotal), false]);
    if (disc > 0) _totalsRows.push(['Discount', '-' + _money(disc), false]);
    _totalsRows.push(['Total', _money(total), true]);
    if (_paid) {
      _totalsRows.push(['Amount Paid', _money(inv.amountPaid || total), false]);
      _totalsRows.push(['Status', '✓ Paid in Full', false]);
    }

    const totalsTable = new Table({
      width: { size: 50, type: WidthType.PERCENTAGE },
      alignment: AlignmentType.RIGHT,
      borders: {
        top:    { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        left:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        right:  { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        insideHorizontal: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
        insideVertical:   { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
      },
      rows: _totalsRows.map(([label, value, isGrand]) => new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({
              alignment: AlignmentType.RIGHT,
              spacing: { before: 120, after: 120 },
              children: [_run(label, { bold: isGrand, size: isGrand ? 34 : 26, color: isGrand ? COLORS.navy : COLORS.muted })],
            })],
          }),
          new TableCell({
            children: [new Paragraph({
              alignment: AlignmentType.RIGHT,
              spacing: { before: 120, after: 120 },
              children: [_run(value, { bold: isGrand, size: isGrand ? 44 : 26, color: isGrand ? COLORS.navy : COLORS.text })],
            })],
          }),
        ],
      })),
    });

    // BODY EXTRAS — subject / intro / notes stay in the body flow (these are
    // customer-visible message content, not footer chrome). Live between the
    // totals table and the bottom of the page.
    const bodyExtras = [];
    if (inv.subject) {
      bodyExtras.push(new Paragraph({
        spacing: { before: 480 },
        children: [_run('Subject: ', { bold: true, size: 24, color: COLORS.muted }), _run(inv.subject, { size: 26, color: COLORS.text })],
      }));
    }
    if (inv.introText) {
      bodyExtras.push(new Paragraph({
        spacing: { before: 200 },
        children: [_run(inv.introText, { size: 26, color: COLORS.text })],
      }));
    }
    if (inv.notes) {
      bodyExtras.push(new Paragraph({
        spacing: { before: 320 },
        children: [_run('Notes:  ', { bold: true, size: 22, color: COLORS.muted }), _run(inv.notes, { size: 26, color: COLORS.text })],
      }));
    }

    // PAGE FOOTER — payment methods + terms + brand footer line. Lives in the
    // Section.footers slot so Word pins it to the bottom of the page regardless
    // of how short or long the body content is. That's what makes the layout
    // "fill the page": body floats from the top, footer anchors at the bottom,
    // empty space distributes between (R2-2/R2-3 round 3, 2026-06-17).
    const pageFooterChildren = [
      new Paragraph({
        children: [
          _run('Payment methods accepted: ', { bold: true, size: 22, color: COLORS.muted }),
          _run('Zelle · Check · Cash · Venmo', { size: 26, color: COLORS.text }),
        ],
      }),
    ];
    if (inv.paymentTerms && !_paid) {
      pageFooterChildren.push(new Paragraph({
        spacing: { before: 120 },
        children: [_run('Payment terms:  ', { bold: true, size: 22, color: COLORS.muted }), _run(inv.paymentTerms, { size: 26, color: COLORS.text })],
      }));
    }
    pageFooterChildren.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 240 },
      children: [_run(
        'Pure Cleaning Pressure Cleaning, LLC  ·  Licensed & Insured  ·  954-389-2642  ·  pure_cleaning@live.com',
        { size: 18, color: '888888' },
      )],
    }));

    return new Document({
      creator: 'Pure Cleaning Pressure Cleaning',
      title:   `Invoice ${inv.invoiceNumber || inv.invoiceId || ''}`.trim(),
      styles: {
        default: {
          document: {
            run: { font: 'Calibri', size: 26 },
          },
        },
      },
      sections: [{
        properties: {
          page: {
            // US letter, 0.4" margins (576 twips). Matches the on-screen
            // print rule (Rule 23 / Tyler's standing one-page mandate).
            margin: { top: 576, right: 576, bottom: 576, left: 576 },
          },
        },
        footers: {
          default: new Footer({ children: pageFooterChildren }),
        },
        children: [
          letterhead,
          ...titleBlock,
          addrTable,
          metaRow,
          itemsTable,
          new Paragraph({ spacing: { before: 240 }, children: [_run('', { size: 8 })] }),
          totalsTable,
          ...bodyExtras,
        ],
      }],
    });
  }

  function _triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  // Public API. Returns a Promise so callers can await + show progress UI.
  async function downloadInvoiceDocx(invoice) {
    if (!invoice || !invoice.invoiceId) throw new Error('invoice object required');
    // Parallel load: docx library + logo bytes.
    const [d, logoBytes] = await Promise.all([
      _loadDocx(),
      _loadLogo().catch(() => null),     // logo is optional — fall back to text-only header
    ]);
    const doc = _buildDocument(invoice, logoBytes, d);
    const blob = await d.Packer.toBlob(doc);

    // Filename: Invoice-{customerLast}-{invoiceId}.docx
    const last = invoice.customer?.lastName
              || invoice.billTo?.contactName?.split(' ').slice(-1)[0]
              || 'Customer';
    const filename = `Invoice-${_safeFilenamePart(last)}-${_safeFilenamePart(invoice.invoiceId)}.docx`;
    _triggerDownload(blob, filename);
    return filename;
  }

  window.PCPC_InvoiceDocx = { download: downloadInvoiceDocx };
})();
