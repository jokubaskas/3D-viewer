// Vienetai, mastelis ir skaičių formatavimas (lietuviška lokalė)

export const TO_METERS = { m: 1, cm: 0.01, mm: 0.001, km: 1000, ft: 0.3048, in: 0.0254 };

/**
 * Formatuotojas: modelio vienetai -> rodomi vienetai.
 * factor = modelio vieneto ilgis metrais * kalibravimo koeficientas.
 */
export class Units {
  constructor() {
    this.modelUnit = 'm';
    this.calibration = 1;
    this.display = 'm';
    this.precision = 2;
    this._fmtCache = new Map();
  }

  /** Kiek metrų sudaro vienas modelio (pasaulio) vienetas. */
  get metersPerUnit() {
    return TO_METERS[this.modelUnit] * this.calibration;
  }

  /** Modelio ilgis -> rodomi vienetai. */
  len(v) {
    return (v * this.metersPerUnit) / TO_METERS[this.display];
  }
  area(v) {
    const f = this.metersPerUnit / TO_METERS[this.display];
    return v * f * f;
  }
  vol(v) {
    const f = this.metersPerUnit / TO_METERS[this.display];
    return v * f * f * f;
  }
  /** Ilgis be kalibravimo (absoliučioms koordinatėms). */
  lenRaw(v) {
    return (v * TO_METERS[this.modelUnit]) / TO_METERS[this.display];
  }
  /** Skaičius jau rodomais vienetais. */
  fmtDisp(v, digits) {
    return `${this.num(v, digits)} ${this.display}`;
  }
  /** Rodomi vienetai -> modelio ilgis. */
  fromDisplayLen(v) {
    return (v * TO_METERS[this.display]) / this.metersPerUnit;
  }
  toMeters(v) {
    return v * this.metersPerUnit;
  }
  toCubicMeters(v) {
    const f = this.metersPerUnit;
    return v * f * f * f;
  }
  toSquareMeters(v) {
    const f = this.metersPerUnit;
    return v * f * f;
  }

  num(v, digits = this.precision) {
    if (v == null || !isFinite(v)) return '—';
    const key = digits;
    let f = this._fmtCache.get(key);
    if (!f) {
      f = new Intl.NumberFormat('lt-LT', { minimumFractionDigits: digits, maximumFractionDigits: digits });
      this._fmtCache.set(key, f);
    }
    return f.format(Math.abs(v) < 0.5 * 10 ** -digits ? 0 : v);
  }

  fmtLen(v, digits) {
    return `${this.num(this.len(v), digits)} ${this.display}`;
  }
  fmtArea(v, digits) {
    return `${this.num(this.area(v), digits)} ${this.display}²`;
  }
  fmtVol(v, digits) {
    return `${this.num(this.vol(v), digits)} ${this.display}³`;
  }
  /** Papildomas ploto užrašas hektarais, kai plotas didelis. */
  fmtHectares(v) {
    const m2 = this.toSquareMeters(v);
    return `${this.num(m2 / 10000, 4)} ha`;
  }
  fmtAngle(rad) {
    return `${this.num((rad * 180) / Math.PI, Math.max(1, this.precision - 1))}°`;
  }
  fmtPercent(v) {
    return `${this.num(v, 1)} %`;
  }
}

export const units = new Units();
