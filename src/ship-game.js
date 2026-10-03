import { randomInt } from 'node:crypto';
import { XoGame, XO_TURN } from './xo.js';
import { StaleGameViewError } from './game-display.js';

export const SHIP_SIZE = 10;
export const SHIP_SETUP_MS = 120000;
export const SHIP_ROWS = 'ABCDEFGHIJ';
// Six ships from the reference: carrier 2x5, then 1x5, 1x4, 1x3, 1x2, 1x2.
export const SHIP_FLEET = Object.freeze([[2, 5], [1, 5], [1, 4], [1, 3], [1, 2], [1, 2]].map(Object.freeze));
const shuffled = values => {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]]; }
  return result;
};
const placements = SHIP_FLEET.map(([h, w], id) => {
  const options = [];
  for (const [height, width] of [[h, w], [w, h]]) {
    for (let row = 0; row <= SHIP_SIZE - height; row++) for (let col = 0; col <= SHIP_SIZE - width; col++) {
      const cells = [];
      for (let r = row; r < row + height; r++) for (let c = col; c < col + width; c++) cells.push(r * SHIP_SIZE + c);
      options.push({ id, row, col, height, width, cells });
    }
  }
  return options;
});
export function randomFleet() {
  // Randomized backtracking over all legal positions, never a catalogue of layouts.
  // A one-cell sea border between ships makes their silhouettes easy to read.
  const place = (id, blocked) => {
    if (id === SHIP_FLEET.length) return [];
    for (const ship of shuffled(placements[id])) {
      if (ship.cells.some(cell => blocked.has(cell))) continue;
      const next = new Set(blocked);
      for (let r = Math.max(0, ship.row - 1); r <= Math.min(9, ship.row + ship.height); r++) {
        for (let c = Math.max(0, ship.col - 1); c <= Math.min(9, ship.col + ship.width); c++) next.add(r * 10 + c);
      }
      const rest = place(id + 1, next);
      if (rest) return [{ ...ship, cells: [...ship.cells] }, ...rest];
    }
    return null;
  };
  const fleet = place(0, new Set());
  if (!fleet) throw new Error('تعذر توزيع السفن؛ اضغط عشوائي مجددًا.');
  return fleet;
}
export const opponent = (g, id) => id === g.x ? g.o : g.x;
export const shipSunk = (ship, shots) => ship.cells.every(cell => shots.includes(cell));
export const sunkCount = (fleet = [], shots = []) => fleet.filter(ship => shipSunk(ship, shots)).length;
export const cellLabel = cell => `${SHIP_ROWS[Math.floor(cell / 10)]}${cell % 10 + 1}`;
export function fireShot(fleet, shots, cell) {
  if (!Number.isInteger(cell) || cell < 0 || cell >= 100) throw new Error('اختر خانة صحيحة من A1 إلى J10.');
  if (shots.includes(cell)) throw new Error('هاجمت هذه الخانة من قبل؛ اختر خانة أخرى.');
  const next = [...shots, cell], ship = fleet.find(s => s.cells.includes(cell));
  return { shots: next, hit: !!ship, sunk: ship && shipSunk(ship, next) ? ship.id : null,
    won: fleet.length === SHIP_FLEET.length && fleet.every(s => shipSunk(s, next)) };
}

export class ShipGame extends XoGame {
  get prefix() { return 'ship'; }
  get name() { return 'سفينة'; }
  initial() { return { phase: 'invite', fleets: {}, shots: {}, ready: {}, layoutRevision: {}, selectedRow: null, lastShot: null }; }
  accepted(g, holds, now) {
    return { ...super.accepted(g, holds, now), phase: 'setup', expiresAt: now + SHIP_SETUP_MS,
      fleets: { [g.x]: randomFleet(), [g.o]: randomFleet() }, shots: { [g.x]: [], [g.o]: [] },
      ready: { [g.x]: false, [g.o]: false }, layoutRevision: { [g.x]: 0, [g.o]: 0 } };
  }
  timeout(g) {
    // No one loses a stake before both players are ready, or on a failed delivery.
    if (g.phase === 'setup') return this.finish(g, 'cancelled', null, 'setup-timeout');
    return super.timeout(g);
  }
  async act(input, eligible) {
    if (['accept', 'reject'].includes(input.move)) return super.act(input, eligible);
    eligible = await this.members(input, eligible);
    return this.run(async () => {
      const g = await this.get(input.id), who = input.userId;
      if (!g || g.channelId !== input.channelId || ![g.x, g.o].includes(who)) throw new Error('هذه اللعبة مخصصة للطرفين فقط.');
      if (!['pending', 'active'].includes(g.status)) return g;
      const bank = (await this.store.settings())?.bank;
      if (bank?.channelId !== g.channelId || bank.channelVersion !== g.bankVersion
        || [g.x, g.o].some(id => g.createdAt <= this.service.bankCutoff(id))) return this.finish(g, 'cancelled', null, 'settings');
      if (!await eligible(g.x) || !await eligible(g.o)) return this.finish(g, 'cancelled', null, 'membership');
      if (g.expiresAt <= this.service.clock()) return this.timeout(g);
      if (g.status !== 'active') throw new Error('انتظر قبول التحدّي لفتح أسطولك.');
      if (input.move === 'own') return g;
      if (['random', 'ready'].includes(input.move)) {
        if (g.phase !== 'setup' || g.ready[who]) throw new Error('تم تثبيت أسطولك؛ لا يمكن تغيير التوزيع بعد الجاهزية.');
        // Each player has their own version: the opponent's shuffle cannot stale this panel.
        if (input.layoutRevision !== g.layoutRevision[who]) throw new StaleGameViewError(g);
        if (input.move === 'random') return this.commit({ ...g, fleets: { ...g.fleets, [who]: randomFleet() },
          layoutRevision: { ...g.layoutRevision, [who]: g.layoutRevision[who] + 1 } });
        const next = { ...g, ready: { ...g.ready, [who]: true } };
        if (next.ready[g.x] && next.ready[g.o]) Object.assign(next, {
          phase: 'battle', turn: randomInt(2) ? g.x : g.o, selectedRow: null, expiresAt: this.service.clock() + XO_TURN
        });
        return this.commit(next);
      }
      if (g.phase !== 'battle') throw new Error('يبدأ الهجوم بعد ضغط الطرفين على جاهز.');
      if (input.revision !== g.revision || (g.dirty && g.requireDelivery)) throw new StaleGameViewError(g);
      if (g.turn !== who) throw new Error('ليس دورك الآن.');
      if (/^row:[A-J]$/.test(input.move)) {
        const row = SHIP_ROWS.indexOf(input.move.slice(4));
        if (Array.from({ length: 10 }, (_, col) => row * 10 + col).every(cell => g.shots[who].includes(cell))) throw new Error('كل خانات هذا الصف مهاجمة؛ اختر صفًا آخر.');
        if (g.selectedRow === row) return g;
        // Choosing or changing a row is navigation, not an attack, and grants no extra time.
        return this.commit({ ...g, selectedRow: row });
      }
      if (!/^fire:(?:[0-9]|[1-9][0-9])$/.test(input.move)) throw new Error('اختر الصف ثم رقم العمود من الرسالة الأساسية.');
      const cell = Number(input.move.slice(5));
      if (g.selectedRow !== Math.floor(cell / 10)) throw new StaleGameViewError(g);
      const result = fireShot(g.fleets[opponent(g, who)], g.shots[who], cell);
      const next = { ...g, shots: { ...g.shots, [who]: result.shots },
        lastShot: { by: who, cell, hit: result.hit, sunk: result.sunk }, selectedRow: null,
        turn: result.hit ? who : opponent(g, who), expiresAt: this.service.clock() + XO_TURN };
      return result.won ? this.finish(next, 'won', who) : this.commit(next);
    });
  }
}
