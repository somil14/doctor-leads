/**
 * @module nearby
 * Geometry for the Nearby Search grid sweep: where a town's centre is, the
 * circle that covers a square cell, and how a cell splits in four.
 */

const METERS_PER_DEGREE = 111320;

/**
 * @typedef {object} Cell
 * @property {number} lat Centre latitude.
 * @property {number} lng Centre longitude.
 * @property {number} halfSide Half the side of the square, in metres.
 * @property {number} depth How many times its ancestors were split.
 */

/**
 * Median of a list of numbers.
 * @param {number[]} values Non-empty.
 * @returns {number}
 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Centre of a town, taken as the median position of places known to be in
 * it. The median ignores the odd listing pinned far from town.
 * @param {Array<{lat: number | null, lng: number | null}>} places
 * @param {number} minSamples Fewer located places than this gives no centre.
 * @returns {{lat: number, lng: number} | null}
 */
export function townCentre(places, minSamples) {
  const located = places.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (located.length < minSamples) return null;
  return { lat: median(located.map((p) => p.lat)), lng: median(located.map((p) => p.lng)) };
}

/**
 * The circle that fully covers a square cell.
 * @param {Cell} cell
 * @returns {{center: {latitude: number, longitude: number}, radius: number}}
 */
export function cellCircle(cell) {
  return {
    center: { latitude: round(cell.lat), longitude: round(cell.lng) },
    radius: Math.ceil(cell.halfSide * Math.SQRT2),
  };
}

/**
 * The four quarter cells of a cell.
 * @param {Cell} cell
 * @returns {Cell[]}
 */
export function childCells(cell) {
  const half = cell.halfSide / 2;
  const dLat = half / METERS_PER_DEGREE;
  const dLng = half / (METERS_PER_DEGREE * Math.cos((cell.lat * Math.PI) / 180));
  return [
    [1, -1],
    [1, 1],
    [-1, -1],
    [-1, 1],
  ].map(([ns, ew]) => ({
    lat: cell.lat + ns * dLat,
    lng: cell.lng + ew * dLng,
    halfSide: half,
    depth: cell.depth + 1,
  }));
}

/**
 * Most circles a sweep of one town can need.
 * @param {number} maxDepth
 * @returns {number}
 */
export function maxCellsPerTown(maxDepth) {
  let total = 0;
  for (let depth = 0; depth <= maxDepth; depth++) total += 4 ** depth;
  return total;
}

/**
 * Round a coordinate to about 1 cm so cache keys are stable.
 * @param {number} value
 * @returns {number}
 */
function round(value) {
  return Math.round(value * 1e7) / 1e7;
}
