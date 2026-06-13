'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { haversine, pointInPolygon } = require('../src/core/geo.js');

test('haversine: distanza nulla su stesso punto', () => {
  assert.equal(haversine({ lat: 45, lng: 9 }, { lat: 45, lng: 9 }), 0);
});

test('haversine: ~111 km per 1° di latitudine', () => {
  const d = haversine({ lat: 45, lng: 9 }, { lat: 46, lng: 9 });
  assert.ok(Math.abs(d - 111.19) < 0.5, `atteso ~111 km, ottenuto ${d}`);
});

test('haversine: Milano-Roma ~477 km', () => {
  const d = haversine({ lat: 45.4642, lng: 9.19 }, { lat: 41.9028, lng: 12.4964 });
  assert.ok(Math.abs(d - 477) < 10, `atteso ~477 km, ottenuto ${d}`);
});

test('pointInPolygon: dentro e fuori un quadrato', () => {
  const square = [{ lat: 45.3, lng: 9.0 }, { lat: 45.6, lng: 9.0 }, { lat: 45.6, lng: 9.3 }, { lat: 45.3, lng: 9.3 }];
  assert.equal(pointInPolygon({ lat: 45.46, lng: 9.19 }, square), true);  // Milano dentro
  assert.equal(pointInPolygon({ lat: 45.07, lng: 7.69 }, square), false); // Torino fuori
  assert.equal(pointInPolygon({ lat: 45.7, lng: 9.15 }, square), false);  // sopra il bordo nord
});
