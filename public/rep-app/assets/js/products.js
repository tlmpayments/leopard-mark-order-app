// Product / SKU catalog. Prices sourced from the "Product Information" tab of
// TLM Distribution Master File.xlsx (Price column, rows 21-29) — CNT/SGB rows.
window.LM_PRODUCTS = [
  {
    id: 'CNT',
    name: 'Cantinesca',
    subtitle: 'Cerveza Lager',
    image: 'assets/img/cantinesca.png',
    accent: '#d6187e',
    formats: [
      { code: 'CNT1AKHB01', label: '1/2 Barrel Keg', detail: '15.5 gal', unit: 'keg', price: 192.00 },
      { code: 'CNT1AKSB01', label: '1/6 Barrel Keg', detail: '5.16 gal', unit: 'keg', price: 96.00 },
      { code: 'CNT1AC1224', label: '4/6/12 Case', detail: '4 six-packs of 12oz cans', unit: 'case', price: 31.70 }
    ]
  },
  {
    id: 'SGB',
    name: 'Sunlight Groove — Bay Area',
    subtitle: 'Cali Copper Lager',
    image: 'assets/img/sunlight-groove.png',
    accent: '#7a2fb5',
    formats: [
      { code: 'SGB1AKHB01', label: '1/2 Barrel Keg', detail: '15.5 gal', unit: 'keg', price: 205.00 },
      { code: 'SGB1AKSB01', label: '1/6 Barrel Keg', detail: '5.16 gal', unit: 'keg', price: 99.50 },
      { code: 'SGB1AC1224', label: '4/6/12 Case', detail: '4 six-packs of 12oz cans', unit: 'case', price: 36.25 }
    ]
  }
];
