/**
 * ── YOUR ART-DIRECTION FILE ──────────────────────────────────────────────────
 * Everything the procedural recipes use to decide what a building "looks like"
 * lives here. No code changes needed to restyle the game: edit colors, roof
 * pitch, window density, dock count, etc., save, and the dev server reloads.
 *
 * Materials are referenced by key (e.g. 'siding') from the parts list emitted
 * by the recipes; the renderer maps each key to the colors defined here.
 */

export interface Palette {
  /** Named materials the recipes may reference. */
  colors: {
    siding: string;
    roof: string;
    accent: string;
    glass: string;
    concrete: string;
    trim: string;
    interiorFloor: string;
  };
}

export interface WarehouseStyle {
  palette: Palette;
  /** 0 = perfectly flat roof, 1 = steep gable. 0.2–0.35 reads industrial. */
  roofPitch: number;
  /** Roof edge overhang in metres. */
  roofOverhangM: number;
  /**
   * Loading dock doors: 'auto' sizes the count from the long wall length,
   * a number forces exactly that many (0 = none).
   */
  docks: 'auto' | number;
  /** Probability [0–1] that a small office annex sits on one corner. */
  annexChance: number;
  /** Rooftop HVAC units per 1,000 m2 of footprint (rounded deterministically). */
  hvacPer1000M2: number;
  /** True to add a translucent skylight strip along the roof ridge. */
  skylight: boolean;
}

export interface OfficeStyle {
  palette: Palette;
  /** Fraction of the footprint the street-level plinth covers (0.5–1). */
  plinthFootprintFraction: number;
  /** Depth of each horizontal window band, in metres. */
  windowBandDepthM: number;
  /** Fraction of the facade height covered by window bands (rest is spandrel). */
  windowBandCoverage: number;
  /** Height of the rooftop mechanical penthouse, in metres. */
  penthouseHeightM: number;
  /** True for a flat parapet lip around the roof edge. */
  parapet: boolean;
}

export interface TowerStyle {
  palette: Palette;
  /** Each tier is this fraction of the one below it. Lower = more taper. */
  tierShrink: number;
  /** Maximum number of setback tiers before the crown. */
  maxTiers: number;
  /** Height of the decorative crown box on top, in metres. */
  crownHeightM: number;
  /** Depth of each horizontal window band, in metres. */
  windowBandDepthM: number;
}

export const WAREHOUSE_STYLE: WarehouseStyle = {
  palette: {
    colors: {
      siding: '#aeb6bd',
      roof: '#46525c',
      accent: '#f28c28',
      glass: '#7db4d8',
      concrete: '#8f8b86',
      trim: '#d8dde2',
      interiorFloor: '#6b6f74',
    },
  },
  roofPitch: 0.25,
  roofOverhangM: 0.6,
  docks: 'auto',
  annexChance: 0.65,
  hvacPer1000M2: 1.2,
  skylight: true,
};

export const OFFICE_STYLE: OfficeStyle = {
  palette: {
    colors: {
      siding: '#c9cdd3',
      roof: '#3c4650',
      accent: '#2e6f9e',
      glass: '#8fc1e3',
      concrete: '#9a968f',
      trim: '#e4e8ec',
      interiorFloor: '#7d7f84',
    },
  },
  plinthFootprintFraction: 0.8,
  windowBandDepthM: 0.25,
  windowBandCoverage: 0.6,
  penthouseHeightM: 2.6,
  parapet: true,
};

export const TOWER_STYLE: TowerStyle = {
  palette: {
    colors: {
      siding: '#b7c3cc',
      roof: '#333d47',
      accent: '#3f7cad',
      glass: '#9ecbee',
      concrete: '#93908b',
      trim: '#e8ecef',
      interiorFloor: '#83868b',
    },
  },
  tierShrink: 0.82,
  maxTiers: 4,
  crownHeightM: 3.5,
  windowBandDepthM: 0.25,
};

/**
 * Generic warehouse look for UNCLAIMED buildings: every visible footprint gets a
 * muted, low-detail warehouse by default; claiming upgrades it to the full
 * classified model. Deliberately drab so the neon claim treatment pops.
 */
export const AMBIENT_WAREHOUSE_STYLE: WarehouseStyle = {
  palette: {
    colors: {
      siding: '#9aa1a7',
      roof: '#3f464d',
      accent: '#6b7076',
      glass: '#5c6d7a',
      concrete: '#7f7c78',
      trim: '#a7abb0',
      interiorFloor: '#5f6367',
    },
  },
  roofPitch: 0.22,
  roofOverhangM: 0.4,
  docks: 0,
  annexChance: 0.25,
  hvacPer1000M2: 0.5,
  skylight: false,
};

/** Default interior layout tuning, shared by every archetype. */
export const INTERIOR_STYLE = {
  /** Clear interior height per storey, in metres. */
  warehouseStoreyHeightM: 8,
  officeStoreyHeightM: 3.2,
  /** Column grid spacing for office/tower floor plates, in metres. */
  columnGridM: 8,
  /** Slab thickness, in metres. */
  slabThicknessM: 0.3,
};
