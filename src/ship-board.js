import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { fileURLToPath } from 'node:url';
import { opponent, shipSunk, sunkCount, SHIP_ROWS, cellLabel } from './ship-game.js';

GlobalFonts.registerFromPath(fileURLToPath(new URL('../assets/DejaVuSans.ttf', import.meta.url)), 'ShipArabic');
const ink = '#eaf8ff', muted = '#96b7cb', blue = '#53c6f1', red = '#ff6878';
function text(ctx, value, x, y, size = 24, color = ink, width = 760) {
  ctx.fillStyle = color; ctx.font = `bold ${size}px ShipArabic`; ctx.textAlign = 'center';
  ctx.fillText(String(value), x, y, width);
}
function hull(ctx, ship, left, top, step, sunk) {
  const cx = left + (ship.col + ship.width / 2) * step, cy = top + (ship.row + ship.height / 2) * step;
  const length = Math.max(ship.width, ship.height) * step - 12, beam = Math.min(ship.width, ship.height) * step - 14;
  ctx.save(); ctx.translate(cx, cy); if (ship.height > ship.width) ctx.rotate(Math.PI / 2);
  const grad = ctx.createLinearGradient(0, -beam / 2, 0, beam / 2);
  grad.addColorStop(0, sunk ? '#895057' : '#bbcbd4'); grad.addColorStop(.5, sunk ? '#4e303c' : '#4d687c'); grad.addColorStop(1, sunk ? '#713743' : '#a7bfce');
  ctx.beginPath(); ctx.moveTo(-length / 2 + 8, -beam / 2); ctx.lineTo(length / 2 - beam * .45, -beam / 2);
  ctx.lineTo(length / 2, 0); ctx.lineTo(length / 2 - beam * .45, beam / 2);
  ctx.lineTo(-length / 2 + 8, beam / 2); ctx.quadraticCurveTo(-length / 2, 0, -length / 2 + 8, -beam / 2);
  ctx.fillStyle = grad; ctx.fill(); ctx.strokeStyle = sunk ? '#ff8994' : '#e3f5ff'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = sunk ? '#312531' : '#2c4557'; ctx.fillRect(-length * .25, -beam * .28, length * .48, beam * .56);
  if (ship.id === 0) {
    ctx.strokeStyle = '#d1e9f5'; ctx.lineWidth = 2; ctx.setLineDash([8, 5]);
    ctx.beginPath(); ctx.moveTo(-length * .38, 0); ctx.lineTo(length * .32, 0); ctx.stroke(); ctx.setLineDash([]);
    for (const x of [-length * .24, length * .06]) {
      ctx.fillStyle = '#dbeaf3'; ctx.beginPath(); ctx.moveTo(x + 17, 0); ctx.lineTo(x - 10, -beam * .26);
      ctx.lineTo(x - 4, 0); ctx.lineTo(x - 10, beam * .26); ctx.closePath(); ctx.fill();
    }
  } else {
    for (const x of [-length * .27, length * .25]) {
      ctx.fillStyle = '#829caf'; ctx.beginPath(); ctx.arc(x, 0, Math.min(beam * .26, 12), 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#d2e4ef'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x + 16, 0); ctx.stroke();
    }
  }
  ctx.restore();
}
function grid(ctx, g, owner, left, top, step, reveal, selected = null) {
  const fleet = g.fleets[owner] || [], shots = g.shots[opponent(g, owner)] || [];
  const span = step * 10;
  const gradient = ctx.createLinearGradient(left, top, left + span, top + span);
  gradient.addColorStop(0, '#153e58'); gradient.addColorStop(1, '#146279');
  ctx.fillStyle = gradient; ctx.fillRect(left, top, span, span);
  if (selected != null) { ctx.fillStyle = '#53c6f129'; ctx.fillRect(left, top + selected * step, span, step); }
  ctx.strokeStyle = '#8fcbdc55'; ctx.lineWidth = 1;
  for (let n = 0; n <= 10; n++) {
    ctx.beginPath(); ctx.moveTo(left + n * step, top); ctx.lineTo(left + n * step, top + span); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(left, top + n * step); ctx.lineTo(left + span, top + n * step); ctx.stroke();
    if (n < 10) {
      text(ctx, n + 1, left + (n + .5) * step, top - 14, Math.max(15, step * .28), muted);
      text(ctx, SHIP_ROWS[n], left - 24, top + (n + .63) * step, Math.max(15, step * .28), muted);
    }
  }
  for (const ship of fleet) if (reveal || shipSunk(ship, shots)) hull(ctx, ship, left, top, step, shipSunk(ship, shots));
  for (const cell of shots) {
    const x = left + (cell % 10 + .5) * step, y = top + (Math.floor(cell / 10) + .5) * step;
    const hit = fleet.some(ship => ship.cells.includes(cell)), r = step * .22;
    ctx.strokeStyle = hit ? '#ff685a' : '#d6edf3'; ctx.lineWidth = Math.max(2, step * .045); ctx.beginPath();
    if (hit) {
      ctx.arc(x, y, r, 0, Math.PI * 2); ctx.stroke(); ctx.beginPath();
      ctx.moveTo(x - r * 1.45, y); ctx.lineTo(x + r * 1.45, y); ctx.moveTo(x, y - r * 1.45); ctx.lineTo(x, y + r * 1.45);
    } else { ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r); ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r); }
    ctx.stroke();
  }
  if (g.lastShot?.by === opponent(g, owner)) {
    const cell = g.lastShot.cell; ctx.strokeStyle = '#ffd978'; ctx.lineWidth = 3;
    ctx.strokeRect(left + cell % 10 * step + 3, top + Math.floor(cell / 10) * step + 3, step - 6, step - 6);
  }
}
export function shipBoard(g, viewer = null) {
  if (viewer !== null && ![g.x, g.o].includes(viewer)) throw new Error('لوحة السفن لصاحبها فقط.');
  const canvas = createCanvas(840, 1040), ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, 840, 1040); bg.addColorStop(0, '#091d30'); bg.addColorStop(1, '#0b3544');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, 840, 1040);
  ctx.strokeStyle = '#33596c'; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(20, 20, 800, 1000, 22); ctx.stroke();
  text(ctx, 'سفينة', 420, 70, 38); text(ctx, viewer ? 'أسطولك الخاص • ظاهر لك وحدك' : 'معركة بحرية • 6 سفن لكل لاعب', 420, 108, 20, muted);
  for (const [id, x, color] of [[g.x, 235, blue], [g.o, 605, red]]) {
    text(ctx, (g.names?.[id] || 'لاعب').slice(0, 26), x, 157, 24, color, 330);
    const sank = sunkCount(g.fleets[opponent(g, id)], g.shots[id]);
    text(ctx, `أغرق ${sank} من 6`, x, 193, 21, muted);
  }
  const active = g.turn || g.x, owner = viewer || opponent(g, active);
  const label = viewer ? (g.phase === 'setup' ? 'رتّب أسطولك عشوائيًا ثم اضغط جاهز' : 'سفنك وضربات خصمك')
    : `منطقة ${(g.names?.[owner] || 'الخصم').slice(0, 24)}`;
  text(ctx, label, 420, 243, 23);
  grid(ctx, g, owner, 90, 290, 66, !!viewer, viewer ? null : g.selectedRow);
  const last = g.lastShot;
  text(ctx, viewer ? 'سفنك لا تظهر في اللوحة العامة إلا عند غرقها' : last
    ? `${cellLabel(last.cell)}  •  ${last.sunk !== null ? 'غرقت سفينة! دور إضافي' : last.hit ? 'إصابة! دور إضافي' : 'لم تُصب • انتقل الدور'}`
    : 'اختر حرف الصف ثم رقم العمود للهجوم', 420, 985, 20, muted);
  return canvas.toBuffer('image/png');
}
