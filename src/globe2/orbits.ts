/**
 * Orbital propagation for the vendored Starlink catalogue.
 *
 * This is a Keplerian propagator with the J2 secular terms (nodal regression,
 * apsidal precession, and the correction to mean motion) -- not a full SGP4.
 * That is a deliberate, disclosed simplification:
 *
 *  - Starlink orbits are near-circular LEO, where J2 is far and away the
 *    dominant perturbation, and the vendored elements are only hours old, so
 *    positions land within a few kilometres of an SGP4 solution.
 *  - It costs a handful of flops per satellite, which is what makes propagating
 *    the entire ~10,700-satellite catalogue every frame practical in the
 *    browser without a worker.
 *
 * The UI says as much rather than implying a live, exact ephemeris (CLAUDE.md,
 * "Avoid fake precision").
 */

const MU_KM3_S2 = 398600.4418;
const EARTH_EQUATORIAL_RADIUS_KM = 6378.137;
const J2 = 1.08262668e-3;
const TWO_PI = Math.PI * 2;
const DEG_TO_RAD = Math.PI / 180;

/** Fields per satellite in the packed element array. */
const STRIDE = 12;
const enum Field {
  SinIncl = 0,
  CosIncl = 1,
  Raan0 = 2,
  RaanDot = 3,
  Argp0 = 4,
  ArgpDot = 5,
  MeanAnomaly0 = 6,
  MeanMotion = 7,
  Eccentricity = 8,
  SemiMajorAxis = 9,
  EpochJd = 10,
  Inclination = 11,
}

export interface OrbitSet {
  count: number;
  /** Packed orbital elements, STRIDE doubles per satellite. */
  elements: Float64Array;
  /** Inclination in degrees, kept separately for shell classification. */
  inclinationDeg: Float64Array;
  /** Mean altitude in km, kept separately for shell classification. */
  altitudeKm: Float64Array;
}

const UNIX_EPOCH_JD = 2440587.5;

export function dateToJulian(msSinceUnixEpoch: number): number {
  return msSinceUnixEpoch / 86400000 + UNIX_EPOCH_JD;
}

/** Greenwich Mean Sidereal Time in radians, for rotating ECI into Earth-fixed. */
export function gmstRadians(julianDate: number): number {
  const t = (julianDate - 2451545.0) / 36525;
  // IAU 1982 expression, in seconds of sidereal time.
  const seconds =
    67310.54841 + (876600 * 3600 + 8640184.812866) * t + 0.093104 * t * t - 6.2e-6 * t * t * t;
  const degrees = ((seconds / 240) % 360 + 360) % 360;
  return degrees * DEG_TO_RAD;
}

function epochToJulian(line1: string): number {
  const twoDigitYear = Number.parseInt(line1.slice(18, 20), 10);
  const year = twoDigitYear < 57 ? 2000 + twoDigitYear : 1900 + twoDigitYear;
  const dayOfYear = Number.parseFloat(line1.slice(20, 32));
  const januaryFirst = Date.UTC(year, 0, 1);
  return dateToJulian(januaryFirst) + (dayOfYear - 1);
}

/**
 * Parses two-line elements into a packed array, precomputing the J2 secular
 * rates once so the per-frame loop is pure arithmetic.
 */
export function buildOrbitSet(records: readonly { line1: string; line2: string }[]): OrbitSet {
  const count = records.length;
  const elements = new Float64Array(count * STRIDE);
  const inclinationDeg = new Float64Array(count);
  const altitudeKm = new Float64Array(count);

  let kept = 0;
  for (let i = 0; i < count; i++) {
    const { line1, line2 } = records[i];

    const inclination = Number.parseFloat(line2.slice(8, 16)) * DEG_TO_RAD;
    const raan = Number.parseFloat(line2.slice(17, 25)) * DEG_TO_RAD;
    const eccentricity = Number.parseFloat(`0.${line2.slice(26, 33).trim()}`);
    const argp = Number.parseFloat(line2.slice(34, 42)) * DEG_TO_RAD;
    const meanAnomaly = Number.parseFloat(line2.slice(43, 51)) * DEG_TO_RAD;
    const revsPerDay = Number.parseFloat(line2.slice(52, 63));

    if (!Number.isFinite(inclination) || !Number.isFinite(revsPerDay) || revsPerDay <= 0) continue;

    const meanMotion = (revsPerDay * TWO_PI) / 86400; // rad/s
    const semiMajorAxis = Math.cbrt(MU_KM3_S2 / (meanMotion * meanMotion));
    const semiLatusRectum = semiMajorAxis * (1 - eccentricity * eccentricity);

    // J2 secular rates. `factor` carries the shared 1.5 * J2 * (Re/p)^2 * n term.
    const ratio = EARTH_EQUATORIAL_RADIUS_KM / semiLatusRectum;
    const factor = 1.5 * J2 * ratio * ratio * meanMotion;
    const cosIncl = Math.cos(inclination);
    const sinIncl = Math.sin(inclination);
    const sinSquared = sinIncl * sinIncl;

    const base = kept * STRIDE;
    elements[base + Field.SinIncl] = sinIncl;
    elements[base + Field.CosIncl] = cosIncl;
    elements[base + Field.Raan0] = raan;
    elements[base + Field.RaanDot] = -factor * cosIncl;
    elements[base + Field.Argp0] = argp;
    elements[base + Field.ArgpDot] = factor * (2 - 2.5 * sinSquared);
    elements[base + Field.MeanAnomaly0] = meanAnomaly;
    elements[base + Field.MeanMotion] =
      meanMotion + factor * Math.sqrt(1 - eccentricity * eccentricity) * (1 - 1.5 * sinSquared);
    elements[base + Field.Eccentricity] = eccentricity;
    elements[base + Field.SemiMajorAxis] = semiMajorAxis;
    elements[base + Field.EpochJd] = epochToJulian(line1);
    elements[base + Field.Inclination] = inclination;

    inclinationDeg[kept] = inclination / DEG_TO_RAD;
    altitudeKm[kept] = semiMajorAxis - EARTH_EQUATORIAL_RADIUS_KM;
    kept++;
  }

  return {
    count: kept,
    elements: elements.subarray(0, kept * STRIDE),
    inclinationDeg: inclinationDeg.subarray(0, kept),
    altitudeKm: altitudeKm.subarray(0, kept),
  };
}

/**
 * Propagates every satellite to `julianDate` and writes render-frame positions
 * into `out` as xyz triples scaled by `unitsPerKm`.
 *
 * The ECI -> Earth-fixed -> render-frame conversion collapses to an axis swap
 * (x, z, -y) once the GMST rotation is applied, so there is no per-satellite
 * lat/lon round trip -- worth doing when this runs across the whole catalogue
 * every frame.
 */
export function propagate(set: OrbitSet, julianDate: number, unitsPerKm: number, out: Float32Array): void {
  const { count, elements } = set;
  const theta = gmstRadians(julianDate);
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);

  for (let i = 0; i < count; i++) {
    const base = i * STRIDE;
    const secondsSinceEpoch = (julianDate - elements[base + Field.EpochJd]) * 86400;

    const eccentricity = elements[base + Field.Eccentricity];
    const meanAnomaly = elements[base + Field.MeanAnomaly0] + elements[base + Field.MeanMotion] * secondsSinceEpoch;

    // Equation of the centre to second order. These orbits are near-circular
    // (e is typically ~1e-4), so this is far more accurate than it needs to be
    // and avoids iterating Kepler's equation ten thousand times a frame.
    const sinM = Math.sin(meanAnomaly);
    const cosM = Math.cos(meanAnomaly);
    const trueAnomaly = meanAnomaly + 2 * eccentricity * sinM + 1.25 * eccentricity * eccentricity * 2 * sinM * cosM;
    const radiusKm = elements[base + Field.SemiMajorAxis] * (1 - eccentricity * cosM);

    const raan = elements[base + Field.Raan0] + elements[base + Field.RaanDot] * secondsSinceEpoch;
    const argp = elements[base + Field.Argp0] + elements[base + Field.ArgpDot] * secondsSinceEpoch;
    const argumentOfLatitude = argp + trueAnomaly;

    const cosU = Math.cos(argumentOfLatitude);
    const sinU = Math.sin(argumentOfLatitude);
    const cosRaan = Math.cos(raan);
    const sinRaan = Math.sin(raan);
    const cosIncl = elements[base + Field.CosIncl];
    const sinIncl = elements[base + Field.SinIncl];

    // Perifocal -> ECI.
    const eciX = radiusKm * (cosRaan * cosU - sinRaan * sinU * cosIncl);
    const eciY = radiusKm * (sinRaan * cosU + cosRaan * sinU * cosIncl);
    const eciZ = radiusKm * (sinU * sinIncl);

    // ECI -> Earth-fixed by undoing Earth's rotation.
    const ecefX = eciX * cosTheta + eciY * sinTheta;
    const ecefY = -eciX * sinTheta + eciY * cosTheta;

    // Earth-fixed -> this scene's frame, where +X is (0N, 0E) and +Y is north.
    out[i * 3] = ecefX * unitsPerKm;
    out[i * 3 + 1] = eciZ * unitsPerKm;
    out[i * 3 + 2] = -ecefY * unitsPerKm;
  }
}
