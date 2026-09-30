// Chennai micro-markets: what "OMR" or "near Tidel Park" means, and how far apart areas are.
//
// Coordinates are approximate centre points (good to a kilometre or two). They only decide
// whether a listing is in the requested area, near it, or far from it. Check them before
// relying on them for anything finer, and add localities as inventory grows.

const loc = (name, lat, lng, extra = {}) => ({ name, lat, lng, corridors: [], aliases: [], ...extra });

export const LOCALITIES = [
  // OMR (Old Mahabalipuram Road)
  loc('Taramani', 12.987, 80.243, { corridors: ['OMR'] }),
  loc('Perungudi', 12.9654, 80.2461, { corridors: ['OMR'] }),
  loc('Thoraipakkam', 12.9383, 80.2378, { corridors: ['OMR'] }),
  loc('Karapakkam', 12.919, 80.229, { corridors: ['OMR'] }),
  loc('Sholinganallur', 12.901, 80.2279, { corridors: ['OMR'] }),
  loc('Semmancheri', 12.87, 80.227, { corridors: ['OMR'] }),
  loc('Navalur', 12.8458, 80.2265, { corridors: ['OMR'] }),
  loc('Siruseri', 12.823, 80.227, { corridors: ['OMR'] }),
  loc('Kelambakkam', 12.786, 80.219, { corridors: ['OMR'] }),

  // ECR (East Coast Road)
  loc('Thiruvanmiyur', 12.983, 80.2594, { corridors: ['ECR'] }),
  loc('Neelankarai', 12.949, 80.259, { corridors: ['ECR'] }),
  loc('Injambakkam', 12.919, 80.256, { corridors: ['ECR'] }),
  loc('Uthandi', 12.8628, 80.2453, { corridors: ['ECR'] }),
  loc('Mamallapuram', 12.6269, 80.1927, { corridors: ['ECR'], aliases: ['Mahabalipuram'] }),

  // GST Road (south-west)
  loc('Tambaram', 12.9249, 80.1, { corridors: ['GST Road'] }),
  loc('East Tambaram', 12.923, 80.12, { corridors: ['GST Road'] }),
  loc('West Tambaram', 12.93, 80.095, { corridors: ['GST Road'] }),
  loc('Selaiyur', 12.907, 80.14, { corridors: ['GST Road'] }),
  loc('Chromepet', 12.9516, 80.1462, { corridors: ['GST Road'] }),
  loc('Pallavaram', 12.9675, 80.1491, { corridors: ['GST Road'] }),
  loc('Urapakkam', 12.86, 80.06, { corridors: ['GST Road'] }),
  loc('Guduvanchery', 12.844, 80.06, { corridors: ['GST Road'] }),
  loc('Chengalpattu', 12.6819, 79.9888, { corridors: ['GST Road'] }),

  // South and central Chennai
  loc('Medavakkam', 12.917, 80.192),
  loc('Pallikaranai', 12.934, 80.213),
  loc('Velachery', 12.9815, 80.218),
  loc('Guindy', 13.0067, 80.2206),
  loc('Adyar', 13.0012, 80.2565),
  loc('Besant Nagar', 13.0002, 80.2668),
  loc('Alwarpet', 13.0339, 80.253),
  loc('Mylapore', 13.0368, 80.2676),
  loc('Triplicane', 13.0588, 80.2767),
  loc('T. Nagar', 13.0418, 80.2341, { aliases: ['T Nagar', 'Thyagaraya Nagar'] }),
  loc('Nungambakkam', 13.0569, 80.2425),
  loc('Egmore', 13.0732, 80.2609),
  loc('Kilpauk', 13.0836, 80.2427),
  loc('Meenambakkam', 12.9877, 80.1764),

  // North and west Chennai
  loc('Anna Nagar', 13.085, 80.2101),
  loc('Anna Nagar West', 13.0878, 80.1996),
  loc('Anna Nagar East', 13.089, 80.22),
  loc('Koyambedu', 13.0694, 80.1948),
  loc('Porur', 13.0382, 80.1565),
  loc('Ambattur', 13.1143, 80.1548),
  loc('Poonamallee', 13.0473, 80.0945),
  loc('Sriperumbudur', 12.9675, 79.942)
];

// Named areas that cover several localities, plus landmarks people use instead.
export const AREAS = [
  {
    name: 'OMR',
    kind: 'corridor',
    aliases: [
      'Old Mahabalipuram Road',
      'Rajiv Gandhi Salai',
      'IT corridor',
      'IT expressway',
      'IT park',
      'IT parks',
      'Tidel Park',
      'Sholinganallur junction'
    ]
  },
  { name: 'ECR', kind: 'corridor', aliases: ['East Coast Road'] },
  { name: 'GST Road', kind: 'corridor', aliases: ['GST', 'Grand Southern Trunk Road'] },
  {
    name: 'Tambaram',
    kind: 'area',
    aliases: [],
    members: ['Tambaram', 'East Tambaram', 'West Tambaram', 'Selaiyur']
  },
  {
    name: 'Anna Nagar',
    kind: 'area',
    aliases: [],
    members: ['Anna Nagar', 'Anna Nagar West', 'Anna Nagar East']
  },
  {
    name: 'Chengalpattu',
    kind: 'area',
    aliases: [],
    members: ['Chengalpattu', 'Urapakkam', 'Guduvanchery']
  },
  {
    name: 'Airport area',
    kind: 'area',
    aliases: ['airport', 'Chennai airport', 'Meenambakkam airport'],
    members: ['Meenambakkam', 'Pallavaram']
  }
];

// Listings within this distance of the requested area count as "near".
export const NEAR_KM = 8;

const byName = new Map(LOCALITIES.map((l) => [l.name, l]));

export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const entries = new Map();

function register(entry, names) {
  for (const name of names) entries.set(normalize(name), entry);
}

for (const l of LOCALITIES) {
  register({ name: l.name, kind: 'locality', members: [l.name] }, [l.name, ...l.aliases]);
}
for (const area of AREAS) {
  const members =
    area.members ?? LOCALITIES.filter((l) => l.corridors.includes(area.name)).map((l) => l.name);
  register({ name: area.name, kind: area.kind, members }, [area.name, ...area.aliases]);
}

function containsWord(haystack, needle) {
  return ` ${haystack} `.includes(` ${needle} `);
}

// "near Tidel Park" -> the OMR corridor. Returns null for an area we do not know.
export function resolveArea(text) {
  const n = normalize(text);
  if (!n) return null;
  if (entries.has(n)) return entries.get(n);

  let best = null;
  for (const [key, entry] of entries) {
    if (containsWord(n, key) && (!best || key.length > best.key.length)) best = { key, entry };
  }
  return best?.entry ?? null;
}

const corridorWords = ['omr', 'ecr', 'gst road', 'old mahabalipuram road', 'east coast road'];
const corridorByWord = {
  omr: 'OMR',
  'old mahabalipuram road': 'OMR',
  ecr: 'ECR',
  'east coast road': 'ECR',
  'gst road': 'GST Road'
};

// "Navalur, OMR, Chennai" -> { locality: Navalur, corridors: {OMR} }
export function locateProperty(locationText) {
  const n = ` ${normalize(locationText)} `;
  let best = null;

  for (const l of LOCALITIES) {
    for (const name of [l.name, ...l.aliases]) {
      const key = normalize(name);
      const at = n.indexOf(` ${key} `);
      if (at === -1) continue;
      if (!best || at < best.at || (at === best.at && key.length > best.len)) {
        best = { locality: l, at, len: key.length };
      }
    }
  }

  const corridors = new Set(best?.locality.corridors ?? []);
  for (const word of corridorWords) {
    if (n.includes(` ${word} `)) corridors.add(corridorByWord[word]);
  }
  return { locality: best?.locality ?? null, corridors };
}

function haversineKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// Tier 0: inside the requested area. Tier 1: within NEAR_KM. Tier 2: further, or unknown.
export function areaDistance(entry, place) {
  if (place.locality && entry.members.includes(place.locality.name)) return { tier: 0, km: 0 };
  if (entry.kind === 'corridor' && place.corridors.has(entry.name)) return { tier: 0, km: 0 };
  if (!place.locality) return { tier: 2, km: null };

  const km = Math.min(...entry.members.map((m) => haversineKm(byName.get(m), place.locality)));
  return { tier: km <= NEAR_KM ? 1 : 2, km: Math.max(1, Math.round(km)) };
}

// For an area we have no entry for, fall back to matching the typed words.
export function textDistance(areaText, locationText) {
  const wanted = normalize(areaText);
  if (wanted && containsWord(normalize(locationText), wanted)) return { tier: 0, km: 0 };
  return { tier: 2, km: null };
}
