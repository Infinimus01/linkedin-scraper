/* global LJS, ljsScanPosts, chrome */
const $ = (id) => document.getElementById(id);
// sleep() runs on a worker timer so runs keep their pace while this tab is in the background.
const timers = { worker: null, next: 1, waiting: new Map() };
try {
  timers.worker = new Worker('timer-worker.js');
  timers.worker.onmessage = (e) => { const done = timers.waiting.get(e.data); timers.waiting.delete(e.data); if (done) done(); };
  timers.worker.onerror = () => { timers.worker = null; timers.waiting.forEach((done) => done()); timers.waiting.clear(); };
} catch (e) { timers.worker = null; }
const sleep = (ms) => new Promise((r) => {
  if (!timers.worker) return setTimeout(r, ms);
  const id = timers.next++;
  timers.waiting.set(id, r);
  timers.worker.postMessage({ id, ms });
});
const jitter = (min, max) => sleep(min + Math.random() * (max - min));

const state = { jobs: {}, posts: {}, running: false, stop: false, tab: 'jobs', scanTabId: null, watching: 0, newBatch: null, hidden: null, sources: {} };

// ---------- settings ----------
const FIELDS = ['roles', 'location', 'period', 'sort', 'minYears', 'maxYears', 'maxJobs', 'scrolls', 'visa', 'maxApplicants', 'showFirst', 'watchMins', 'companies'];
const CHECKS = ['keepUnknown', 'quick', 'titleMatch', 'dedupe', 'hideClosed', 'feed24', 'feedRole', 'emailOnly', 'early', 'watch'];

function readSettings() {
  const s = {};
  FIELDS.forEach((f) => (s[f] = $(f).value));
  CHECKS.forEach((f) => (s[f] = $(f).checked));
  s.levels = [...document.querySelectorAll('.lvl:checked')].map((e) => e.value);
  s.workTypes = [...document.querySelectorAll('.wt:checked')].map((e) => e.value);
  return s;
}
function applySettings(s) {
  if (!s) return;
  FIELDS.forEach((f) => s[f] !== undefined && ($(f).value = s[f]));
  CHECKS.forEach((f) => s[f] !== undefined && ($(f).checked = s[f]));
  document.querySelectorAll('.lvl').forEach((e) => (e.checked = (s.levels || []).includes(e.value)));
  document.querySelectorAll('.wt').forEach((e) => (e.checked = (s.workTypes || []).includes(e.value)));
}
const roleList = () => $('roles').value.split(/[\n,]/).map((r) => r.trim()).filter(Boolean);

// ---------- storage ----------
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => chrome.storage.local.set({ jobs: state.jobs, posts: state.posts, sources: state.sources, settings: readSettings() }), 400);
}

// ---------- status ----------
function status(msg, isError) {
  $('status').textContent = msg;
  $('status').classList.toggle('error', !!isError);
}
function setRunning(on) {
  state.running = on;
  state.stop = false;
  ['start', 'scanFeed', 'searchPosts', 'clear'].forEach((id) => ($(id).disabled = on));
  $('stop').disabled = !on;
}

// ---------- network ----------
async function fetchDoc(url) {
  const waits = [6000, 20000, 60000, 120000];
  for (let attempt = 0; ; attempt++) {
    let res = null;
    try {
      res = await fetch(url, { credentials: 'omit', headers: { Accept: 'text/html' } });
    } catch (e) {
      if (attempt >= waits.length) throw new Error('Could not reach LinkedIn. Check your internet connection.');
    }
    if (res && res.ok) return new DOMParser().parseFromString(await res.text(), 'text/html');
    if (res && (res.status === 404 || res.status === 400)) return null;
    if (attempt >= waits.length) throw new Error('LinkedIn keeps refusing requests (HTTP ' + (res ? res.status : 'error') + '). Wait a few minutes and press Scrape jobs again; it continues where it stopped.');
    status('LinkedIn asked us to slow down. Waiting ' + waits[attempt] / 1000 + 's, then continuing…');
    await sleep(waits[attempt]);
    if (state.stop) return null;
  }
}

function enrich(job) {
  job.years = LJS.extractYears(job.description);
  job.visa = LJS.visaStatus(job.description);
  job.emails = LJS.extractEmails(job.description).join(', ');
  job.applicantsN = LJS.applicantCount(job.applicants);
}
// Best estimate of when the job went up, from LinkedIn's "14 minutes ago" text.
function postedAt(card) {
  const mins = LJS.postedMinutes(card.postedText);
  if (mins !== null) return Date.now() - mins * 60000;
  return Date.parse(card.postedDate) || Date.now();
}
function ago(ts) {
  if (!ts) return '';
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 60) return m + ' min ago';
  if (m < 1440) return Math.round(m / 60) + ' h ago';
  return Math.round(m / 1440) + ' d ago';
}

// ---------- company career pages ----------
async function fetchJson(url) {
  try {
    const res = await fetch(url, { credentials: 'omit', headers: { Accept: 'application/json' } });
    return res.ok ? await res.json() : null;
  } catch (e) {
    return null;
  }
}
async function scrapeCompanies(s, roles, runStart) {
  const entries = s.companies.split('\n').map((x) => x.trim()).filter(Boolean);
  if (!entries.length) return { added: 0, note: '' };
  const locations = LJS.expandLocations(s.location);
  const cutoff = +s.period ? Date.now() - s.period * 1000 : 0;
  const notes = [];
  let added = 0;
  for (const entry of entries) {
    if (state.stop) break;
    status(`Checking the career page of ${entry}…`);
    const key = entry.toLowerCase();
    const tries = state.sources[key] ? [state.sources[key]] : LJS.companyCandidates(entry);
    // A bare name can match unrelated companies on different job systems, so try them
    // all once and keep the one with the most open jobs. The choice is remembered.
    let found = null;
    let jobs = [];
    for (const c of tries) {
      const data = await fetchJson(LJS.atsUrl(c.ats, c.slug));
      const list = data ? LJS.parseAts(c.ats, c.slug, data, entry) : null;
      if (list && (!found || list.length > jobs.length)) { found = c; jobs = list; }
      await sleep(300);
    }
    if (!found) { notes.push(`${entry}: no career page found`); continue; }
    state.sources[key] = found;
    let matching = 0;
    for (const j of jobs) {
      if (!LJS.matchesAnyRole(j.title, roles)) continue;
      if (!LJS.locationMatches(j.location, locations)) continue;
      if (cutoff && j.postedAt < cutoff) continue;
      matching++;
      if (state.jobs[j.id]) continue;
      const job = { ...j, role: '', scrapedAt: new Date().toISOString(), batch: runStart, detailed: true, applicants: '' };
      enrich(job);
      state.jobs[j.id] = job;
      added++;
    }
    notes.push(`${jobs[0] ? jobs[0].company : entry}: ${matching} matching of ${jobs.length} open jobs`);
    render();
    save();
    await sleep(500);
  }
  return { added, note: ' Career pages: ' + notes.join('; ') + '.' };
}

// ---------- job scrape ----------
async function scrapeJobs(auto) {
  state.watching++; // cancels any pending watch check
  const runStart = new Date().toISOString();
  const s = readSettings();
  const roles = roleList();
  if (!roles.length) return status('Add at least one role.', true);
  const locations = LJS.expandLocations(s.location);
  const maxJobs = Math.max(10, Math.min(1000, parseInt(s.maxJobs, 10) || 200));
  setRunning(true);
  let fresh = 0;
  let companyNote = '';
  try {
    for (const role of roles) {
      for (const location of locations) {
        // Asking LinkedIn for the visa phrase brings sponsoring jobs to the top; each
        // description is still checked afterwards.
        const keywords = s.visa === 'yes' ? role + ' visa sponsorship' : role;
        let got = 0;
        for (let start = 0; start < 1000 && got < maxJobs && !state.stop; start += LJS.PAGE_SIZE) {
          status(`Searching "${role}" in ${location || 'all locations'} — ${got} found so far…`);
          const doc = await fetchDoc(
            LJS.buildSearchUrl({ keywords, location, seconds: +s.period, levels: s.levels, workTypes: s.workTypes, sort: s.sort, early: s.early }, start)
          );
          const cards = doc ? LJS.parseCards(doc) : [];
          if (!cards.length) break;
          let pageNew = 0;
          for (const c of cards) {
            got++;
            if (state.jobs[c.id]) continue;
            state.jobs[c.id] = { ...c, role, scrapedAt: new Date().toISOString(), batch: runStart, postedAt: postedAt(c) };
            fresh++;
            pageNew++;
          }
          render();
          // A watch check only needs the newest jobs: stop at the first page with nothing new.
          if (auto === true && s.sort !== 'relevant' && !pageNew) break;
          save();
          await jitter(1200, 2600);
        }
      }
    }

    if (!state.stop) {
      const c = await scrapeCompanies(s, roles, runStart);
      fresh += c.added;
      companyNote = c.note;
    }

    if (!s.quick && !state.stop) {
      // Only open jobs that can still pass the title filter; the rest would be hidden anyway.
      const todo = Object.values(state.jobs).filter((j) => !j.detailed && (!s.titleMatch || LJS.matchesAnyRole(j.title, roles)));
      for (let i = 0; i < todo.length && !state.stop; i++) {
        const job = todo[i];
        status(`Reading job ${i + 1} of ${todo.length}: ${job.title} — ${job.company}`);
        const doc = await fetchDoc(LJS.DETAIL_BASE + job.id);
        if (state.stop) break;
        if (doc) {
          Object.assign(job, LJS.parseDetail(doc));
          enrich(job);
        }
        job.detailed = true;
        if (i % 5 === 4) render();
        save();
        await jitter(1300, 2800);
      }
    }
    const matching = visibleJobs();
    const newOnes = matching.filter((j) => j.batch === runStart);
    if (auto === true && newOnes.length) {
      state.newBatch = runStart;
      announce(newOnes);
    }
    render();
    status(`${state.stop ? 'Stopped' : 'Done'}. ${fresh} new jobs found, ${newOnes.length} of them match your filters; ${matching.length} matching in total.${companyNote}`);
  } catch (e) {
    status(e.message || String(e), true);
  } finally {
    const stopped = state.stop;
    setRunning(false);
    render();
    save();
    if ($('watch').checked && !stopped) scheduleWatch();
  }
}

// ---------- watch mode ----------
async function scheduleWatch() {
  const mins = Math.max(5, Math.min(240, parseInt($('watchMins').value, 10) || 10));
  const token = ++state.watching;
  const at = new Date(Date.now() + mins * 60000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('status').textContent += ` Watching: next check at ${at}. Keep this tab open.`;
  $('stop').disabled = false;
  await sleep(mins * 60000);
  if (token === state.watching && $('watch').checked && !state.running) scrapeJobs(true);
}
function announce(jobs) {
  document.title = `(${jobs.length} new) LinkedIn Jobs Scraper`;
  try {
    if (Notification.permission === 'granted') {
      const n = new Notification(`${jobs.length} new job${jobs.length > 1 ? 's' : ''} on LinkedIn`, {
        body: jobs.slice(0, 3).map((j) => `${j.title} — ${j.company}`).join('\n'),
      });
      n.onclick = () => { window.focus(); n.close(); };
    }
  } catch (e) { /* notifications unavailable */ }
}
window.addEventListener('focus', () => { document.title = 'LinkedIn Jobs Scraper'; });

// ---------- hiring posts (signed-in LinkedIn tab) ----------
async function waitForLoad(tabId) {
  for (let i = 0; i < 60; i++) {
    const t = await chrome.tabs.get(tabId);
    if (t.status === 'complete') break;
    await sleep(500);
  }
  await sleep(3500); // let LinkedIn render its first posts
  return chrome.tabs.get(tabId);
}
const needsLogin = (url) => /\/(login|authwall|checkpoint|uas\/|signup)/.test(url || '');

async function scanTab(tabId, s) {
  state.scanTabId = tabId;
  await chrome.tabs.update(tabId, { active: true });
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    func: ljsScanPosts,
    args: [{
      rolePatterns: roleList().map((r) => LJS.rolePatterns(r)),
      scrolls: parseInt(s.scrolls, 10) || 40,
      last24h: s.feed24,
      requireRole: s.feedRole,
    }],
  });
  state.scanTabId = null;
  const out = (res && res.result) || { posts: [], nodesSeen: 0 };
  let added = 0;
  for (const p of out.posts) {
    if (!state.posts[p.id]) added++;
    const y = LJS.extractYears(p.text);
    state.posts[p.id] = { ...p, years: y, scrapedAt: new Date().toISOString() };
  }
  render();
  save();
  return { added, nodesSeen: out.nodesSeen };
}

async function runPostScan(kind) {
  const s = readSettings();
  const roles = roleList();
  if (kind === 'search' && !roles.length) return status('Add at least one role.', true);
  const me = await chrome.tabs.getCurrent();
  setRunning(true);
  switchTab('posts');
  let added = 0;
  let nodes = 0;
  try {
    if (kind === 'feed') {
      const open = await chrome.tabs.query({ url: 'https://www.linkedin.com/feed/*' });
      let tab = open[0] || (await chrome.tabs.create({ url: 'https://www.linkedin.com/feed/', active: true }));
      status('Scrolling your feed and collecting hiring posts…');
      tab = await waitForLoad(tab.id);
      if (needsLogin(tab.url)) throw new Error('Sign in to LinkedIn in the tab that just opened, then press the button again.');
      const r = await scanTab(tab.id, s);
      added += r.added;
      nodes += r.nodesSeen;
    } else {
      // Use the first location as a keyword so posts are about the right place.
      const first = LJS.expandLocations(s.location)[0];
      const place = /european union/i.test(first) ? 'Europe' : first;
      for (const role of roles) {
        if (state.stop) break;
        status(`Searching LinkedIn posts for "hiring ${role}${place ? ' ' + place : ''}"…`);
        let tab = await chrome.tabs.create({ url: LJS.buildPostSearchUrl(role, place, s.feed24), active: true });
        tab = await waitForLoad(tab.id);
        if (needsLogin(tab.url)) throw new Error('Sign in to LinkedIn in the tab that just opened, then press the button again.');
        const r = await scanTab(tab.id, s);
        added += r.added;
        nodes += r.nodesSeen;
        await chrome.tabs.remove(tab.id).catch(() => {});
        await jitter(1500, 3000);
      }
    }
    const withEmail = Object.values(state.posts).filter((p) => p.emails).length;
    if (!nodes && !added) status('No hiring posts were found on the page. If the page clearly showed some, LinkedIn has changed its layout and the scanner needs an update.', true);
    else status(`${state.stop ? 'Stopped' : 'Done'}. ${added} new hiring posts; ${withEmail} of ${Object.keys(state.posts).length} saved posts include an email.`);
  } catch (e) {
    status(e.message || String(e), true);
  } finally {
    state.scanTabId = null;
    if (me) chrome.tabs.update(me.id, { active: true }).catch(() => {});
    setRunning(false);
    save();
  }
}

// ---------- filtering ----------
function yearsOk(years, s) {
  const min = s.minYears === '' ? null : +s.minYears;
  const max = s.maxYears === '' ? null : +s.maxYears;
  if (min === null && max === null) return true;
  if (!years) return s.keepUnknown;
  if (min !== null && years.min < min) return false;
  if (max !== null && years.min > max) return false;
  return true;
}

function visibleJobs() {
  const s = readSettings();
  const roles = roleList();
  const q = $('search').value.trim().toLowerCase();
  const seen = new Set();
  const hidden = { title: 0, closed: 0, years: 0, visa: 0, applicants: 0, search: 0, repeat: 0 };
  const maxApp = s.maxApplicants === '' ? null : +s.maxApplicants;
  const when = (j) => j.postedAt || Date.parse(j.postedDate) || 0;
  const few = (j) => (j.applicantsN == null ? Infinity : j.applicantsN);
  const hide = (why) => { hidden[why]++; return false; };
  const list = Object.values(state.jobs)
    .sort((a, b) => (s.showFirst === 'fewest' && few(a) !== few(b) ? few(a) - few(b) : 0) || when(b) - when(a) || b.id.localeCompare(a.id))
    .filter((j) => {
      if (s.titleMatch && !LJS.matchesAnyRole(j.title, roles)) return hide('title');
      if (s.hideClosed && j.closed) return hide('closed');
      if (!yearsOk(j.years, s)) return hide('years');
      if (s.visa === 'yes' && j.visa !== 'yes') return hide('visa');
      if (s.visa === 'hideNo' && j.visa === 'no') return hide('visa');
      if (maxApp !== null && j.applicantsN != null && j.applicantsN > maxApp) return hide('applicants');
      if (q && ![j.title, j.company, j.location, j.emails, j.description].join(' ').toLowerCase().includes(q)) return hide('search');
      if (s.dedupe) {
        const key = (j.title + '|' + j.company).toLowerCase().replace(/\s+/g, ' ');
        if (seen.has(key)) return hide('repeat');
        seen.add(key);
      }
      return true;
    });
  state.hidden = hidden;
  return list;
}
const HIDDEN_LABELS = {
  title: 'title does not match your roles',
  closed: 'no longer accepting applications',
  years: 'years of experience outside your range',
  visa: 'visa sponsorship filter',
  applicants: 'more applicants than your limit',
  search: 'the filter box',
  repeat: 'repeats of the same job',
};
function hiddenSummary() {
  const parts = Object.keys(HIDDEN_LABELS).filter((k) => state.hidden && state.hidden[k]).map((k) => `${state.hidden[k]} ${HIDDEN_LABELS[k]}`);
  return parts.length ? 'Hidden by filters: ' + parts.join(' · ') : '';
}
function visiblePosts() {
  const s = readSettings();
  const q = $('search').value.trim().toLowerCase();
  return Object.values(state.posts)
    .filter((p) => !s.emailOnly || p.emails)
    .filter((p) => yearsOk(p.years, { ...s, keepUnknown: true }))
    .filter((p) => !q || [p.author, p.text, p.emails].join(' ').toLowerCase().includes(q))
    .sort((a, b) => (b.emails ? 1 : 0) - (a.emails ? 1 : 0) || (b.scrapedAt || '').localeCompare(a.scrapedAt || ''));
}

// ---------- rendering ----------
function cell(tr, value, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  if (value instanceof Node) td.appendChild(value);
  else td.textContent = value || '';
  tr.appendChild(td);
  return td;
}
function link(href, label) {
  const a = document.createElement('a');
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.textContent = label;
  return a;
}
function emptyRow(tbody, cols, msg) {
  const tr = document.createElement('tr');
  cell(tr, msg, 'empty').colSpan = cols;
  tbody.appendChild(tr);
}
const visaLabel = (v) => (v === 'yes' ? 'Offered' : v === 'no' ? 'Not offered' : '');
const postLink = (p) => p.jobUrl || p.postUrl || p.authorUrl || '';
const summary = (t, n) => {
  const one = (t || '').replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
};

function render() {
  const jobs = visibleJobs();
  const posts = visiblePosts();
  const total = Object.keys(state.jobs).length;
  $('jobCount').textContent = jobs.length === total ? total : `${jobs.length} of ${total}`;
  $('postCount').textContent = posts.length;
  $('hidden').textContent = state.tab === 'jobs' ? hiddenSummary() : '';
  $('hidden').hidden = !$('hidden').textContent;

  const jb = document.querySelector('#jobsTable tbody');
  jb.replaceChildren();
  if (!jobs.length) emptyRow(jb, 9, total ? 'No jobs match the current filters.' : 'No jobs yet. Set your filters and press Scrape jobs.');
  for (const j of jobs) {
    const tr = document.createElement('tr');
    const title = cell(tr, link(j.url, j.title || '(untitled)'));
    if (state.newBatch && j.batch === state.newBatch) {
      tr.className = 'new';
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'NEW';
      title.appendChild(tag);
    }
    cell(tr, j.company);
    cell(tr, j.location);
    cell(tr, ago(j.postedAt) || j.postedText || j.postedDate, 'nowrap');
    cell(tr, LJS.yearsLabel(j.years), 'nowrap');
    cell(tr, visaLabel(j.visa), 'nowrap');
    cell(tr, j.emails);
    cell(tr, j.applicants, 'nowrap');
    cell(tr, j.source || 'LinkedIn', 'nowrap');
    jb.appendChild(tr);
  }

  const pb = document.querySelector('#postsTable tbody');
  pb.replaceChildren();
  if (!posts.length) emptyRow(pb, 6, 'No hiring posts yet. Press "Search all of LinkedIn" or "Scan my feed".');
  for (const p of posts) {
    const tr = document.createElement('tr');
    cell(tr, p.authorUrl ? link(p.authorUrl, p.author || 'Profile') : p.author);
    cell(tr, p.age, 'nowrap');
    cell(tr, LJS.yearsLabel(p.years), 'nowrap');
    cell(tr, p.emails);
    cell(tr, summary(p.text, 500), 'post');
    cell(tr, postLink(p) ? link(postLink(p), 'Open') : '');
    pb.appendChild(tr);
  }
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('jobsTable').hidden = tab !== 'jobs';
  $('postsTable').hidden = tab !== 'posts';
  render();
}

// ---------- CSV export: short and readable, no descriptions ----------
function exportRows() {
  if (state.tab === 'posts') {
    return visiblePosts().map((p) => ({
      'Posted by': p.author,
      'Post': summary(p.text, 200),
      'Posted': p.age,
      'Years of experience': LJS.yearsLabel(p.years),
      'Email': p.emails,
      'Link': postLink(p),
    }));
  }
  return visibleJobs().map((j) => ({
    'Job': j.title,
    'Company': j.company,
    'Location': j.location,
    'Posted': j.postedAt ? new Date(j.postedAt).toLocaleString() : j.postedDate || j.postedText,
    'Applicants': j.applicants || '',
    'Years of experience': LJS.yearsLabel(j.years),
    'Visa sponsorship': visaLabel(j.visa),
    'Email': j.emails || '',
    'Source': j.source || 'LinkedIn',
    'Link': j.url,
  }));
}
function toCsv(rows) {
  const cols = Object.keys(rows[0]);
  const esc = (v) => {
    let t = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(t) && !/^[+\-]?\d/.test(t)) t = "'" + t; // stop spreadsheets treating text as a formula
    return '"' + t.replace(/"/g, '""') + '"';
  };
  return '﻿' + [cols.map(esc).join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n');
}
function exportCsv() {
  const rows = exportRows();
  if (!rows.length) return status('Nothing to export.', true);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv' }));
  a.download = `linkedin-${state.tab}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  status(`Exported ${rows.length} ${state.tab === 'posts' ? 'posts' : 'jobs'}.`);
}

// ---------- wiring ----------
$('start').addEventListener('click', () => scrapeJobs(false));
$('watch').addEventListener('change', () => {
  if ($('watch').checked) { try { Notification.requestPermission(); } catch (e) { /* ignore */ } }
  else state.watching++;
});
$('searchPosts').addEventListener('click', () => runPostScan('search'));
$('scanFeed').addEventListener('click', () => runPostScan('feed'));
$('stop').addEventListener('click', () => {
  if (!state.running) { // only a watch is pending
    state.watching++;
    $('watch').checked = false;
    $('stop').disabled = true;
    save();
    return status('Stopped watching.');
  }
  state.stop = true;
  status('Stopping…');
  if (state.scanTabId) {
    chrome.scripting.executeScript({ target: { tabId: state.scanTabId }, func: () => { window.__ljsStop = true; } }).catch(() => {});
  }
});
$('csv').addEventListener('click', exportCsv);
$('clear').addEventListener('click', () => {
  if (state.running) return;
  const what = state.tab === 'posts' ? 'hiring posts' : 'jobs';
  if (!confirm(`Remove all saved ${what}?`)) return;
  if (state.tab === 'posts') state.posts = {};
  else state.jobs = {};
  render();
  save();
});
document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
$('search').addEventListener('input', render);
document.querySelector('aside').addEventListener('input', () => { render(); save(); });

chrome.storage.local.get(['jobs', 'posts', 'sources', 'settings']).then((d) => {
  state.jobs = d.jobs || {};
  state.posts = d.posts || {};
  state.sources = d.sources || {};
  // Results saved by an older version: fill in the newer fields.
  Object.values(state.jobs).forEach((j) => {
    if (j.detailed && j.description && (j.visa === undefined || j.applicantsN === undefined)) enrich(j);
    if (!j.postedAt) j.postedAt = Date.parse(j.postedDate) || Date.parse(j.scrapedAt) || 0;
  });
  Object.values(state.posts).forEach((p) => p.years === undefined && (p.years = LJS.extractYears(p.text)));
  applySettings(d.settings);
  $('watch').checked = false; // watching never restarts by itself
  render();
});
