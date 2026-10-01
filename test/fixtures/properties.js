// Snapshot of the 20 live listings (checked 2026-09-30), trimmed to what the tests need.
const Cr = (n) => Math.round(n * 10000000);
const L = (n) => Math.round(n * 100000);

const p = (id, title, category, location, status, price, metadata = {}, raw = '') => ({
  property_id: id,
  title,
  category,
  location,
  status,
  price_inr: price,
  metadata,
  raw_listing_text: raw
});

export const properties = [
  p('p01', 'Commercial Redevelopment Opportunity - Triplicane High Road', 'commercial_redevelopment', 'Triplicane, Chennai', 'available', Cr(32), { land_extent: '4.5 Grounds', title_status: 'Clear' }),
  p('p02', 'Operational Beach Resort with Shore Temple View', 'hospitality', 'Mamallapuram, Chennai', 'available', Cr(160), { room_count: 77, beach_access: 'Direct' }),
  p('p03', 'Signature 4BHK Sky Mansion', 'residential', 'Anna Nagar West, Chennai', 'available', Cr(4.8), { bedrooms: 4, bathrooms: 4 }),
  p('p04', 'High-Rise 2BHK Apartment near Tech Parks', 'residential', 'Navalur, OMR, Chennai', 'under_construction', L(62), { bedrooms: 2, bathrooms: 2, rera_id: 'TN/01/Building/0001/2026' }),
  p('p05', 'Heritage Residential Bungalow (Land Value Sale)', 'residential', 'Alwarpet, Chennai', 'available', null, { price_nature: 'On Request / VIP Buyers Only' }),
  p('p06', 'Sea-Facing 5BHK Independent Villa', 'residential', 'Uthandi, ECR, Chennai', 'available', Cr(9.5), { bedrooms: 5, bathrooms: 5 }),
  p('p07', 'Heavy Engineering Industrial Shed', 'industrial', 'Ambattur Industrial Estate, Chennai', 'available', null, { covered_shed_sqft: 40000 }),
  p('p08', 'Grade-A Commercial Office Floor Plate', 'commercial', 'Sholinganallur, OMR, Chennai', 'available', Cr(24.5), { chargeable_area_sqft: 22000 }),
  p('p09', 'Main Road Ground Floor Retail Shop', 'commercial', 'Mylapore, Chennai', 'available', Cr(1.85), { builtup_sqft: 900 }),
  p('p10', 'Logistics Box Warehouse with Dock Levelers', 'industrial', 'Sriperumbudur, Chennai', 'available', Cr(52), { dock_doors_count: 12 }),
  p('p11', 'CMDA & RERA Approved Residential Villa Plot', 'plot', 'Medavakkam, Chennai', 'available', L(84), { plot_area_sqft: 2400 }),
  p('p12', 'Prime Standalone Retail Showroom Building', 'commercial', 'T. Nagar, Chennai', 'reserved', Cr(45), { builtup_sqft: 18000 }),
  p('p13', 'Operational Boutique Hotel Building', 'hospitality', 'Guindy, Chennai', 'available', Cr(19), { room_count: 34 }),
  p('p14', 'Institutional Land for Hospital / University', 'plot', 'Poonamallee High Road, Chennai', 'available', Cr(72), { land_extent: '8 Acres' }),
  p('p15', 'Multi-Chamber Cold Storage Facility', 'industrial', 'Koyambedu, Chennai', 'available', Cr(11.5), { capacity_metric_tons: 2000 }),
  p('p16', 'Compact 1BHK Starter Flat', 'residential', 'East Tambaram, Chennai', 'available', L(28), { bedrooms: 1, bathrooms: 1 }),
  p('p17', 'Gated Organic Farm Land Parcel', 'farmland', 'Urapakkam / Chengalpattu Border', 'available', Cr(1.65), { land_extent_acres: 2 }),
  p('p18', '3-Storey Multi-Family Rental House', 'residential', 'Velachery, Chennai', 'available', Cr(2.1), { floors: 3 }),
  p('p19', 'Exclusive Rooftop Penthouse with Ocean Vista', 'residential', 'Besant Nagar, Chennai', 'sold', Cr(6.5), { bedrooms: 4, bathrooms: 4 }),
  p('p20', 'F&B Approved Cloud Kitchen Facility', 'commercial', 'Perungudi, Chennai', 'available', Cr(1.35), { builtup_sqft: 1200 })
];

export { Cr, L };
