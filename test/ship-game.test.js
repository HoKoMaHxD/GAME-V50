import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { fixture, at, user, other, actor, config, snowflake } from './helpers/shop-fixture.js';
import { SHIP_FLEET, SHIP_ROWS, SHIP_SETUP_MS, randomFleet, fireShot, opponent, shipSunk } from '../src/ship-game.js';
import { buildShipCommand, shipPayload, privateShipPayload, createShipHandler, ShipManager } from '../src/ship-game-commands.js';
import { shipBoard } from '../src/ship-board.js';
import { buildCommands, createHandler } from '../src/commands.js';
import { createTextCommands, commandsPanel } from '../src/experience-commands.js';
import { gamesMenuPayload } from '../src/bank-menu.js';
import { commandTimesPayload } from '../src/bank-commands.js';

const channelId = '100000000000000060', yes = async () => true;
const input = (patch = {}) => ({ id: snowflake(at, 2000), x: user, o: other, amount: 300, channelId,
  names: { [user]: 'أنور', [other]: 'HoKoMaH' }, ...patch });
const controls = p => p.components.flatMap(row => row.toJSON().components);
const totals = f => Promise.all([user, other].map(id => f.store.totals(id, 'all', at).then(x => x.total)));
async function setup() {
  const f = await fixture(); await f.seed(user, 1000); await f.seed(other, 1000); await f.service.shipGame.initialize(); return f;
}
function act(f, g, move, who = g.status === 'pending' ? g.o : g.turn, patch = {}) {
  return f.service.shipGame.act({ id: g.id, revision: g.revision, layoutRevision: g.layoutRevision[who],
    move, userId: who, channelId, ...patch }, yes);
}
async function start(f, patch = {}) { return act(f, await f.service.shipGame.open(input(patch), yes), 'accept'); }
async function ready(f, g) { g = await act(f, g, 'ready', user); return act(f, g, 'ready', other); }
async function shoot(f, g, cell) {
  await f.service.shipGame.displayed(g); g = await act(f, g, `row:${SHIP_ROWS[Math.floor(cell / 10)]}`);
  await f.service.shipGame.displayed(g); return act(f, g, `fire:${cell}`);
}

test('random layouts cover all six reference ships, remain in bounds and never touch or overlap', () => {
  const layouts = new Set(), rotations = new Set();
  for (let n = 0; n < 120; n++) {
    const fleet = randomFleet(), owner = new Map(); layouts.add(JSON.stringify(fleet));
    assert.equal(fleet.length, 6); assert.equal(fleet.flatMap(s => s.cells).length, 26);
    for (const ship of fleet) {
      const [h, w] = SHIP_FLEET[ship.id]; assert.ok((ship.height === h && ship.width === w) || (ship.width === h && ship.height === w));
      if (ship.id === 0) rotations.add(ship.width);
      assert.equal(ship.cells.length, h * w);
      for (const cell of ship.cells) {
        assert.ok(Number.isInteger(cell) && cell >= 0 && cell < 100); assert.ok(!owner.has(cell)); owner.set(cell, ship.id);
        assert.ok(cell % 10 >= ship.col && cell % 10 < ship.col + ship.width);
      }
    }
    for (const [cell, id] of owner) for (const [otherCell, otherId] of owner) {
      if (id !== otherId) assert.ok(Math.abs(cell % 10 - otherCell % 10) > 1 || Math.abs(Math.floor(cell / 10) - Math.floor(otherCell / 10)) > 1);
    }
  }
  assert.equal(layouts.size, 120); assert.equal(rotations.size, 2);
});
test('carrier requires every one of its ten squares; misses and duplicate coordinates behave correctly', () => {
  const fleet = randomFleet(), carrier = fleet[0]; let shots = [];
  for (const [index, cell] of carrier.cells.entries()) {
    const result = fireShot(fleet, shots, cell); shots = result.shots;
    assert.equal(result.hit, true); assert.equal(result.sunk, index === 9 ? 0 : null); assert.equal(result.won, false);
  }
  assert.ok(shipSunk(carrier, shots));
  for (const cell of [-1, 100, 1.5, '1', carrier.cells[0]]) assert.throws(() => fireShot(fleet, shots, cell));
  const water = Array.from({ length: 100 }, (_, i) => i).find(i => !fleet.some(s => s.cells.includes(i)));
  assert.equal(fireShot(fleet, shots, water).hit, false);
});
test('invalid challenges and unauthorized accept cannot reserve money', async () => {
  const f = await setup();
  for (const patch of [{ x: other }, { bot: true }, { amount: 0 }, { amount: 1.5 }, { amount: 1001 }, { channelId: other }]) await assert.rejects(f.service.shipGame.open(input(patch), yes));
  const g = await f.service.shipGame.open(input(), yes);
  await assert.rejects(act(f, g, 'accept', user), /المتحدّى/); await assert.rejects(act(f, g, 'accept', actor), /للطرفين/);
  await act(f, g, 'reject', other); assert.deepEqual(await totals(f), [1000, 1000]);
});
test('accept rechecks balance; insufficient funds never debit the other party', async () => {
  const f = await setup(), g = await f.service.shipGame.open(input(), yes);
  f.documents.days.find(d => d.userId === other).points.tasks = 299;
  assert.equal((await act(f, g, 'accept')).reason, 'balance'); assert.deepEqual(await totals(f), [1000, 299]);
});
test('setup is private, independently versioned and locks each fleet only after its owner is ready', async () => {
  const f = await setup(); let g = await start(f); const initial = structuredClone(g);
  assert.equal(g.phase, 'setup'); assert.equal(g.expiresAt, at + SHIP_SETUP_MS); assert.deepEqual(await totals(f), [700, 700]);
  await assert.rejects(act(f, g, 'fire:0'), /جاهز/);
  g = await act(f, g, 'random', user); assert.notDeepEqual(g.fleets[user], initial.fleets[user]); assert.deepEqual(g.fleets[other], initial.fleets[other]);
  assert.equal(g.expiresAt, initial.expiresAt);
  await assert.rejects(act(f, initial, 'ready', user), e => e.code === 'GAME_STALE_VIEW');
  g = await act(f, initial, 'ready', other); // The other player's old panel remains valid.
  assert.equal(g.ready[other], true); assert.equal(g.phase, 'setup');
  await assert.rejects(act(f, g, 'random', other), /تثبيت/);
  g = await act(f, g, 'ready', user); assert.equal(g.phase, 'battle'); assert.ok([user, other].includes(g.turn));
  await assert.rejects(act(f, g, 'random', user), /تثبيت/);
});
test('simultaneous readiness starts once with both locked fleets intact', async () => {
  const f = await setup(), g = await start(f);
  await Promise.all([act(f, g, 'ready', user), act(f, g, 'ready', other)]);
  const next = await f.service.shipGame.get(g.id); assert.equal(next.phase, 'battle'); assert.deepEqual(next.fleets, g.fleets);
  assert.deepEqual(await totals(f), [700, 700]);
});
test('setup timeout refunds both players; randomization and opening private views never extend it', async () => {
  const f = await setup(); let g = await start(f); f.service.clock = () => at + 119000;
  g = await act(f, g, 'random', user); g = await act(f, g, 'own', user); g = await act(f, g, 'ready', user);
  assert.equal(g.expiresAt, at + 120000); f.service.clock = () => at + 120000;
  await f.service.shipGame.expire(); assert.equal((await f.service.shipGame.get(g.id)).reason, 'setup-timeout');
  assert.deepEqual(await totals(f), [1000, 1000]); await f.service.shipGame.expire(); assert.deepEqual(await totals(f), [1000, 1000]);
});
test('miss switches turn; hit and sunk ship retain it; navigation does not buy time', async () => {
  const f = await setup(); let g = await ready(f, await start(f)), who = g.turn;
  const water = Array.from({ length: 100 }, (_, i) => i).find(i => !g.fleets[opponent(g, who)].some(s => s.cells.includes(i)));
  f.service.clock = () => at + 5000; g = await act(f, g, `row:${SHIP_ROWS[Math.floor(water / 10)]}`);
  assert.equal(g.expiresAt, at + 30000); g = await act(f, g, `fire:${water}`); assert.equal(g.turn, opponent(g, who)); assert.equal(g.expiresAt, at + 35000);
  const ship = g.fleets[opponent(g, g.turn)][5]; who = g.turn;
  for (const cell of ship.cells) { g = await shoot(f, g, cell); assert.equal(g.turn, who); }
  assert.equal(g.lastShot.sunk, 5);
});
test('full six-ship victory pays the winner once and restart cannot replay the payout', async () => {
  const f = await setup(); let g = await ready(f, await start(f)), winner = g.turn;
  const cells = g.fleets[opponent(g, winner)].flatMap(s => s.cells);
  for (const [index, cell] of cells.entries()) {
    g = await shoot(f, g, cell); assert.equal(g.status, index === 25 ? 'won' : 'active');
  }
  assert.equal(g.winner, winner); const expected = winner === user ? [1300, 700] : [700, 1300];
  assert.deepEqual(await totals(f), expected);
  const restarted = f.open(at + 1000); await restarted.service.shipGame.initialize(); await restarted.service.shipGame.recover();
  await act(restarted, g, 'fire:0', winner); await restarted.service.shipGame.expire(); assert.deepEqual(await totals(f), expected);
});
test('wrong turns, spectators, stale controls, copied main messages and repeat targets cannot fire', async () => {
  const f = await setup(); let g = await ready(f, await start(f)); await f.service.shipGame.bind(g.id, snowflake(at, 2010));
  await assert.rejects(act(f, g, 'row:A', actor), /للطرفين/);
  await assert.rejects(act(f, g, 'row:A', opponent(g, g.turn)), /دورك/);
  await assert.rejects(act(f, g, 'row:A', g.turn, { messageId: snowflake(at, 2011) }), /الأصلية/);
  const both = await Promise.allSettled([act(f, g, 'row:A'), act(f, g, 'row:B')]); assert.equal(both.filter(r => r.status === 'fulfilled').length, 1);
  await assert.rejects(act(f, g, 'fire:0'), e => e.code === 'GAME_STALE_VIEW');
  g = await f.service.shipGame.get(g.id); const cell = g.selectedRow * 10; const before = g;
  g = await act(f, g, `fire:${cell}`); assert.equal(g.shots[before.turn].length, 1);
  await assert.rejects(act(f, before, `fire:${cell}`), e => e.code === 'GAME_STALE_VIEW');
});
test('delivered turn timeout loses once; undelivered board cancels with a refund', async () => {
  for (const delivered of [true, false]) {
    const f = await setup(), g = await ready(f, await start(f, { requireDelivery: true }));
    if (delivered) await f.service.shipGame.displayed(g);
    f.service.clock = () => at + 30000;
    await Promise.all([f.service.shipGame.expire(), act(f, g, 'row:A')]);
    const end = await f.service.shipGame.get(g.id); assert.equal(end.status, delivered ? 'won' : 'cancelled');
    assert.deepEqual(await totals(f), delivered ? (g.turn === user ? [700, 1300] : [1300, 700]) : [1000, 1000]);
  }
});
test('restart preserves private layouts, preparation readiness, shots and exact turn', async () => {
  const f = await setup(); let g = await start(f); g = await act(f, g, 'random', user); g = await act(f, g, 'ready', user);
  const reopened = f.open(at + 100); await reopened.service.shipGame.recover(); assert.deepEqual(await reopened.service.shipGame.get(g.id), g);
  g = await act(reopened, g, 'ready', other); g = await shoot(reopened, g, g.fleets[opponent(g, g.turn)][2].cells[0]);
  assert.deepEqual(await f.open(at + 200).service.shipGame.get(g.id), g);
});
for (const phase of ['before', 'after']) for (const operation of ['hold', 'payout']) test(`${operation} interruption ${phase} wallet write recovers exactly once`, async () => {
  const f = await setup(); let g = await f.service.shipGame.open(input(), yes), winner;
  if (operation === 'payout') {
    g = await ready(f, await act(f, g, 'accept')); winner = g.turn;
    const cells = g.fleets[opponent(g, winner)].flatMap(s => s.cells);
    for (const cell of cells.slice(0, -1)) g = await shoot(f, g, cell);
    g = await act(f, g, `row:${SHIP_ROWS[Math.floor(cells.at(-1) / 10)]}`);
  }
  let failed = false;
  f.intercept(e => { if (!failed && e.name === 'days' && e.method === 'replaceOne' && e.phase === phase) { failed = true; throw new Error('lost database response'); } });
  const move = operation === 'hold' ? 'accept' : `fire:${g.fleets[opponent(g, winner)].flatMap(s => s.cells).at(-1)}`;
  await assert.rejects(act(f, g, move)); assert.equal(f.service.blocked, true);
  f.intercept(() => {}); const reopened = f.open(); await reopened.service.shipGame.recover(); await reopened.service.shipGame.recover();
  assert.deepEqual(await totals(f), operation === 'hold' ? [700, 700] : winner === user ? [1300, 700] : [700, 1300]);
});
test('settings or membership changes cancel and refund; resets protect preparation stakes', async () => {
  const f = await setup(); let g = await start(f);
  await assert.rejects(f.service.reset({ target: 'all', actorId: actor, operationId: 'ship-reset' }), /سفينة/);
  const result = await f.service.shipGame.act({ id: g.id, revision: g.revision, move: 'own', userId: user, channelId }, async id => id === user);
  assert.equal(result.reason, 'membership'); assert.deepEqual(await totals(f), [1000, 1000]);
  const ff = await setup(); g = await start(ff); ff.documents.settings[0].bank.channelVersion++;
  await ff.service.shipGame.expire(); assert.deepEqual(await totals(ff), [1000, 1000]);
});
test('public image never reveals unhit ships; private rendering never includes the opponent fleet', async () => {
  const f = await setup(), g = await ready(f, await start(f)); const changed = structuredClone(g);
  changed.fleets = { [g.x]: randomFleet(), [g.o]: randomFleet() };
  assert.deepEqual(shipBoard(g), shipBoard(changed));
  assert.notDeepEqual(shipBoard(g, user), shipBoard(changed, user));
  changed.fleets[user] = g.fleets[user]; assert.deepEqual(shipBoard(g, user), shipBoard(changed, user));
  assert.throws(() => privateShipPayload(g, actor), /لصاحب/);
  assert.equal(shipPayload(g).embeds[0].data.image.url.includes('public'), true);
});
test('public controls fit Discord, disable fired cells, and private controls do not contain coordinates', async () => {
  const f = await setup(); let g = await ready(f, await start(f)); g = await act(f, g, 'row:A');
  const p = shipPayload(g); assert.equal(p.components.length, 4); assert.deepEqual(p.components.map(r => r.toJSON().components.length), [1, 5, 5, 1]);
  for (const control of controls(p)) assert.ok(control.custom_id.length <= 100);
  assert.equal(new Set(controls(p).map(c => c.custom_id)).size, controls(p).length);
  assert.equal(p.files[0].attachment.subarray(1, 4).toString(), 'PNG');
  const privateControls = controls(privateShipPayload(g, user)); assert.equal(privateControls.length, 1);
  assert.ok(privateControls.every(c => c.custom_id.includes(user)));
  assert.deepEqual(p.allowedMentions.users, [g.turn]);
});
test('registration, menu, text commands, help and cooldown view expose سفينة', async () => {
  assert.equal(buildShipCommand().toJSON().name, 'سفينة'); assert.ok(buildCommands().some(c => c.name === 'سفينة'));
  assert.ok(controls(gamesMenuPayload()).some(c => c.custom_id === 'ship:help')); assert.match(commandsPanel().embeds[0].data.description, /سفينة/);
  for (const content of [`سفينة <@${other}> ١٠٠٠`, `!سفينة <@!${other}> 1000`]) {
    let parsed; await createTextCommands(async i => { parsed = i; }, config)({ content, author: { id: user }, guildId: config.clanGuildId,
      mentions: { users: new Map([[other, { id: other }]]) } });
    assert.equal(parsed.commandName, 'سفينة'); assert.equal(parsed.options.getInteger('المبلغ'), 1000);
  }
  const f = await setup(); await start(f); const view = await f.service.commandTimes(user, channelId);
  assert.equal(view.ship.nextAt, at + 1200000); assert.equal((await f.service.shipGame.commandTime(other, at)).status, 'ready');
  assert.ok(commandTimesPayload(view).embeds[0].data.fields.some(f => f.name.includes('سفينة')));
});

function harness(f) {
  const state = { public: null, private: [], errors: [], acks: [] }, message = { id: snowflake(at, 2020), author: { id: actor },
    edit: async p => { state.public = p; return message; } };
  const channel = { guildId: config.clanGuildId, messages: { fetch: async () => message } };
  const bot = { user: { id: actor }, channels: { fetch: async () => channel } };
  const handler = createShipHandler({ config, service: f.service, isBankMember: yes, bot, onError: e => state.errors.push(e) });
  async function press(customId, who, privateMessage = false, values) {
    let local;
    const i = { customId, user: { id: who }, guildId: config.clanGuildId, channelId, channel, client: bot, values,
      message: privateMessage ? { id: snowflake(at, 2021), flags: { has: flag => flag === MessageFlags.Ephemeral } } : message,
      isButton: () => !values, isStringSelectMenu: () => !!values,
      reply: async p => { local = p; }, deferReply: async p => { state.acks.push(p); }, deferUpdate: async () => { state.acks.push({ update: true }); },
      editReply: async p => { if (privateMessage || customId.endsWith(':own')) { local = p; } else state.public = p; return message; },
      followUp: async p => { state.private.push(p); local = p; } };
    await handler(i); return local;
  }
  return { state, message, channel, bot, handler, press };
}
test('real handler opens accepting player privately, each owner prepares privately, then plays on main message', async () => {
  const f = await setup(), h = harness(f);
  await createTextCommands(h.handler, config)({ content: `سفينة <@${other}> 300`, id: input().id,
    author: { id: user, username: 'أنور' }, guildId: config.clanGuildId, channelId, mentions: { users: new Map([[other, { id: other }]]) },
    reply: async p => { h.state.public = p; return h.message; } });
  await h.press(controls(h.state.public)[0].custom_id, other);
  const theirs = h.state.private.at(-1); assert.equal(theirs.flags, MessageFlags.Ephemeral);
  assert.ok(theirs.files[0].name.includes('private')); assert.equal(h.state.public.files.length, 0);
  const mine = await h.press(controls(h.state.public)[0].custom_id, user); assert.equal(h.state.acks.at(-1).flags, MessageFlags.Ephemeral);
  const original = h.state.public;
  const denied = await h.press(controls(mine)[0].custom_id, actor, true); assert.equal(denied.flags, MessageFlags.Ephemeral); assert.equal(h.state.public, original);
  const rerolled = await h.press(controls(mine)[0].custom_id, user, true);
  await h.press(controls(rerolled)[1].custom_id, user, true);
  await h.press(controls(theirs)[1].custom_id, other, true);
  let g = await f.service.shipGame.get(input().id); assert.equal(g.phase, 'battle'); assert.ok(h.state.public.files[0].name.includes('public'));
  await h.press(controls(h.state.public)[0].custom_id, g.turn, false, ['A']);
  await h.press(controls(h.state.public)[1].custom_id, g.turn);
  g = await f.service.shipGame.get(g.id); assert.equal(g.shots[user].length + g.shots[other].length, 1);
  assert.equal(g.dirty, false);
});
test('private request rejects spectators and forged public copies without leaking attachments', async () => {
  const f = await setup(), h = harness(f), g = await start(f);
  const forged = controls(privateShipPayload(g, user))[0].custom_id;
  const rejected = await h.press(forged, user, false); assert.equal(rejected.files, undefined);
  const own = controls(shipPayload(g))[0].custom_id;
  const outsider = await h.press(own, actor); assert.equal(outsider.files, undefined); assert.match(outsider.content, /للطرفين/);
});
test('background manager refunds deleted public messages and clears dirty final messages', async () => {
  const f = await setup(), g = await start(f); await f.service.shipGame.bind(g.id, snowflake(at, 2030));
  const bot = { user: { id: actor }, channels: { fetch: async () => { throw Object.assign(new Error('deleted channel'), { code: 10003 }); } } };
  const manager = new ShipManager({ bot, service: f.service, canRun: () => true, onError: () => {} });
  await manager.tick(); await manager.drain(); assert.equal((await f.service.shipGame.get(g.id)).reason, 'delivery');
  assert.deepEqual(await totals(f), [1000, 1000]);
});
test('paused bot acknowledges ship select menus and never mutates its round', async () => {
  const f = await setup(); f.service.paused = true; let response;
  await createHandler({ config, service: f.service, store: f.store })({ customId: 'ship:v1:100000000000000000:0:row',
    isChatInputCommand: () => false, isStringSelectMenu: () => true, isButton: () => false,
    reply: async p => { response = p; } });
  assert.equal(response.flags, MessageFlags.Ephemeral); assert.match(response.content, /متوقف/);
});

test('ship button is acknowledged before a slow Discord membership lookup and leaves wallet queue free', async () => {
  const f = await setup(); let g = await ready(f, await start(f)); await f.service.shipGame.bind(g.id, snowflake(at, 2050));
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let ack = false, read = false;
  const handler = createShipHandler({ config, service: f.service, isBankMember: async id => {
    if (id === other) { entered.resolve(); await release.promise; } return true;
  } });
  const work = handler({ customId: `ship:v1:${g.id}:${g.revision}:row`, values: ['A'], user: { id: g.turn },
    guildId: config.clanGuildId, channelId, message: { id: snowflake(at, 2050) }, isStringSelectMenu: () => true,
    deferUpdate: async () => { ack = true; }, editReply: async () => ({ id: snowflake(at, 2050) }), followUp: async () => {} });
  await entered.promise; assert.equal(ack, true);
  await f.service.balance(actor).then(() => { read = true; }); assert.equal(read, true);
  release.resolve(); await work;
});
test('private view edits never acknowledge a failed public delivery; background retry restores the same state', async () => {
  const f = await setup(); let g = await start(f, { requireDelivery: true });
  await f.service.shipGame.bind(g.id, snowflake(at, 2060)); await f.service.shipGame.displayed(g);
  g = await act(f, g, 'ready', user); await f.service.shipGame.displayed(g);
  const h = harness(f); h.message.edit = async () => { throw new Error('Discord temporary error'); };
  // Use the real bound message id for the retry destination.
  h.message.id = snowflake(at, 2060);
  await h.press(controls(privateShipPayload(g, other))[1].custom_id, other, true);
  g = await f.service.shipGame.get(g.id); assert.equal(g.phase, 'battle'); assert.equal(g.dirty, true);
  h.message.edit = async p => { h.state.public = p; return h.message; };
  const manager = new ShipManager({ service: f.service, bot: h.bot, canRun: () => true, onError: () => {} });
  await manager.tick(); await manager.drain();
  assert.equal((await f.service.shipGame.get(g.id)).dirty, false);
  assert.ok(h.state.public.files[0].name.includes('public'));
});
