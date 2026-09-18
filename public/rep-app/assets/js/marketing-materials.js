// Marketing materials catalog for the rep app's "Order Marketing Materials"
// flow.
//
// SCOPE: three categories -- Barware, Drinkware, Ephemera and Paper -- per
// Jack 2026-09-03. This replaces the four-bucket merchandising tree
// (Merchandise / Packaging / Point-of-Sales / Trade Support) that was
// supplied earlier the same day: reps order the same handful of things, and
// an 18-group accordion made them hunt for it. Everything below is a single
// `section` ("Merchandise") so the catalog renders as one flat run of three
// groups rather than a tree.
//
// Posters (LM-032 / LM-006 / LM-007) moved here from Point-of-Sales >
// Indistinct rather than being recreated -- same tracker rows, same brands,
// new home under Ephemera and Paper.
//
// NOT ORDERABLE FROM THE REP APP any more, having lost their category:
//   Promotional Products  Pens, Token, Keychains, Medal
//   Toys and Games        Dominoes Set, Playing Cards
//   Apparel               Polo, Sweater, T-Shirt, Sweatshirt, Lanyards
//   Point-of-Sales        Print Standee, Neon Sign, Tin Tacker, A-Frames,
//                         Pennant String, Table Tents, Patio Umbrellas
//   Trade Support         Sales Sheet
// Every one still exists in the Master Tracker
// (docs.google.com/spreadsheets/d/1SCFBf5h9OUUqVGrwOJCy83PNxNkU7bRyHFrF7nm5CMM)
// and ops can still order them -- they just have nowhere to hang here.
// Restoring any of them is a category object with a non-empty `items`.
//
// BRANDS: brand assignments are NOT invented. Every leaf keeps the brand(s)
// the Master Tracker already records for it, which is why the genuinely
// shared physical items (bar mats, blades, napkin holders, pitchers, stadium
// cups) stay a single Multi-Brand row instead of being split three ways.
//
// NEW IDS: LM-108..110 (Print, Infographic) have no tracker row yet. They
// continue the tracker's own sequence past LM-107 and follow how Print,
// Standee was numbered -- one row per brand. THESE NUMBERS NEED RESERVING IN
// THE TRACKER so a future row can't collide with them, and the artwork
// itself does not exist yet: the leaf is orderable here before ops has
// something to fulfil it with.
//
// Deliberately NOT copied from the tracker: Status, Qty, Vendor, Priority.
// Those change constantly and the tracker owns them -- duplicating them into
// a bundled JS file would just guarantee the rep app shows stale
// availability. Reps see the full range and ops fields what isn't in stock.
//
// `id` is the tracker's row ID and is what gets written to the Marketing
// Orders tab, so a request always reconciles back to a tracker row.
// `sizes`, when present, means the item is ordered per size (one quantity
// line each) rather than as a single quantity. Nothing in the current three
// categories is size-ordered -- the renderer still supports it, and the
// apparel that used it can come back without a code change.
(function () {
  var LM = 'Leopard Mark';
  var CN = 'Cantinesca';
  var SG = 'Sunlight Groove';
  var MB = 'Multi-Brand';

  window.LM_MARKETING_CATEGORIES = [
    {
      id: 'barware',
      section: 'Merchandise',
      name: 'Barware',
      blurb: 'Behind-the-bar service kit.',
      items: [
        { id: 'LM-054', name: 'Ice Buckets', brand: CN },
        { id: 'LM-015', name: 'Keg Jacket', brand: LM },
        { id: 'LM-013', name: 'Keg Jacket', brand: CN },
        { id: 'LM-014', name: 'Keg Jacket', brand: SG },
        { id: 'LM-043', name: 'Napkin Holder', brand: MB },
        { id: 'LM-051', name: 'Pitcher, Plastic (4 Pint)', brand: MB },
        { id: 'LM-042', name: 'Bar Blades', brand: MB },
        { id: 'LM-041', name: 'Bar Mats', brand: MB },
        { id: 'LM-044', name: 'Coasters', brand: CN },
        { id: 'LM-045', name: 'Coasters', brand: SG }
      ]
    },
    {
      id: 'drinkware',
      section: 'Merchandise',
      name: 'Drinkware',
      blurb: 'Glassware and cups.',
      items: [
        { id: 'LM-047', name: 'Glass, Pint', brand: CN },
        { id: 'LM-046', name: 'Glass, Pint', brand: SG },
        { id: 'LM-049', name: 'Glass, Premium Branded', brand: CN },
        { id: 'LM-048', name: 'Glass, Premium Branded', brand: SG },
        { id: 'LM-053', name: 'Cup, Disposable', brand: MB, note: 'Plastic stadium cup' }
      ]
    },
    {
      id: 'ephemera-and-paper',
      section: 'Merchandise',
      name: 'Ephemera and Paper',
      blurb: 'Stickers, posters and printed collateral.',
      items: [
        { id: 'LM-017', name: 'Adhesive Label, Sticker, Circle', brand: CN },
        { id: 'LM-019', name: 'Adhesive Label, Sticker, Logo', brand: LM, note: 'Shield' },
        { id: 'LM-016', name: 'Adhesive Label, Sticker, Logo', brand: CN },
        { id: 'LM-022', name: 'Adhesive Label, Sticker, Logo', brand: SG },
        { id: 'LM-018', name: 'Adhesive Label, Roll Label', brand: CN },
        { id: 'LM-032', name: 'Print, Poster (11x17)', brand: MB },
        { id: 'LM-006', name: 'Print, Poster (11x17)', brand: CN },
        { id: 'LM-007', name: 'Print, Poster (11x17)', brand: SG },
        { id: 'LM-108', name: 'Print, Infographic', brand: LM },
        { id: 'LM-109', name: 'Print, Infographic', brand: CN },
        { id: 'LM-110', name: 'Print, Infographic', brand: SG }
      ]
    }
  ];

  // Mirrors the tracker's Activity Type dropdown so a request's purpose
  // reconciles against the same vocabulary the marketing calendar uses,
  // plus the two reasons a rep orders that aren't campaign activities.
  window.LM_MARKETING_PURPOSES = [
    'Account Visit',
    'Launch',
    'Sampling',
    'Festival',
    'Giveaway',
    'Promo',
    'Sponsorship',
    'Content Drop',
    'Photo/Video Shoot',
    'Rep Field Kit / Restock',
    'Other'
  ];

  window.LM_MARKETING_BRANDS = [LM, CN, SG, MB];
})();
