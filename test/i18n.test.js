'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {};
require('../docs/i18n.js');
const I18N = global.window.I18N;

test('every language has every key of the English block', () => {
  const keys = Object.keys(I18N.en);
  Object.keys(I18N).forEach(lang => {
    const missing = keys.filter(k => I18N[lang][k] == null);
    assert.deepEqual(missing, [], lang + ' is missing keys');
    assert.equal(I18N[lang].days.length, 7, lang + ' days');
    assert.equal(I18N[lang].daysShort.length, 7, lang + ' daysShort');
    assert.equal(I18N[lang].months.length, 12, lang + ' months');
  });
});

test('placeholders match English in every language', () => {
  const ph = s => (typeof s === 'string' ? (s.match(/\{\w+\}/g) || []).sort().join(',') : '');
  Object.keys(I18N).forEach(lang => {
    Object.keys(I18N.en).forEach(k => assert.equal(ph(I18N[lang][k]), ph(I18N.en[k]), lang + '.' + k));
  });
});

test('every server reason code has a text', () => {
  const codes = ['BAD_HALL', 'MISSING_name', 'MISSING_department', 'BAD_DATE', 'BAD_TIME', 'END_BEFORE_START',
    'OUTSIDE_HOURS', 'PAST', 'TOO_FAR', 'HOLIDAY', 'CLASH', 'NOT_FOUND', 'NOT_OWNER', 'ALREADY_CANCELLED', 'STARTED'];
  const errors = ['AUTH', 'NOT_MEMBER', 'BUSY', 'SERVER', 'NETWORK', 'CONFIG'];
  codes.forEach(c => assert.ok(I18N.en['r_' + c], 'r_' + c));
  errors.forEach(c => assert.ok(I18N.en['e_' + c], 'e_' + c));
});
