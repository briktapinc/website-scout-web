#!/usr/bin/env node
'use strict';

function resolvePane(current, next) {
  const isBookings = current === 'bookings';
  const isChatbot = current === 'chatbot';
  if (!isBookings && !isChatbot) return null;
  const allowed = isChatbot
    ? new Set(['content', 'settings', 'inbox'])
    : new Set(['content', 'hours', 'appointments']);
  return allowed.has(next) ? next : 'content';
}

function visibility(current, pane) {
  const isChatbot = current === 'chatbot';
  const isBookings = current === 'bookings';
  return {
    contentHidden: (isBookings || isChatbot) && pane !== 'content',
    settingsShown: isChatbot && pane === 'settings',
    inboxShown: isChatbot && pane === 'inbox',
    hoursShown: isBookings && pane === 'hours',
  };
}

const cases = [
  ['chatbot', 'settings', 'settings', true, false],
  ['chatbot', 'inbox', 'inbox', false, true],
  ['chatbot', 'content', 'content', false, false],
  ['bookings', 'hours', 'hours', false, false],
  ['bookings', 'settings', 'content', false, false],
];

for (const [cur, next, expectPane, expectSettings, expectInbox] of cases) {
  const pane = resolvePane(cur, next);
  const v = visibility(cur, pane);
  if (pane !== expectPane) {
    console.error('FAIL pane', cur, next, 'got', pane, 'want', expectPane);
    process.exit(1);
  }
  if (v.settingsShown !== expectSettings || v.inboxShown !== expectInbox) {
    console.error('FAIL visibility', cur, next, v);
    process.exit(1);
  }
  console.log('ok', cur, next, '->', pane, 'settings=', v.settingsShown, 'inbox=', v.inboxShown);
}

const fs = require('fs');
const js = fs.readFileSync('/app/public/js/portal.js', 'utf8');
const html = fs.readFileSync('/app/public/portal.html', 'utf8');
const idx = js.indexOf('modulesPaneTabs.addEventListener');
if (idx < 0) {
  console.error('FAIL: modulesPaneTabs handler missing');
  process.exit(1);
}
const slice = js.slice(idx, idx + 700);
if (!slice.includes('isChatbot') || !slice.includes("'settings'") || !slice.includes("'inbox'")) {
  console.error('FAIL: chatbot panes not in handler\n', slice);
  process.exit(1);
}
if (/moduleState\.current !== ['"]bookings['"]/.test(slice)) {
  console.error('FAIL: still bookings-only early return');
  process.exit(1);
}
if (!html.includes('portal.js?v=chattabs1')) {
  console.error('FAIL: cache bust missing');
  process.exit(1);
}
if (!html.includes('id="modules-pane-chat-settings"') || !html.includes('id="modules-pane-chat-inbox"')) {
  console.error('FAIL: chat panes missing in HTML');
  process.exit(1);
}
console.log('deployed_handler_ok');
console.log('verify_ok');
