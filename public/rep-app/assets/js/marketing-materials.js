// Marketing materials catalog for the rep app's "Order Marketing Materials"
// flow.
//
// STRUCTURE: the taxonomy below is the merchandising tree supplied by Jack on
// 2026-09-03 -- Merchandise / Packaging / Point-of-Sales / Trade Support, with
// the deeper branches flattened into one accordion group per leaf-bearing
// node. `section` is the top-level bucket and `name` is the remaining path
// ("Apparel > Clothing > Men"), so the full classification is still visible on
// a phone without four levels of nested collapse.
//
// Empty branches are NOT listed. Six leaf-less nodes (Women, Footwear,
// Carried, Cold and Carry, Packaging, Off-Premise) previously rendered as
// "Coming soon" so the rep's tree matched the tree ops maintains; per Jack
// 2026-09-03 they are removed entirely -- a rep ordering materials should
// see only what can actually be ordered. Removing Packaging drops the
// Packaging section with it, since that was its only category. Re-adding
// any of them is just a category object with a non-empty `items`.
//
// SCOPE: this is a literal catalog -- only the leaves in that tree are
// orderable. 31 items previously listed here have no leaf in the new tree and
// are therefore not orderable from the rep app any more:
//   LM-008 Premium Business Cards      LM-040 Acrylic Holders
//   LM-009 QR Reorder Cards            LM-050 Frosted Handle Glass
//   LM-010 NFC Reorder Stickers        LM-052 Beer Towers
//   LM-011 Coolers                     LM-058 Pop-up Tent
//   LM-012 Tap Handle (redesign)       LM-059 Table Cloth
//   LM-020 Character Duo Stickers      LM-062 Women's Uniform
//   LM-021 Girl Stickers               LM-063 Dickies Jackets
//   LM-023 Shipping Box - Exterior     LM-064 Hats (Sunlight Groove)
//   LM-024 Shipping Box - Interior     LM-065 Hats (Leopard Mark)
//   LM-025 Packaging Tape              LM-067 Golden Bullion Crest Patch
//   LM-026 Custom Tissue Paper         LM-068 Premium Notepads
//   LM-027 Interior Product Cut-Out    LM-069 Premium Portfolios
//   LM-028 Hand Stamp                  LM-083 Coffee Mug (engraved)
//   LM-029 Blank Note Cards            LM-086 Enamel Pins
//   LM-031 Product Information Card
//   LM-037 Mirrors
//   LM-039 Triangle Tent Menus
// They still exist in the Master Tracker; they just have nowhere to hang here.
// Several have an obvious home if the tree is ever extended -- Coolers under
// Cold and Carry, and the four box/tape/tissue/insert rows under Packaging.
//
// BRANDS: brand assignments are NOT invented. Every carried-over leaf keeps
// the brand(s) the Master Tracker
// (docs.google.com/spreadsheets/d/1SCFBf5h9OUUqVGrwOJCy83PNxNkU7bRyHFrF7nm5CMM)
// already records for it, which is why some leaves have three brand rows, some
// have two, and the genuinely shared physical items (bar mats, blades, napkin
// holders, pitchers, stadium cups, lanyards, keychains, A-frames) stay a single
// Multi-Brand row instead of being split three ways.
//
// NEW IDS: six leaves in the tree have no tracker row yet. They are numbered
// LM-090 through LM-107 continuing the tracker's own sequence, and those
// numbers need reserving in the tracker so a future row can't collide:
//   LM-090..092 Dominoes Set        LM-099..101 Print, Standee
//   LM-093..095 Playing Cards       LM-102..104 Tin Tacker
//   LM-096..098 Medal               LM-105..107 Pennant String
//
// Deliberately NOT copied from the tracker: Status, Qty, Vendor, Priority.
// Those change constantly and the tracker owns them -- duplicating them into a
// bundled JS file would just guarantee the rep app shows stale availability.
// Reps see the full range and ops fields what isn't in stock yet.
//
// `id` is the tracker's row ID and is what gets written to the Marketing
// Orders tab, so a request always reconciles back to a tracker row.
// `sizes`, when present, means the item is ordered per size (one quantity line
// each) rather than as a single quantity.
(function () {
  var GARMENT = ['S', 'M', 'L', 'XL', '2XL'];

  var LM = 'Leopard Mark';
  var CN = 'Cantinesca';
  var SG = 'Sunlight Groove';
  var MB = 'Multi-Brand';

  window.LM_MARKETING_CATEGORIES = [
    // ---- Merchandise ------------------------------------------------------
    {
      id: 'promotional-products',
      section: 'Merchandise',
      name: 'Promotional Products',
      blurb: 'Hand-outs and giveaways.',
      items: [
        { id: 'LM-070', name: 'Pens', brand: LM },
        { id: 'LM-071', name: 'Pens', brand: CN },
        { id: 'LM-072', name: 'Pens', brand: SG },
        { id: 'LM-089', name: 'Token', brand: MB, note: 'Custom coin' },
        { id: 'LM-087', name: 'Keychains', brand: MB },
        { id: 'LM-096', name: 'Medal', brand: LM },
        { id: 'LM-097', name: 'Medal', brand: CN },
        { id: 'LM-098', name: 'Medal', brand: SG }
      ]
    },
    {
      id: 'toys-and-games',
      section: 'Merchandise',
      name: 'Toys and Games',
      blurb: 'Bar games and table play.',
      items: [
        { id: 'LM-090', name: 'Dominoes Set', brand: LM },
        { id: 'LM-091', name: 'Dominoes Set', brand: CN },
        { id: 'LM-092', name: 'Dominoes Set', brand: SG },
        { id: 'LM-093', name: 'Playing Cards, Poker', brand: LM },
        { id: 'LM-094', name: 'Playing Cards, Poker', brand: CN },
        { id: 'LM-095', name: 'Playing Cards, Poker', brand: SG }
      ]
    },
    {
      id: 'apparel-clothing-men',
      section: 'Merchandise',
      name: 'Apparel › Clothing › Men',
      blurb: "Men's cut. Ordered by size.",
      items: [
        { id: 'LM-066', name: 'Polo, Color', brand: CN, sizes: GARMENT },
        { id: 'LM-075', name: 'Sweater, Quarter Zip', brand: LM, sizes: GARMENT },
        { id: 'LM-078', name: 'Sweater, Quarter Zip', brand: CN, sizes: GARMENT },
        { id: 'LM-081', name: 'Sweater, Quarter Zip', brand: SG, sizes: GARMENT }
      ]
    },
    {
      id: 'apparel-clothing-unisex',
      section: 'Merchandise',
      name: 'Apparel › Clothing › Unisex',
      blurb: 'Unisex cut. Ordered by size.',
      items: [
        { id: 'LM-076', name: 'T-Shirt, Graphic', brand: LM, sizes: GARMENT },
        { id: 'LM-079', name: 'T-Shirt, Graphic', brand: CN, sizes: GARMENT },
        { id: 'LM-082', name: 'T-Shirt, Graphic', brand: SG, sizes: GARMENT },
        { id: 'LM-074', name: 'Sweatshirt, Hoodie', brand: LM, sizes: GARMENT },
        { id: 'LM-077', name: 'Sweatshirt, Hoodie', brand: CN, sizes: GARMENT },
        { id: 'LM-080', name: 'Sweatshirt, Hoodie', brand: SG, sizes: GARMENT }
      ]
    },
    {
      id: 'apparel-accessories-worn',
      section: 'Merchandise',
      name: 'Apparel › Accessories › Worn',
      blurb: 'Worn on the body.',
      items: [
        { id: 'LM-088', name: 'Lanyards', brand: MB }
      ]
    },
    {
      id: 'barware',
      section: 'Merchandise',
      name: 'Barware',
      blurb: 'Behind-the-bar placement items.',
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
      blurb: 'Glassware and cups for service.',
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
      blurb: 'Stickers and labels to hand out on account visits.',
      items: [
        { id: 'LM-017', name: 'Adhesive Label, Sticker, Circle', brand: CN },
        { id: 'LM-019', name: 'Adhesive Label, Sticker, Logo', brand: LM, note: 'Shield' },
        { id: 'LM-016', name: 'Adhesive Label, Sticker, Logo', brand: CN },
        { id: 'LM-022', name: 'Adhesive Label, Sticker, Logo', brand: SG },
        { id: 'LM-018', name: 'Adhesive Label, Roll Label', brand: CN }
      ]
    },

    // ---- Point-of-Sales ---------------------------------------------------
    {
      id: 'pos-indistinct',
      section: 'Point-of-Sales',
      name: 'Indistinct',
      blurb: 'Works on- or off-premise.',
      items: [
        { id: 'LM-032', name: 'Print, Poster (11x17)', brand: MB },
        { id: 'LM-006', name: 'Print, Poster (11x17)', brand: CN },
        { id: 'LM-007', name: 'Print, Poster (11x17)', brand: SG },
        { id: 'LM-099', name: 'Print, Standee', brand: LM },
        { id: 'LM-100', name: 'Print, Standee', brand: CN },
        { id: 'LM-101', name: 'Print, Standee', brand: SG }
      ]
    },
    {
      id: 'pos-onpremise-environmental',
      section: 'Point-of-Sales',
      name: 'On-Premise › Environmental',
      blurb: 'Walls, windows and bar tops.',
      items: [
        { id: 'LM-036', name: 'Neon Sign', brand: CN },
        { id: 'LM-035', name: 'Neon Sign', brand: SG },
        { id: 'LM-102', name: 'Tin Tacker', brand: LM },
        { id: 'LM-103', name: 'Tin Tacker', brand: CN },
        { id: 'LM-104', name: 'Tin Tacker', brand: SG },
        { id: 'LM-038', name: 'Blackboard A-Frames', brand: MB },
        { id: 'LM-105', name: 'Pennant String', brand: LM },
        { id: 'LM-106', name: 'Pennant String', brand: CN },
        { id: 'LM-107', name: 'Pennant String', brand: SG },
        { id: 'LM-033', name: 'Print, Table Tents (4x6)', brand: CN },
        { id: 'LM-034', name: 'Print, Table Tents (4x6)', brand: SG }
      ]
    },
    {
      id: 'pos-onpremise-equipment',
      section: 'Point-of-Sales',
      name: 'On-Premise › Equipment',
      blurb: 'Patio and outdoor fixtures.',
      items: [
        { id: 'LM-085', name: 'Patio Umbrellas', brand: CN }
      ]
    },

    // ---- Trade Support ----------------------------------------------------
    {
      id: 'trade-support',
      section: 'Trade Support',
      name: 'Trade Support',
      blurb: 'Leave-behinds for buyer meetings.',
      items: [
        { id: 'LM-004', name: 'Sales Sheet', brand: CN },
        { id: 'LM-005', name: 'Sales Sheet', brand: SG }
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
