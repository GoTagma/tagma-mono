// ═══ Cron schedule parsing (built-in `schedule` trigger) ═══
//
// Deliberately bounded dialect: exactly five fields
// (minute hour day-of-month month day-of-week), host local time.
// Supports `*`, lists (`,`), ranges (`-`), and steps (`/`), plus
// case-insensitive month (JAN-DEC) and weekday (SUN-SAT) names.
// A stepped single value (`5/10`) means value-to-max with that step.
// No seconds field, no `@daily`-style macros, no `L`/`W`/`#`/`?`
// extensions, and no timezone field.
//
// Day matching follows Vixie cron semantics: when BOTH day-of-month and
// day-of-week are restricted (not exactly `*`), a day matches when EITHER
// matches; otherwise both restrictions apply. A field written as `*/n`
// counts as restricted.

export interface CronSchedule {
  /** Sorted ascending, 0-59. */
  readonly minutes: readonly number[];
  /** Sorted ascending, 0-23. */
  readonly hours: readonly number[];
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  /** 0 = Sunday (input 7 is normalized to 0). */
  readonly daysOfWeek: ReadonlySet<number>;
  readonly domRestricted: boolean;
  readonly dowRestricted: boolean;
}

interface CronFieldSpec {
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly names?: Readonly<Record<string, number>>;
  /** Post-range-check normalization (day-of-week maps 7 to 0). */
  readonly normalize?: (value: number) => number;
}

const MONTH_NAMES: Readonly<Record<string, number>> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};

const WEEKDAY_NAMES: Readonly<Record<string, number>> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

const MINUTE_SPEC: CronFieldSpec = { label: 'minute', min: 0, max: 59 };
const HOUR_SPEC: CronFieldSpec = { label: 'hour', min: 0, max: 23 };
const DOM_SPEC: CronFieldSpec = { label: 'day-of-month', min: 1, max: 31 };
const MONTH_SPEC: CronFieldSpec = { label: 'month', min: 1, max: 12, names: MONTH_NAMES };
const DOW_SPEC: CronFieldSpec = {
  label: 'day-of-week',
  min: 0,
  max: 7,
  names: WEEKDAY_NAMES,
  normalize: (value) => (value === 7 ? 0 : value),
};

function resolveCronToken(token: string, spec: CronFieldSpec): number {
  const named = spec.names?.[token.toLowerCase()];
  if (named !== undefined) return named;
  if (!/^\d+$/.test(token)) {
    throw new Error(`invalid ${spec.label} value "${token}"`);
  }
  const value = Number(token);
  if (value < spec.min || value > spec.max) {
    throw new Error(`${spec.label} value "${token}" is out of range (${spec.min}-${spec.max})`);
  }
  return value;
}

function parseCronField(text: string, spec: CronFieldSpec): Set<number> {
  const values = new Set<number>();
  for (const item of text.split(',')) {
    if (item.length === 0) {
      throw new Error(`invalid ${spec.label} field "${text}": empty list item`);
    }
    const slashParts = item.split('/');
    if (slashParts.length > 2) {
      throw new Error(`invalid ${spec.label} field "${item}": too many "/"`);
    }
    const base = slashParts[0]!;
    let step = 1;
    if (slashParts.length === 2) {
      if (!/^\d+$/.test(slashParts[1]!) || Number(slashParts[1]) <= 0) {
        throw new Error(
          `invalid ${spec.label} step "${slashParts[1]}": step must be a positive integer`,
        );
      }
      step = Number(slashParts[1]);
    }

    let low: number;
    let high: number;
    if (base === '*') {
      low = spec.min;
      high = spec.max;
    } else if (base.includes('-')) {
      const rangeParts = base.split('-');
      if (rangeParts.length !== 2 || rangeParts[0] === '' || rangeParts[1] === '') {
        throw new Error(`invalid ${spec.label} range "${base}"`);
      }
      low = resolveCronToken(rangeParts[0]!, spec);
      high = resolveCronToken(rangeParts[1]!, spec);
      const normalizedLow = spec.normalize ? spec.normalize(low) : low;
      const normalizedHigh = spec.normalize ? spec.normalize(high) : high;
      if (normalizedLow > normalizedHigh) {
        throw new Error(`invalid ${spec.label} range "${base}": range start exceeds range end`);
      }
      low = normalizedLow;
      high = normalizedHigh;
    } else {
      low = resolveCronToken(base, spec);
      // `a/n` means a..max stepped by n (cronie semantics); plain `a` is one value.
      high = slashParts.length === 2 ? spec.max : low;
    }

    for (let value = low; value <= high; value += step) {
      values.add(spec.normalize ? spec.normalize(value) : value);
    }
  }
  if (values.size === 0) {
    throw new Error(`invalid ${spec.label} field "${text}": selects no values`);
  }
  return values;
}

/**
 * Parse a 5-field cron expression. Throws with a field-specific message on
 * any syntax or range problem; never returns a partial schedule.
 */
export function parseCronExpression(expression: string): CronSchedule {
  const fields = expression
    .trim()
    .split(/\s+/u)
    .filter((part) => part.length > 0);
  if (fields.length !== 5) {
    throw new Error(
      `cron expression must have exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length}`,
    );
  }
  const minutes = parseCronField(fields[0]!, MINUTE_SPEC);
  const hours = parseCronField(fields[1]!, HOUR_SPEC);
  const daysOfMonth = parseCronField(fields[2]!, DOM_SPEC);
  const months = parseCronField(fields[3]!, MONTH_SPEC);
  const daysOfWeek = parseCronField(fields[4]!, DOW_SPEC);
  return {
    minutes: [...minutes].sort((a, b) => a - b),
    hours: [...hours].sort((a, b) => a - b),
    daysOfMonth,
    months,
    daysOfWeek,
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

function dayMatches(schedule: CronSchedule, day: Date): boolean {
  const domMatch = schedule.daysOfMonth.has(day.getDate());
  const dowMatch = schedule.daysOfWeek.has(day.getDay());
  if (schedule.domRestricted && schedule.dowRestricted) return domMatch || dowMatch;
  if (schedule.domRestricted) return domMatch;
  if (schedule.dowRestricted) return dowMatch;
  return true;
}

// Five years of days cover the longest legitimate cadence (Feb 29) with
// margin; an expression with no fire time inside this horizon is a config
// error, not a schedule the trigger should wait for.
const CRON_HORIZON_DAYS = 366 * 5 + 2;

/**
 * Next local time matching `schedule`, at minute granularity. A `from`
 * exactly on a minute boundary counts as now; any sub-minute remainder
 * rounds up to the next minute. Returns null when nothing matches within
 * the 5-year horizon. Nonexistent local wall times (DST spring-forward
 * gaps) are skipped; ambiguous fall-back times fire on the first
 * occurrence.
 */
export function nextCronFire(schedule: CronSchedule, from: Date): Date | null {
  const firstMinute = new Date(from.getTime());
  if (firstMinute.getSeconds() !== 0 || firstMinute.getMilliseconds() !== 0) {
    firstMinute.setMinutes(firstMinute.getMinutes() + 1, 0, 0);
  }

  const day = new Date(firstMinute.getFullYear(), firstMinute.getMonth(), firstMinute.getDate());
  for (let offset = 0; offset <= CRON_HORIZON_DAYS; offset++) {
    if (schedule.months.has(day.getMonth() + 1) && dayMatches(schedule, day)) {
      for (const hour of schedule.hours) {
        if (offset === 0 && hour < firstMinute.getHours()) continue;
        for (const minute of schedule.minutes) {
          if (
            offset === 0 &&
            hour === firstMinute.getHours() &&
            minute < firstMinute.getMinutes()
          ) {
            continue;
          }
          const candidate = new Date(
            day.getFullYear(),
            day.getMonth(),
            day.getDate(),
            hour,
            minute,
            0,
            0,
          );
          // A DST spring-forward gap normalizes the requested wall time to a
          // different hour/minute; that wall time does not exist, so skip it.
          if (candidate.getHours() !== hour || candidate.getMinutes() !== minute) continue;
          // A DST fall-back fold can map an ambiguous wall time to its first
          // occurrence, which may precede `from`; never return the past.
          if (candidate.getTime() < firstMinute.getTime()) continue;
          return candidate;
        }
      }
    }
    day.setDate(day.getDate() + 1);
  }
  return null;
}

/**
 * Human-readable problem with a cron expression, or null when it parses and
 * fires at least once within the horizon. Used by edit-time validation;
 * `now` is injectable for deterministic tests.
 */
export function cronExpressionError(expression: string, now: Date = new Date()): string | null {
  if (expression.trim().length === 0) return 'cron expression is required';
  try {
    const schedule = parseCronExpression(expression);
    if (nextCronFire(schedule, now) === null) {
      return `cron "${expression}" has no fire time within 5 years`;
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
