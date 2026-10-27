// TradingView sector / industry classification (spec section 23).
//
// PROVENANCE — read this before trusting the data:
//  * `confirmed`  : read directly from TradingView's own US "Industries" page
//                   (Oct 2026) or its other-market industry tables, together
//                   with the sector each industry belongs to.
//  * `recalled`   : industries that sit below that page's first screen of
//                   results. Names were filled in from knowledge of TradingView's
//                   classification and are validated by the per-sector industry
//                   COUNTS TradingView publishes on its Sectors page (see the
//                   test: every sector's total matches). Spelling of these few
//                   names should be eyeballed against TradingView once.
// Nothing here is a GICS or Yahoo category.

/** @type {Record<string,{confirmed:string[],recalled:string[]}>} */
export const TRADINGVIEW_TAXONOMY = {
  'Commercial Services': {
    confirmed: ['Miscellaneous Commercial Services', 'Financial Publishing/Services', 'Personnel Services'],
    recalled: ['Advertising/Marketing Services', 'Commercial Printing/Forms'],
  },
  Communications: {
    confirmed: ['Specialty Telecommunications', 'Wireless Telecommunications', 'Major Telecommunications'],
    recalled: [],
  },
  'Consumer Durables': {
    confirmed: ['Motor Vehicles', 'Homebuilding', 'Recreational Products', 'Electronics/Appliances'],
    recalled: ['Home Furnishings', 'Other Consumer Specialties', 'Tools & Hardware', 'Automotive Aftermarket'],
  },
  'Consumer Non-Durables': {
    confirmed: ['Household/Personal Care', 'Beverages: Non-Alcoholic', 'Tobacco', 'Food: Specialty/Candy', 'Beverages: Alcoholic', 'Apparel/Footwear', 'Food: Meat/Fish/Dairy', 'Food: Major Diversified'],
    recalled: ['Consumer Sundries'],
  },
  'Consumer Services': {
    confirmed: ['Hotels/Resorts/Cruise lines', 'Restaurants', 'Movies/Entertainment', 'Other Consumer Services', 'Cable/Satellite TV', 'Casinos/Gaming', 'Broadcasting', 'Media Conglomerates'],
    recalled: ['Publishing: Books/Magazines', 'Publishing: Newspapers'],
  },
  'Distribution Services': {
    confirmed: ['Wholesale Distributors', 'Medical Distributors', 'Food Distributors', 'Electronics Distributors'],
    recalled: [],
  },
  'Electronic Technology': {
    confirmed: ['Semiconductors', 'Telecommunications Equipment', 'Aerospace & Defense', 'Computer Peripherals', 'Computer Processing Hardware', 'Electronic Components', 'Electronic Production Equipment', 'Electronic Equipment/Instruments', 'Computer Communications'],
    recalled: [],
  },
  'Energy Minerals': {
    confirmed: ['Integrated Oil', 'Oil Refining/Marketing', 'Oil & Gas Production'],
    recalled: ['Coal'],
  },
  Finance: {
    confirmed: ['Major Banks', 'Property/Casualty Insurance', 'Finance/Rental/Leasing', 'Real Estate Investment Trusts', 'Investment Managers', 'Investment Banks/Brokers', 'Regional Banks', 'Multi-Line Insurance', 'Insurance Brokers/Services', 'Financial Conglomerates', 'Life/Health Insurance', 'Real Estate Development'],
    recalled: ['Savings Banks', 'Specialty Insurance'],
  },
  'Health Services': {
    confirmed: ['Managed Health Care', 'Medical/Nursing Services', 'Hospital/Nursing Management'],
    recalled: ['Services to the Health Industry'],
  },
  'Health Technology': {
    confirmed: ['Pharmaceuticals: Major', 'Medical Specialties', 'Biotechnology', 'Pharmaceuticals: Other', 'Pharmaceuticals: Generic'],
    recalled: [],
  },
  'Industrial Services': {
    confirmed: ['Oil & Gas Pipelines', 'Engineering & Construction', 'Environmental Services', 'Contract Drilling', 'Oilfield Services/Equipment'],
    recalled: [],
  },
  Miscellaneous: {
    confirmed: ['Investment Trusts/Mutual Funds'],
    recalled: ['Miscellaneous'],
  },
  'Non-Energy Minerals': {
    confirmed: ['Precious Metals', 'Other Metals/Minerals', 'Steel', 'Construction Materials'],
    recalled: ['Aluminum', 'Forest Products'],
  },
  'Process Industries': {
    confirmed: ['Chemicals: Specialty', 'Industrial Specialties', 'Containers/Packaging', 'Agricultural Commodities/Milling', 'Chemicals: Agricultural', 'Chemicals: Major Diversified'],
    recalled: ['Pulp & Paper', 'Textiles'],
  },
  'Producer Manufacturing': {
    confirmed: ['Industrial Machinery', 'Electrical Products', 'Trucks/Construction/Farm Machinery', 'Auto Parts: OEM', 'Building Products', 'Industrial Conglomerates'],
    recalled: ['Metal Fabrication', 'Miscellaneous Manufacturing', 'Office Equipment/Supplies'],
  },
  'Retail Trade': {
    confirmed: ['Internet Retail', 'Specialty Stores', 'Home Improvement Chains', 'Apparel/Footwear Retail', 'Department Stores', 'Drugstore Chains', 'Discount Stores', 'Food Retail'],
    recalled: ['Electronics/Appliance Stores', 'Catalog/Specialty Distribution'],
  },
  'Technology Services': {
    confirmed: ['Internet Software/Services', 'Packaged Software', 'Information Technology Services', 'Data Processing Services'],
    recalled: [],
  },
  Transportation: {
    confirmed: ['Railroads', 'Air Freight/Couriers', 'Other Transportation', 'Airlines', 'Trucking', 'Marine Shipping'],
    recalled: [],
  },
  Utilities: {
    confirmed: ['Electric Utilities', 'Gas Distributors', 'Water Utilities', 'Alternative Power Generation'],
    recalled: [],
  },
};

/** Industry counts per sector exactly as TradingView's Sectors page lists them (Oct 2026). */
export const PUBLISHED_INDUSTRY_COUNTS = {
  'Electronic Technology': 9, 'Technology Services': 4, Finance: 14, 'Health Technology': 5, 'Retail Trade': 10,
  'Energy Minerals': 4, 'Producer Manufacturing': 9, 'Consumer Non-Durables': 9, Communications: 3, Utilities: 4,
  'Consumer Durables': 8, 'Non-Energy Minerals': 6, 'Consumer Services': 10, 'Industrial Services': 5, Transportation: 6,
  'Commercial Services': 5, 'Process Industries': 8, 'Health Services': 4, 'Distribution Services': 4, Miscellaneous: 2,
};

/** Flat list: [{sector, industry, confirmed}] sorted for stable output. */
export function flattenTaxonomy() {
  const rows = [];
  for (const [sector, { confirmed, recalled }] of Object.entries(TRADINGVIEW_TAXONOMY)) {
    for (const industry of confirmed) rows.push({ sector, industry, confirmed: true });
    for (const industry of recalled) rows.push({ sector, industry, confirmed: false });
  }
  return rows.sort((a, b) => a.sector.localeCompare(b.sector) || a.industry.localeCompare(b.industry));
}

/** Spec 23: choosing a sector shows ONLY that sector's industries. */
export function industriesForSector(sectorName) {
  const s = TRADINGVIEW_TAXONOMY[sectorName];
  return s ? [...s.confirmed, ...s.recalled].sort() : [];
}

const norm = (x) => String(x).toLowerCase().replace(/&/g, 'and').replace(/\s*([/:])\s*/g, '$1').replace(/\s+/g, ' ').trim();

/**
 * Map names reported by a classification source onto OUR taxonomy.
 * Returns {status:'ok', sector, industry} only when the pair exists and the
 * industry really belongs to that sector; otherwise {status:'unmapped'} so
 * the user picks manually — we never invent or force a classification.
 */
export function matchTaxonomy(sectorName, industryName) {
  const sector = Object.keys(TRADINGVIEW_TAXONOMY).find((s) => norm(s) === norm(sectorName ?? ''));
  if (!sector) return { status: 'unmapped', reason: `Sector "${sectorName}" is not in the TradingView taxonomy.` };
  const industry = industriesForSector(sector).find((i) => norm(i) === norm(industryName ?? ''));
  if (!industry) return { status: 'unmapped', reason: `Industry "${industryName}" is not listed under ${sector}.`, sector };
  return { status: 'ok', sector, industry };
}

/**
 * TradingView's public scanner (unofficial, no key). One POST per batch of symbols.
 * @param {string[]} symbols
 * @param {{fetchImpl?:typeof fetch, market?:string}} [o]
 * @returns {Promise<Map<string,{status:string,sector?:string,industry?:string,reason?:string}>>}
 */
export async function fetchTradingViewClassification(symbols, { fetchImpl = globalThis.fetch, market = 'america' } = {}) {
  const out = new Map();
  const wanted = [...new Set(symbols.map((s) => s.toUpperCase()))];
  let res;
  try {
    res = await fetchImpl(`https://scanner.tradingview.com/${market}/scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filter: [{ left: 'name', operation: 'in_range', right: wanted }, { left: 'type', operation: 'equal', right: 'stock' }],
        columns: ['name', 'sector', 'industry'],
        range: [0, Math.max(50, wanted.length * 3)], // a ticker can list on several exchanges
      }),
    });
  } catch {
    for (const s of wanted) out.set(s, { status: 'unavailable', reason: 'TradingView classification could not be retrieved.' });
    return out;
  }
  if (!res.ok) {
    for (const s of wanted) out.set(s, { status: 'unavailable', reason: `TradingView classification could not be retrieved (HTTP ${res.status}).` });
    return out;
  }
  const json = await res.json().catch(() => ({ data: [] }));
  for (const row of json.data ?? []) {
    const [name, sector, industry] = row.d ?? [];
    if (!name || out.has(String(name).toUpperCase())) continue; // first listing wins
    out.set(String(name).toUpperCase(), matchTaxonomy(sector, industry));
  }
  for (const s of wanted) if (!out.has(s)) out.set(s, { status: 'unmapped', reason: `TradingView returned no classification for ${s}.` });
  return out;
}
