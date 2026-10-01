// What we show about a property. A fixed list of fields per category, never the raw listing text.
import { priceDisplay } from './money.js';

const STATUS_LABELS = {
  available: 'Available',
  under_construction: 'Under construction'
};

// Fields that come from the seller rather than from us.
const SELLER_STATED = new Set([
  'roi_percentage',
  'monthly_rental_current',
  'monthly_rental_income_lakhs',
  'monthly_rental_collection',
  'indicative_monthly_income_lakhs'
]);

const HIGHLIGHTS = {
  residential: [
    'carpet_area_sqft', 'super_builtup_sqft', 'builtup_area_sqft', 'total_builtup_sqft',
    'plot_area_sqft', 'land_extent', 'floor', 'total_floors', 'furnishing', 'car_parks',
    'allocated_car_parks', 'gated_community', 'facing', 'view', 'possession_date'
  ],
  plot: [
    'plot_area_sqft', 'land_extent', 'dimensions', 'facing', 'road_width_ft', 'cmda_approved',
    'gated_layout', 'bank_loan_approved'
  ],
  farmland: [
    'land_extent_acres', 'land_extent_cents', 'soil_type', 'borewells_count', 'eb_free_agri_power', 'fencing'
  ],
  commercial: [
    'builtup_sqft', 'chargeable_area_sqft', 'floors', 'frontage_ft', 'car_parking', 'current_tenant',
    'lease_status', 'monthly_rental_current', 'roi_percentage', 'distance_to_metro_meters', 'occupancy_certificate'
  ],
  commercial_redevelopment: [
    'land_extent', 'land_extent_sqft', 'road_frontage_ft', 'existing_units', 'title_status',
    'building_condition', 'indicative_monthly_income_lakhs', 'facing'
  ],
  hospitality: [
    'room_count', 'keys_count', 'land_extent', 'beach_access', 'facilities', 'liquor_license', 'banquet_hall_capacity'
  ],
  industrial: [
    'built_warehouse_sqft', 'covered_shed_sqft', 'land_extent_acres', 'clear_height_ft', 'clear_height_meters',
    'dock_doors_count', 'power_sanctioned_kva', 'capacity_metric_tons', 'office_space_sqft', 'fire_noc_obtained'
  ]
};

const MAX_HIGHLIGHTS = 6;

export const SELLER_STATED_FIELDS = SELLER_STATED;

export function toPropertyView(row, { kind = 'match', differences = [], distanceKm = null } = {}) {
  const meta = row.metadata ?? {};
  const price = row.price_inr === null || row.price_inr === undefined ? null : Number(row.price_inr);

  return {
    id: row.property_id,
    title: row.title,
    category: row.category,
    location: row.location,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] ?? row.status,
    price,
    priceDisplay: priceDisplay(price),
    priceKnown: price !== null,
    bedrooms: numberOrNull(meta.bedrooms),
    bathrooms: numberOrNull(meta.bathrooms),
    rera: meta.rera_id ?? null,
    highlights: highlightsFor(row.category, meta),
    kind,
    differences,
    distanceKm
  };
}

function highlightsFor(category, meta) {
  const out = [];
  for (const key of HIGHLIGHTS[category] ?? []) {
    const value = meta[key];
    if (value === null || value === undefined || value === '') continue;
    const label = humanize(key) + (SELLER_STATED.has(key) ? ' (as stated by seller)' : '');
    out.push({ label, value: formatValue(key, value) });
    if (out.length === MAX_HIGHLIGHTS) break;
  }
  return out;
}

export function humanize(key) {
  const words = key.replace(/_(sqft|ft|meters|percentage|lakhs|kva|acres|cents)$/, '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function formatValue(key, value) {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'number') {
    if (key.endsWith('_sqft')) return `${value.toLocaleString('en-IN')} sq ft`;
    if (key.endsWith('_ft')) return `${value} ft`;
    if (key.endsWith('_meters')) return `${value} m`;
    if (key.endsWith('_percentage')) return `${value}%`;
    if (key.endsWith('_lakhs')) return `₹${value} L per month`;
    if (key.endsWith('_acres')) return `${value} acres`;
    if (key.endsWith('_cents')) return `${value} cents`;
    if (key.endsWith('_kva')) return `${value} kVA`;
    return String(value);
  }
  return String(value);
}

function numberOrNull(value) {
  const n = Number(value);
  return value === null || value === undefined || Number.isNaN(n) ? null : n;
}
