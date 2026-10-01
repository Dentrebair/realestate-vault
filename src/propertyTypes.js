// What kind of property a Lead means. Two layers:
//   category  one of the seven values stored in the database
//   subtype   the everyday word inside a category (flat vs villa, office vs shop)

export const CATEGORIES = [
  'residential',
  'plot',
  'farmland',
  'commercial',
  'commercial_redevelopment',
  'hospitality',
  'industrial'
];

const CATEGORY_LABELS = {
  residential: 'residential',
  plot: 'plot',
  farmland: 'farmland',
  commercial: 'commercial',
  commercial_redevelopment: 'commercial redevelopment',
  hospitality: 'hospitality',
  industrial: 'industrial'
};

const RELATED = [
  ['commercial', 'commercial_redevelopment'],
  ['plot', 'farmland']
];

const SUBTYPES = {
  apartment: { label: 'apartment', category: 'residential', re: /\b(flat|flats|apartment|apartments|high rise|penthouse|sky mansion|mansion|condo|studio)\b/ },
  house: { label: 'house or villa', category: 'residential', re: /\b(villa|villas|bungalow|independent house|house|houses)\b/ },
  office: { label: 'office', category: 'commercial', re: /\b(office|offices|workspace|co working|coworking|floor plate)\b/ },
  retail: { label: 'shop or showroom', category: 'commercial', re: /\b(shop|shops|retail|showroom|store|outlet)\b/ },
  kitchen: { label: 'cloud kitchen', category: 'commercial', re: /\b(cloud kitchen|kitchen|restaurant|f b)\b/ },
  hotel: { label: 'hotel or resort', category: 'hospitality', re: /\b(hotel|resort|guest house|lodge)\b/ },
  warehouse: { label: 'warehouse', category: 'industrial', re: /\b(warehouse|godown|logistics)\b/ },
  coldstorage: { label: 'cold storage', category: 'industrial', re: /\bcold storage\b/ },
  factory: { label: 'industrial shed', category: 'industrial', re: /\b(factory|shed|manufacturing|engineering)\b/ }
};

export function categoryLabel(category) {
  return CATEGORY_LABELS[category] ?? String(category);
}

export function subtypeLabel(subtype) {
  return SUBTYPES[subtype]?.label ?? subtype;
}

export function relatedCategory(a, b) {
  return RELATED.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
}

function plain(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, ' ')
    .replace(/&/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Everyday words found in a title or a request: "Cloud Kitchen Facility" -> {kitchen}
export function detectSubtypes(text) {
  const t = plain(text);
  const found = new Set();
  for (const [name, { re }] of Object.entries(SUBTYPES)) {
    if (re.test(t)) found.add(name);
  }
  return found;
}

// "flat" -> residential, "land" -> plot or farmland, "warehouse" -> industrial.
export function normalizeCategory(text) {
  const t = plain(text);
  if (!t) return [];

  const exact = t.replace(/ /g, '_');
  if (CATEGORIES.includes(exact)) return [exact];

  const found = new Set();
  if (/\bredevelopment\b/.test(t)) found.add('commercial_redevelopment');
  if (/\b(farm|farmland|agricultural|agriculture|agri|orchard)\b/.test(t)) found.add('farmland');
  if (/\b(plot|plots|site|sites)\b/.test(t)) found.add('plot');
  else if (/\bland\b/.test(t) && !found.size) {
    found.add('plot');
    found.add('farmland');
  }
  if (/\b(hotel|resort|hospitality|guest house|lodge|homestay)\b/.test(t)) found.add('hospitality');
  if (/\b(industrial|warehouse|godown|factory|shed|manufacturing|cold storage|logistics)\b/.test(t)) {
    found.add('industrial');
  }
  if (
    !found.has('commercial_redevelopment') &&
    /\b(commercial|shop|shops|retail|showroom|store|office|offices|workspace|co working|coworking|cloud kitchen|kitchen|restaurant|outlet)\b/.test(t)
  ) {
    found.add('commercial');
  }
  if (
    !found.has('plot') &&
    !found.has('farmland') &&
    /\b(residential|flat|flats|apartment|apartments|house|houses|home|homes|villa|villas|bungalow|penthouse|bhk|condo|duplex|studio|mansion)\b/.test(t)
  ) {
    found.add('residential');
  }
  return [...found];
}

// A request with only "office" or "villa" still implies a category.
export function categoriesFromSubtypes(subtypes) {
  return [...new Set([...subtypes].map((s) => SUBTYPES[s]?.category).filter(Boolean))];
}
