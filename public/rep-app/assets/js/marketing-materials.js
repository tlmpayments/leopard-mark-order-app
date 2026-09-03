// Marketing materials catalog for the rep app's "Order Marketing Materials"
// flow. Transcribed from the Project Tracker tab of "THE LEOPARD MARK |
// Marketing Materials & Merch Master Tracker"
// (docs.google.com/spreadsheets/d/1SCFBf5h9OUUqVGrwOJCy83PNxNkU7bRyHFrF7nm5CMM),
// which is the source of truth for IDs, brands and categories. The older
// standalone list (spreadsheet 1s_AEHL5PhB...) is a strict subset of it --
// every item on it maps onto an LM-### row here, so it isn't transcribed
// separately.
//
// 78 of the tracker's 83 rows appear below. The five that don't are the rows
// that aren't shippable objects, so a rep could never order them:
//   LM-001 The Leopard Mark Website        (Digital)
//   LM-002 Sunlight Groove Website         (Digital)
//   LM-003 Animated Logo & Brand Signature (Digital)
//   LM-060 Local Embroidery Partner        (tracker's own note: "Vendor
//                                           sourcing task, not a product")
//   LM-061 Shirt Mockups                   (a design deliverable, not stock)
// That empties the Digital category entirely, which is why it has no section.
//
// Deliberately NOT copied from the tracker: Status, Qty, Vendor, Priority.
// Those change constantly and the tracker owns them -- duplicating them into
// a bundled JS file would just guarantee the rep app shows stale availability.
// Reps see the full range and ops fields what isn't in stock yet.
//
// `id` is the tracker's row ID and is what gets written to the Marketing
// Orders tab, so a request always reconciles back to a tracker row.
// `sizes`, when present, means the item is ordered per size (one quantity
// line each) rather than as a single quantity.
(function () {
  var APPAREL = ['XS', 'S', 'M', 'L', 'XL', '2XL'];
  var GARMENT = ['S', 'M', 'L', 'XL', '2XL'];

  window.LM_MARKETING_CATEGORIES = [
    {
      id: 'freebies',
      name: 'Freebies',
      blurb: 'Stickers and labels to hand out on account visits.',
      items: [
        { id: 'LM-016', name: 'Logo Stickers', brand: 'Cantinesca' },
        { id: 'LM-017', name: 'Circle Stickers', brand: 'Cantinesca' },
        { id: 'LM-018', name: 'Circle Label', brand: 'Cantinesca' },
        { id: 'LM-019', name: 'Shield Stickers', brand: 'Leopard Mark' },
        { id: 'LM-020', name: 'Character Duo Stickers', brand: 'Sunlight Groove' },
        { id: 'LM-021', name: 'Girl Stickers', brand: 'Sunlight Groove' },
        { id: 'LM-022', name: 'Logo Stickers', brand: 'Sunlight Groove' }
      ]
    },
    {
      id: 'sales-materials',
      name: 'Sales Materials',
      blurb: 'Leave-behinds for buyer meetings and reorder prompts.',
      items: [
        { id: 'LM-004', name: 'Sales Sheets', brand: 'Cantinesca' },
        { id: 'LM-005', name: 'Sales Sheets', brand: 'Sunlight Groove' },
        { id: 'LM-006', name: 'Sales Posters (11x17)', brand: 'Cantinesca' },
        { id: 'LM-007', name: 'Sales Posters (11x17)', brand: 'Sunlight Groove' },
        { id: 'LM-008', name: 'Premium Business Cards', brand: 'Leopard Mark' },
        { id: 'LM-009', name: 'QR Reorder Cards (Square)', brand: 'Leopard Mark' },
        { id: 'LM-010', name: 'NFC Reorder Stickers', brand: 'Leopard Mark' }
      ]
    },
    {
      id: 'signage-display',
      name: 'Signage / Display',
      blurb: 'On-premise visibility: bar tops, walls and windows.',
      items: [
        { id: 'LM-032', name: 'Posters (11x17)', brand: 'Multi-Brand' },
        { id: 'LM-033', name: 'Table Tents (4x6)', brand: 'Cantinesca' },
        { id: 'LM-034', name: 'Table Tents (4x6)', brand: 'Sunlight Groove' },
        { id: 'LM-039', name: 'Triangle Tent Menus', brand: 'Multi-Brand' },
        { id: 'LM-040', name: 'Acrylic Holders', brand: 'Leopard Mark', note: 'POS / display' },
        { id: 'LM-038', name: 'Blackboard A-Frames', brand: 'Multi-Brand' },
        { id: 'LM-037', name: 'Mirrors', brand: 'Leopard Mark' },
        { id: 'LM-035', name: 'Neon Sign', brand: 'Sunlight Groove' },
        { id: 'LM-036', name: 'Neon Sign', brand: 'Cantinesca' }
      ]
    },
    {
      id: 'barware',
      name: 'Barware',
      blurb: 'Behind-the-bar placement items.',
      items: [
        { id: 'LM-044', name: 'Coasters', brand: 'Cantinesca' },
        { id: 'LM-045', name: 'Coasters', brand: 'Sunlight Groove' },
        { id: 'LM-041', name: 'Bar Mats', brand: 'Multi-Brand' },
        { id: 'LM-042', name: 'Bar Blades', brand: 'Multi-Brand' },
        { id: 'LM-043', name: 'Napkin Holders', brand: 'Multi-Brand' }
      ]
    },
    {
      id: 'drinkware',
      name: 'Drinkware',
      blurb: 'Glassware, pitchers and cups for service and events.',
      items: [
        { id: 'LM-047', name: 'Pint Glass', brand: 'Cantinesca' },
        { id: 'LM-046', name: 'Pint Glass', brand: 'Sunlight Groove' },
        { id: 'LM-049', name: 'Premium Branded Glass', brand: 'Cantinesca' },
        { id: 'LM-048', name: 'Premium Branded Glass', brand: 'Sunlight Groove' },
        { id: 'LM-050', name: 'Frosted Handle Glass', brand: 'Multi-Brand' },
        { id: 'LM-051', name: 'Plastic Pitchers (4 Pint)', brand: 'Multi-Brand' },
        { id: 'LM-052', name: 'Beer Towers', brand: 'Multi-Brand' },
        { id: 'LM-053', name: 'Plastic Stadium Cups', brand: 'Multi-Brand' }
      ]
    },
    {
      id: 'printed-collateral',
      name: 'Printed Collateral',
      blurb: 'Cards and inserts that travel with product.',
      items: [
        { id: 'LM-029', name: 'Blank Note Cards', brand: 'Leopard Mark' },
        { id: 'LM-031', name: 'Product Information Card', brand: 'Multi-Brand', note: 'Box insert' },
        { id: 'LM-028', name: 'Hand Stamp', brand: 'Leopard Mark' }
      ]
    },
    {
      id: 'accessories',
      name: 'Accessories',
      blurb: 'Desk and gifting items.',
      items: [
        { id: 'LM-067', name: 'Golden Bullion Crest Patch', brand: 'Leopard Mark' },
        { id: 'LM-070', name: 'Branded Pens', brand: 'Leopard Mark' },
        { id: 'LM-071', name: 'Branded Pens', brand: 'Cantinesca' },
        { id: 'LM-072', name: 'Branded Pens', brand: 'Sunlight Groove' },
        { id: 'LM-068', name: 'Premium Notepads', brand: 'Leopard Mark' },
        { id: 'LM-069', name: 'Premium Portfolios', brand: 'Leopard Mark' },
        { id: 'LM-054', name: 'Ice Buckets', brand: 'Cantinesca', note: 'Account gift' }
      ]
    },
    {
      id: 'apparel',
      name: 'Apparel',
      blurb: 'Team uniform pieces. Ordered by size.',
      items: [
        { id: 'LM-065', name: 'Hats', brand: 'Leopard Mark' },
        { id: 'LM-064', name: 'Hats', brand: 'Sunlight Groove' },
        { id: 'LM-063', name: 'Dickies Jackets', brand: 'Leopard Mark', note: 'Team uniform', sizes: GARMENT },
        { id: 'LM-066', name: 'Color Polos', brand: 'Cantinesca', sizes: GARMENT },
        { id: 'LM-062', name: "Women's Uniform", brand: 'Leopard Mark', note: 'For brand activations', sizes: APPAREL }
      ]
    },
    {
      id: 'merch-swag',
      name: 'Merch & Swag',
      blurb: 'Consumer merch. Garments ordered by size.',
      items: [
        { id: 'LM-076', name: 'Graphic Tee', brand: 'Leopard Mark', sizes: GARMENT },
        { id: 'LM-079', name: 'Graphic Tee', brand: 'Cantinesca', sizes: GARMENT },
        { id: 'LM-082', name: 'Graphic Tee', brand: 'Sunlight Groove', sizes: GARMENT },
        { id: 'LM-074', name: 'Hoodie', brand: 'Leopard Mark', sizes: GARMENT },
        { id: 'LM-077', name: 'Hoodie', brand: 'Cantinesca', sizes: GARMENT },
        { id: 'LM-080', name: 'Hoodie', brand: 'Sunlight Groove', sizes: GARMENT },
        { id: 'LM-075', name: 'Quarter Zip', brand: 'Leopard Mark', sizes: GARMENT },
        { id: 'LM-078', name: 'Quarter Zip', brand: 'Cantinesca', sizes: GARMENT },
        { id: 'LM-081', name: 'Quarter Zip', brand: 'Sunlight Groove', sizes: GARMENT },
        { id: 'LM-086', name: 'Enamel Pins', brand: 'Multi-Brand' },
        { id: 'LM-087', name: 'Keychains', brand: 'Multi-Brand' },
        { id: 'LM-088', name: 'Lanyards', brand: 'Multi-Brand' },
        { id: 'LM-089', name: 'Custom Coins', brand: 'Multi-Brand' },
        { id: 'LM-083', name: 'Coffee Mug (engraved)', brand: 'Multi-Brand', note: 'Funny engravings' },
        { id: 'LM-085', name: 'Umbrellas', brand: 'Cantinesca' }
      ]
    },
    {
      id: 'sampling-equipment',
      name: 'Sampling Equipment',
      blurb: 'Draft and cold-chain gear for sampling and installs.',
      items: [
        { id: 'LM-012', name: 'Tap Handle (redesign)', brand: 'Sunlight Groove' },
        { id: 'LM-013', name: 'Branded Keg Jackets', brand: 'Cantinesca' },
        { id: 'LM-014', name: 'Branded Keg Jackets', brand: 'Sunlight Groove' },
        { id: 'LM-015', name: 'Branded Keg Jackets', brand: 'Leopard Mark' },
        { id: 'LM-011', name: 'Coolers', brand: 'Leopard Mark' }
      ]
    },
    {
      id: 'event-equipment',
      name: 'Event Equipment',
      blurb: 'Festival and pop-up setup.',
      items: [
        { id: 'LM-058', name: 'Pop-up Tent', brand: 'Multi-Brand' },
        { id: 'LM-059', name: 'Table Cloth', brand: 'Leopard Mark' }
      ]
    },
    {
      id: 'packaging',
      name: 'Packaging',
      blurb: 'Shipping and unboxing materials. Usually warehouse stock.',
      items: [
        { id: 'LM-023', name: 'Shipping Box - Exterior Print', brand: 'Leopard Mark' },
        { id: 'LM-024', name: 'Shipping Box - Interior Print', brand: 'Multi-Brand', note: 'Interior print varies by brand' },
        { id: 'LM-025', name: 'Packaging Tape', brand: 'Leopard Mark', unit: 'roll' },
        { id: 'LM-026', name: 'Custom Tissue Paper', brand: 'Leopard Mark' },
        { id: 'LM-027', name: 'Interior Product Cut-Out (foam/insert)', brand: 'Multi-Brand' }
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

  window.LM_MARKETING_BRANDS = ['Leopard Mark', 'Cantinesca', 'Sunlight Groove', 'Multi-Brand'];
})();
