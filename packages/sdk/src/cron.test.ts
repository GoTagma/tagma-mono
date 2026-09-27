import { describe, expect, test } from 'bun:test';
import { cronExpressionError, nextCronFire, parseCronExpression } from './cron';

// All expectations use local-time constructors and local getters so the
// suite passes in any host timezone. Weekday facts used below (verified):
//   2026-09-25 = Friday, 2026-09-26 = Saturday, 2026-09-28 = Monday
//   2026-10-02 = Friday, 2026-10-13 = Tuesday, 2028-02-29 = Tuesday (leap)

describe('parseCronExpression', () => {
  test('parses the wildcard schedule', () => {
    const schedule = parseCronExpression('* * * * *');
    expect(schedule.minutes).toHaveLength(60);
    expect(schedule.hours).toHaveLength(24);
    expect(schedule.daysOfMonth.size).toBe(31);
    expect(schedule.months.size).toBe(12);
    expect(schedule.daysOfWeek.size).toBe(7);
    expect(schedule.domRestricted).toBe(false);
    expect(schedule.dowRestricted).toBe(false);
  });

  test('parses the weekday-morning schedule from the monitoring scenario', () => {
    const schedule = parseCronExpression('0 8 * * 1-5');
    expect([...schedule.minutes]).toEqual([0]);
    expect([...schedule.hours]).toEqual([8]);
    expect(schedule.domRestricted).toBe(false);
    expect(schedule.dowRestricted).toBe(true);
    expect([...schedule.daysOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  test('parses steps over the wildcard', () => {
    expect([...parseCronExpression('*/15 * * * *').minutes]).toEqual([0, 15, 30, 45]);
  });

  test('parses stepped ranges', () => {
    expect([...parseCronExpression('0 9-17/2 * * *').hours]).toEqual([9, 11, 13, 15, 17]);
  });

  test('parses a stepped single value as value-to-max', () => {
    expect([...parseCronExpression('5/10 * * * *').minutes]).toEqual([5, 15, 25, 35, 45, 55]);
  });

  test('parses lists', () => {
    expect([...parseCronExpression('30 6,18 * * *').hours]).toEqual([6, 18]);
  });

  test('parses month names case-insensitively', () => {
    expect(parseCronExpression('0 0 1 JAN *').months.has(1)).toBe(true);
    expect(parseCronExpression('0 0 1 jan *').months.has(1)).toBe(true);
  });

  test('treats 0, 7, and SUN as Sunday', () => {
    for (const expr of ['0 0 * * 0', '0 0 * * 7', '0 0 * * SUN', '0 0 * * sun']) {
      const schedule = parseCronExpression(expr);
      expect([...schedule.daysOfWeek]).toEqual([0]);
    }
  });

  test('parses weekday name ranges', () => {
    const schedule = parseCronExpression('0 9 * * MON-FRI');
    expect([...schedule.daysOfWeek].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
  });

  test('marks a restricted day-of-month', () => {
    const schedule = parseCronExpression('0 0 1 * *');
    expect(schedule.domRestricted).toBe(true);
    expect(schedule.dowRestricted).toBe(false);
  });

  test('tolerates extra whitespace between fields', () => {
    const schedule = parseCronExpression('  0   8  *  *   1-5  ');
    expect([...schedule.hours]).toEqual([8]);
  });

  test('rejects a wrong field count', () => {
    expect(() => parseCronExpression('')).toThrow(/5 fields/);
    expect(() => parseCronExpression('0 8 * *')).toThrow(/5 fields/);
    expect(() => parseCronExpression('0 8 * * 1-5 extra')).toThrow(/5 fields/);
  });

  test('rejects out-of-range values', () => {
    expect(() => parseCronExpression('61 * * * *')).toThrow(/minute/);
    expect(() => parseCronExpression('* 24 * * *')).toThrow(/hour/);
    expect(() => parseCronExpression('* * 0 * *')).toThrow(/day-of-month/);
    expect(() => parseCronExpression('* * 32 * *')).toThrow(/day-of-month/);
    expect(() => parseCronExpression('* * * 0 *')).toThrow(/month/);
    expect(() => parseCronExpression('* * * 13 *')).toThrow(/month/);
    expect(() => parseCronExpression('* * * * 8')).toThrow(/day-of-week/);
  });

  test('rejects malformed field syntax', () => {
    expect(() => parseCronExpression('*/0 * * * *')).toThrow(/step/);
    expect(() => parseCronExpression('5-2 * * * *')).toThrow(/range/);
    expect(() => parseCronExpression('* * * FOO *')).toThrow(/month/);
    expect(() => parseCronExpression('1.5 * * * *')).toThrow(/minute/);
    expect(() => parseCronExpression('a-b * * * *')).toThrow(/minute/);
    expect(() => parseCronExpression('@daily')).toThrow(/5 fields/);
    expect(() => parseCronExpression('-5 * * * *')).toThrow(/minute/);
    expect(() => parseCronExpression('5- * * * *')).toThrow(/minute/);
  });
});

describe('nextCronFire', () => {
  test('every-minute schedule fires at the next minute boundary', () => {
    const from = new Date(2026, 8, 26, 12, 0, 30, 500);
    const fire = nextCronFire(parseCronExpression('* * * * *'), from);
    expect(fire).not.toBeNull();
    expect(fire!.getHours()).toBe(12);
    expect(fire!.getMinutes()).toBe(1);
    expect(fire!.getSeconds()).toBe(0);
    expect(fire!.getMilliseconds()).toBe(0);
    expect(fire!.getTime()).toBeGreaterThan(from.getTime());
  });

  test('an exact minute boundary counts as now', () => {
    const from = new Date(2026, 8, 26, 12, 0, 0, 0);
    const fire = nextCronFire(parseCronExpression('* * * * *'), from);
    expect(fire!.getTime()).toBe(from.getTime());
  });

  test('weekday cron waits over the weekend', () => {
    // Friday 09:00 → next weekday 08:00 is Monday.
    const from = new Date(2026, 8, 25, 9, 0);
    const fire = nextCronFire(parseCronExpression('0 8 * * 1-5'), from)!;
    expect(fire.getDay()).toBe(1);
    expect(fire.getFullYear()).toBe(2026);
    expect(fire.getMonth()).toBe(8);
    expect(fire.getDate()).toBe(28);
    expect(fire.getHours()).toBe(8);
    expect(fire.getMinutes()).toBe(0);
  });

  test('weekday cron fires the same morning before the tick', () => {
    const from = new Date(2026, 8, 28, 7, 59); // Monday 07:59
    const fire = nextCronFire(parseCronExpression('0 8 * * 1-5'), from)!;
    expect(fire.getDate()).toBe(28);
    expect(fire.getHours()).toBe(8);
  });

  test('leap-day schedule lands on 2028-02-29', () => {
    const fire = nextCronFire(parseCronExpression('0 0 29 2 *'), new Date(2026, 8, 26))!;
    expect(fire.getFullYear()).toBe(2028);
    expect(fire.getMonth()).toBe(1);
    expect(fire.getDate()).toBe(29);
  });

  test('leap-day schedule chains across the next cycle', () => {
    const fire = nextCronFire(parseCronExpression('0 0 29 2 *'), new Date(2028, 2, 1))!;
    expect(fire.getFullYear()).toBe(2032);
    expect(fire.getMonth()).toBe(1);
    expect(fire.getDate()).toBe(29);
  });

  test('an impossible schedule has no fire time', () => {
    expect(nextCronFire(parseCronExpression('0 0 31 2 *'), new Date(2026, 8, 26))).toBeNull();
  });

  test('day-of-month and day-of-week combine with OR semantics', () => {
    // From Saturday 2026-09-26: next Friday is 10-02, next 13th is 10-13.
    const fire = nextCronFire(parseCronExpression('0 0 13 * 5'), new Date(2026, 8, 26))!;
    expect(fire.getMonth()).toBe(9);
    expect(fire.getDate()).toBe(2);
    expect(fire.getDay()).toBe(5);
    // From Saturday 2026-10-10: next match is Tuesday 10-13 (before Friday 10-16).
    const later = nextCronFire(parseCronExpression('0 0 13 * 5'), new Date(2026, 9, 10))!;
    expect(later.getDate()).toBe(13);
    expect(later.getDay()).toBe(2);
  });

  test('day-of-month alone skips short months', () => {
    const fire = nextCronFire(parseCronExpression('0 0 31 * *'), new Date(2026, 1, 1))!;
    expect(fire.getMonth()).toBe(2);
    expect(fire.getDate()).toBe(31);
  });

  test('month lists cross the year boundary', () => {
    const fire = nextCronFire(parseCronExpression('0 0 1 1,6 *'), new Date(2026, 8, 26))!;
    expect(fire.getFullYear()).toBe(2027);
    expect(fire.getMonth()).toBe(0);
    expect(fire.getDate()).toBe(1);
  });

  test('weekday name lists pick the next matching weekday', () => {
    const fire = nextCronFire(
      parseCronExpression('0 9 * * MON,WED,FRI'),
      new Date(2026, 8, 26, 8, 0), // Saturday 08:00
    )!;
    expect(fire.getDay()).toBe(1);
    expect(fire.getDate()).toBe(28);
    expect(fire.getHours()).toBe(9);
  });

  test('minute steps fire at the next step', () => {
    const fire = nextCronFire(parseCronExpression('*/20 * * * *'), new Date(2026, 8, 26, 12, 7))!;
    expect(fire.getHours()).toBe(12);
    expect(fire.getMinutes()).toBe(20);
  });
});

describe('cronExpressionError', () => {
  test('returns null for a valid, firing expression', () => {
    expect(cronExpressionError('0 8 * * 1-5')).toBeNull();
  });

  test('reports a missing expression', () => {
    expect(cronExpressionError('')).toMatch(/required/);
    expect(cronExpressionError('   ')).toMatch(/required/);
  });

  test('reports a syntax error', () => {
    expect(cronExpressionError('0 8 * *')).toMatch(/5 fields/);
  });

  test('reports an expression that never fires', () => {
    expect(cronExpressionError('0 0 31 2 *')).toMatch(/no fire time within 5 years/);
  });
});
