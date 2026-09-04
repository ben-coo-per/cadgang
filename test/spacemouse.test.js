import { test } from 'node:test';
import assert from 'node:assert';
import {
  parseReport, shapeAxis, looksLikeSpaceMouse, productName, HID_FILTERS, FRAME, FULL_SCALE,
} from '../web/spacemouse.js';

// Build a report payload (without the id byte) from int16 little-endian values.
function le16(...vals) {
  const b = new Uint8Array(vals.length * 2);
  const v = new DataView(b.buffer);
  vals.forEach((x, i) => v.setInt16(i * 2, x, true));
  return b;
}

test('report 1 (6 bytes) is translation in the FRAME convention', () => {
  const r = parseReport(1, le16(350, 175, -350));
  assert.deepEqual(Object.keys(r.axes).sort(), ['x', 'y', 'z']);
  assert.equal(r.axes.x, 1 * FRAME.x);
  assert.equal(r.axes.y, 0.5 * FRAME.y);
  assert.equal(r.axes.z, -1 * FRAME.z);
});

test('report 2 is rotation', () => {
  const r = parseReport(2, le16(0, 70, -70));
  assert.deepEqual(Object.keys(r.axes).sort(), ['rx', 'ry', 'rz']);
  assert.equal(r.axes.rx, 0);
  assert.equal(r.axes.ry, (70 / FULL_SCALE) * FRAME.ry);
  assert.equal(r.axes.rz, (-70 / FULL_SCALE) * FRAME.rz);
});

test('report 1 (12 bytes, newer firmware) carries all six axes', () => {
  const r = parseReport(1, le16(10, 20, 30, 40, 50, 60));
  assert.deepEqual(Object.keys(r.axes).sort(), ['rx', 'ry', 'rz', 'x', 'y', 'z']);
  assert.equal(r.axes.rz, (60 / FULL_SCALE) * FRAME.rz);
});

test('values beyond full scale are clamped to ±1', () => {
  const r = parseReport(1, le16(32000, -32000, 0));
  assert.equal(Math.abs(r.axes.x), 1);
  assert.equal(Math.abs(r.axes.y), 1);
});

test('a DataView payload (what WebHID hands over) works too', () => {
  const b = le16(350, 0, 0);
  const r = parseReport(1, new DataView(b.buffer));
  assert.equal(r.axes.x, 1);
});

test('report 3 is a little-endian button bitmask of any width', () => {
  assert.equal(parseReport(3, new Uint8Array([0b10])).buttons, 2);
  assert.equal(parseReport(3, new Uint8Array([0x01, 0x00])).buttons, 1);
  assert.equal(parseReport(3, new Uint8Array([0x00, 0x01, 0x00, 0x80])).buttons, 0x80000100);
});

test('unknown reports (battery, LCD, vendor) are ignored', () => {
  assert.equal(parseReport(0x17, new Uint8Array([1, 2, 3])), null);
  assert.equal(parseReport(0, new Uint8Array(6)), null);
});

test('a truncated report does not throw', () => {
  const r = parseReport(1, new Uint8Array([0x5e, 0x01, 0x00]));
  assert.equal(r.axes.x, 1);
  assert.equal(r.axes.y, 0);
});

test('shapeAxis: dead zone, quadratic curve, sign preserved, saturates at 1', () => {
  assert.equal(shapeAxis(0.03, 0.05), 0);
  assert.equal(shapeAxis(-0.03, 0.05), 0);
  assert.equal(shapeAxis(1, 0.05), 1);
  assert.equal(shapeAxis(-1, 0.05), -1);
  const mid = shapeAxis(0.525, 0.05);          // halfway through the live range
  assert.ok(Math.abs(mid - 0.25) < 1e-9);
  assert.ok(shapeAxis(-0.525, 0.05) < 0);
  assert.equal(shapeAxis(NaN), 0);
});

test('gamepad id sniffing', () => {
  assert.ok(looksLikeSpaceMouse('3Dconnexion SpaceMouse Compact (Vendor: 256f Product: c635)'));
  assert.ok(looksLikeSpaceMouse('SpaceNavigator (Vendor: 046d Product: c626)'));
  assert.ok(looksLikeSpaceMouse('Unknown multi-axis (Vendor: 046d Product: c62b)'));
  assert.ok(!looksLikeSpaceMouse('Xbox Wireless Controller (Vendor: 045e Product: 02fd)'));
  assert.ok(!looksLikeSpaceMouse(''));
});

test('product names and picker filters', () => {
  assert.equal(productName(0x256f, 0xc635), 'SpaceMouse Compact');
  assert.equal(productName(0x046d, 0xc626), 'SpaceNavigator');
  assert.equal(productName(0x256f, 0xffff, 'Future Puck'), 'Future Puck');
  assert.equal(productName(0x256f, 0xffff), '3Dconnexion 256f:ffff');
  // the filters must only match the multi-axis collection, never ordinary Logitech HID
  for (const f of HID_FILTERS) { assert.equal(f.usagePage, 1); assert.equal(f.usage, 8); }
});
