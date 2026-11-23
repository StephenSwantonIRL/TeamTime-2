const element = (id) => document.getElementById(id);
const show = (id, visible = true) => { element(id).hidden = !visible; };
const text = (id, value) => { element(id).textContent = value; };
const views = ['schedule', 'details', 'receipt'];
const headings = { schedule: 'schedule-heading', details: 'details-heading', receipt: 'receipt-heading' };
const dayFormat = new Intl.DateTimeFormat('en-IE', {
  dateStyle: 'full', timeZone: 'UTC',
});
const monthFormat = new Intl.DateTimeFormat('en-IE', {
  month: 'long', year: 'numeric', timeZone: 'UTC',
});
const timeOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Europe/Dublin' };
const timeFormat = new Intl.DateTimeFormat('en-IE', timeOptions);
const offsetFormat = new Intl.DateTimeFormat('en-IE', { ...timeOptions, timeZoneName: 'shortOffset' });
const stateLabels = { available: 'available', full: 'fully booked', unavailable: 'no eligible times' };

let calendar;
let month;
let date;
let slot;
let slotRequest;
let attempt;
let checkingReservation = false;
let receiptCredentials;

class ApiError extends Error {
  constructor(status, response) {
    super(response?.message ?? 'TeamTime could not complete the request.');
    this.status = status;
    this.code = response?.code;
  }
}

async function request(path, options) {
  const response = await fetch(`/api${path}`, options);
  const body = await response.json().catch(() => null);
  if (!response.ok || !body) throw new ApiError(response.status, body);
  return body;
}

function showView(view, focus = true) {
  for (const id of views) show(id, id === view);
  if (focus) element(headings[view]).focus();
}

function message(id, value = '') {
  text(id, value);
  show(id, Boolean(value));
}

function formatTime(value) {
  const instant = Date.parse(value);
  const local = timeFormat.format(instant);
  const hourMs = 3_600_000;
  const repeats = [instant - hourMs, instant + hourMs].some((nearby) => timeFormat.format(nearby) === local);
  return repeats ? offsetFormat.format(instant) : local;
}

function timeRange({ startUtc, endUtc }) {
  return `${formatTime(startUtc)}–${formatTime(endUtc)} Dublin time`;
}

function dayLabel(key) {
  return dayFormat.format(new Date(`${key}T00:00:00Z`));
}

function shiftMonth(key, count) {
  const first = new Date(`${key}-01T00:00:00Z`);
  first.setUTCMonth(first.getUTCMonth() + count);
  return first.toISOString().slice(0, 7);
}

function setMode() {
  if (calendar.demo) {
    text('mode', 'Demo mode');
    text('privacy-note', 'Use sample details for this demo. No invitation is sent.');
  } else if (calendar.invitationsEnabled) {
    text('privacy-note', 'TeamTime uses these details to send your Outlook invitation.');
  } else {
    text('mode', 'Reservations only');
    text('privacy-note', 'This instance reserves slots. Email invitations are currently disabled.');
  }
  show('mode', calendar.demo || !calendar.invitationsEnabled);
}

function renderCalendar(focusDate) {
  const first = new Date(`${month}-01T00:00:00Z`);
  const firstColumn = (first.getUTCDay() + 6) % 7;
  const next = shiftMonth(month, 1);
  const last = new Date(new Date(`${next}-01T00:00:00Z`).getTime() - 1).getUTCDate();
  const statuses = new Map(calendar.dates.map(({ date: key, state }) => [key, state]));
  const rows = document.createDocumentFragment();
  let focusTarget;

  for (let i = 0; i < firstColumn + last; i += 7) {
    const row = document.createElement('tr');
    for (let weekday = 0; weekday < 7; weekday++) {
      const cell = document.createElement('td');
      row.append(cell);
      const day = i + weekday - firstColumn + 1;
      if (day < 1 || day > last) continue;
      const key = `${month}-${String(day).padStart(2, '0')}`;
      const state = statuses.get(key);
      const control = document.createElement(state ? 'button' : 'span');
      control.className = 'day-number';
      control.textContent = day;
      if (state) {
        control.type = 'button';
        control.classList.add(`day--${state}`);
        control.setAttribute('aria-label', `${dayLabel(key)}, ${stateLabels[state]}`);
        control.setAttribute('aria-pressed', String(date === key));
        control.addEventListener('click', () => loadSlots(key, true));
        if (key === focusDate) focusTarget = control;
      }
      cell.append(control);
    }
    rows.append(row);
  }

  text('month-label', monthFormat.format(first));
  element('calendar-days').replaceChildren(rows);
  element('previous-month').disabled = month <= calendar.from.slice(0, 7);
  element('next-month').disabled = `${next}-01` >= calendar.until;
  focusTarget?.focus();
}

function renderSlots(slots) {
  const options = slots.map((option, index) => {
    const item = document.createElement('div');
    item.className = 'slot';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'time';
    input.id = `time-${index}`;
    input.addEventListener('change', () => {
      slot = option;
      element('continue').disabled = false;
    });
    const label = document.createElement('label');
    label.htmlFor = input.id;
    label.textContent = formatTime(option.startUtc);
    item.append(input, label);
    return item;
  });
  element('slots').replaceChildren(...options);
  element('slots').scrollTop = 0;
  show('time-options', options.length > 0);
}

async function loadSlots(key, restoreFocus = false) {
  slotRequest?.abort();
  slotRequest = new AbortController();
  const { signal } = slotRequest;
  date = key;
  slot = undefined;
  attempt = undefined;
  element('continue').disabled = true;
  show('retry-slots', false);
  renderSlots([]);
  renderCalendar(restoreFocus ? key : undefined);
  message('time-date', dayLabel(key));
  message('slot-message', 'Checking available times…');

  try {
    const data = await request(`/availability/slots?date=${encodeURIComponent(key)}`, { signal });
    if (signal.aborted) return;
    message('slot-message', {
      available: '', full: 'This date is fully booked. Choose another date.',
      closed: 'Appointments are unavailable on this date.',
      unavailable: 'There are no eligible times left on this date.',
    }[data.state]);
    renderSlots(data.slots);
  } catch {
    if (signal.aborted) return;
    message('slot-message', 'We couldn’t load appointment times. Please try again.');
    show('retry-slots');
  }
}

async function loadCalendar(preferredDate) {
  slotRequest?.abort();
  slot = undefined;
  show('retry-calendar', false);
  show('retry-slots', false);
  show('time-date', false);
  show('calendar', false);
  renderSlots([]);
  element('continue').disabled = true;
  message('slot-message', 'Choose a date to see appointment times.');
  message('calendar-message', 'Finding available dates…');

  try {
    calendar = await request('/availability/dates');
    setMode();
    date = calendar.dates.find((entry) => entry.date === preferredDate)?.date ??
      calendar.dates.find((entry) => entry.state === 'available')?.date ?? calendar.dates[0]?.date;
    month = (date ?? calendar.from).slice(0, 7);
    show('calendar');
    renderCalendar();
    message('calendar-message', calendar.dates.length === 0 ? 'There are no appointment dates available right now.' : '');
    if (date) await loadSlots(date);
  } catch {
    message('calendar-message', 'We couldn’t load the calendar. Please try again.');
    show('retry-calendar');
  }
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function newAttempt() {
  const token = crypto.getRandomValues(new Uint8Array(32));
  const reference = new Uint8Array(await crypto.subtle.digest('SHA-256', token)).slice(0, 16);
  return { reference: toHex(reference), token: toHex(token) };
}

function statusLookup(credentials) {
  return request(`/bookings/${credentials.reference}/status`, {
    headers: { Authorization: `Bearer ${credentials.token}` },
  });
}

function displayReceipt(booking, focus) {
  const states = {
    confirmed: booking.notificationStatus === 'simulated' ?
      ['Demo booking complete', 'This appointment was booked in the demo. No meeting invitation was sent.'] :
      ['Booking confirmed', 'Your meeting invitation was sent.'],
    pending: ['Time reserved', 'Your time is reserved. The meeting invitation is pending.'],
    requires_reconciliation: ['Time reserved', 'TeamTime couldn’t confirm whether the invitation was sent. Use Check status or contact the organiser with your booking reference.'],
    failed: ['Booking could not be completed', 'You can choose another time to try again.'],
  };
  const [title, blurb] = states[booking.status];
  text('receipt-heading', title);
  text('receipt-message', blurb);
  text('receipt-time', `${dayLabel(booking.date)}, ${timeRange(booking)}`);
  text('receipt-reference', booking.reference);
  show('check-status', ['pending', 'requires_reconciliation'].includes(booking.status));
  message('receipt-error');
  showView('receipt', focus);
}

element('previous-month').addEventListener('click', () => { month = shiftMonth(month, -1); renderCalendar(); });
element('next-month').addEventListener('click', () => { month = shiftMonth(month, 1); renderCalendar(); });
element('retry-calendar').addEventListener('click', () => loadCalendar());
element('retry-slots').addEventListener('click', () => loadSlots(date));

element('continue').addEventListener('click', () => {
  if (!slot) return;
  text('details-date', dayLabel(date));
  text('details-time', timeRange(slot));
  message('form-error');
  message('notice');
  showView('details');
});

element('edit-time').addEventListener('click', () => { showView('schedule'); });

element('booking-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const confirm = element('confirm');
  if (!slot || confirm.disabled) return;
  confirm.disabled = true;
  element('edit-time').disabled = true;
  text('confirm', 'Reserving…');
  message('form-error');

  try {
    attempt ??= await newAttempt();
    const credentials = attempt;
    let booking;
    try {
      booking = await request('/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.token}` },
        body: JSON.stringify({
          reference: credentials.reference, startUtc: slot.startUtc,
          name: element('name').value, email: element('email').value,
        }),
      });
    } catch (error) {
      if (error instanceof ApiError && error.status < 500 && error.code) throw error;
      checkingReservation = true;
      booking = await statusLookup(credentials).catch(() => null);
      if (!booking) throw new Error('We couldn’t verify the reservation. Select Confirm booking again to check the same request.');
    }

    receiptCredentials = credentials;
    attempt = undefined;
    checkingReservation = false;
    event.target.reset();
    displayReceipt(booking, true);
  } catch (error) {
    if (error.code === 'slot_unavailable') {
      checkingReservation = false;
      message('notice', error.message);
      showView('schedule');
      await loadCalendar(date);
    } else {
      message('form-error', error.message);
    }
  } finally {
    confirm.disabled = false;
    element('edit-time').disabled = checkingReservation;
    text('confirm', 'Confirm booking');
  }
});

element('check-status').addEventListener('click', async () => {
  const button = element('check-status');
  button.disabled = true;
  try {
    const booking = await statusLookup(receiptCredentials);
    if (!element('receipt').hidden) displayReceipt(booking, false);
  } catch {
    message('receipt-error', 'We couldn’t check the booking status. Please try again.');
  } finally {
    button.disabled = false;
  }
});

element('book-again').addEventListener('click', () => {
  receiptCredentials = undefined;
  showView('schedule');
  loadCalendar(date);
});

loadCalendar();
