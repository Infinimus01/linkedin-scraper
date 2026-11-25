// Injected on demand into a signed-in LinkedIn tab (the feed or a post search page).
// Scrolls, expands truncated posts, and returns posts that look like hiring posts,
// including any email address written in the post.
// Must stay self-contained: it is serialised and run inside the LinkedIn page.
async function ljsScanPosts(opts) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__ljsStop = false;

  const hiringRe = /\b(hiring|job opening|open (role|position)s?|opening for|openings?\b|looking for (a|an|someone|candidates|engineers|developers|talented|experienced|skilled)|join (our|my|the) team|apply (now|here)|vacanc(y|ies)|referrals?|(send|share|email|mail|drop|forward) (us |me )?(your|ur) (cv|resume|profile)|interested candidates|dm me|walk-?in)\b/i;
  const seekerRe = /#?open\s?to\s?work|\b(i am|i'm|im|currently|actively)\s+(looking|seeking|searching)\s+for\b|\blooking for (a |an )?(new |my next |better )?(job|role|opportunit|position|internship)|\bseeking (a |an )?(new )?(job|role|opportunit|position)|please (refer|consider) me|any (openings?|opportunit(y|ies)|leads?) for me|\bmy resume\b|was laid off|got laid off/i;
  const emailTest = /[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z]{2,}/i;
  const roleRes = (opts.rolePatterns || []).map((group) => group.map((src) => new RegExp(src, 'i')));
  const normalise = (s) => s.toLowerCase().replace(/back[\s-]end/g, 'backend').replace(/front[\s-]end/g, 'frontend').replace(/full[\s-]stack/g, 'fullstack');
  const seen = new Map();
  let mode = 'known';

  const emailsIn = (str) => {
    const t = str.replace(/\s*[\[({]\s*at\s*[\])}]\s*/gi, '@').replace(/\s*[\[({]\s*dot\s*[\])}]\s*/gi, '.');
    const out = [];
    (t.match(/[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) || []).forEach((e) => {
      e = e.replace(/[.\-]+$/, '').toLowerCase();
      if (/\.[a-z]{2,}$/.test(e) && !out.includes(e)) out.push(e);
    });
    return out;
  };

  // Posts found through attributes LinkedIn has used for years.
  const knownNodes = () => {
    const set = new Set(
      document.querySelectorAll('[data-urn^="urn:li:activity"], [data-id^="urn:li:activity"], [data-urn^="urn:li:ugcPost"], div.feed-shared-update-v2, main [role="article"]')
    );
    return [...set].filter((n) => ![...set].some((o) => o !== n && o.contains(n)));
  };

  // Layout-independent fallback: start from any text that looks like a hiring line or an
  // email, then climb to the block that holds the whole post (the point where the parent
  // suddenly contains much more text, i.e. other posts).
  const genericNodes = () => {
    const rootEl = document.querySelector('main') || document.body;
    const out = new Set();
    const tw = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = tw.nextNode())) {
      const v = t.nodeValue;
      if (!v || v.length < 8 || !(hiringRe.test(v) || emailTest.test(v))) continue;
      let el = t.parentElement;
      if (!el) continue;
      const marked = el.closest('[data-ljs-post]');
      if (marked) { out.add(marked); continue; }
      let len = (el.innerText || '').length;
      while (el.parentElement && el.parentElement !== rootEl && el.parentElement !== document.body) {
        const p = el.parentElement;
        const plen = (p.innerText || '').length;
        if (len > 200 && plen > len * 1.7 + 300 && el.querySelector('a[href*="/in/"], a[href*="/company/"]')) break;
        if (plen > 12000) break;
        el = p;
        len = plen;
      }
      el.setAttribute('data-ljs-post', '1');
      out.add(el);
    }
    return [...out].filter((n) => ![...out].some((o) => o !== n && o.contains(n)));
  };

  const postNodes = () => {
    const known = knownNodes();
    if (known.length) return known;
    mode = 'generic';
    return genericNodes();
  };

  // Click "…more" so the full post text (where the email usually is) is on the page.
  const expand = (n) => {
    n.querySelectorAll('button, [role="button"]').forEach((b) => {
      if (b.dataset.ljsDone) return;
      const s = (b.innerText || '').trim().toLowerCase();
      if (/^(…|\.\.\.)?\s*(see\s+)?more$/.test(s)) {
        b.dataset.ljsDone = '1';
        try { b.click(); } catch (e) { /* ignore */ }
      }
    });
  };

  // Keep only the post itself: everything before the Like / Comment action bar.
  const bodyOf = (raw) => {
    const m = /\n\s*Like\s*\n\s*Comment\b/.exec(raw);
    return (m ? raw.slice(0, m.index) : raw).trim();
  };
  const ageOf = (txt) => {
    const m = /(?:^|\s)(now|\d+\s?(?:mo|yr|m|h|d|w))\s*•/.exec(txt.slice(0, 500));
    return m ? m[1].replace(/\s/g, '') : '';
  };
  const isRecent = (age) => !age || age === 'now' || /^\d+(m|h)$/.test(age);

  const collect = () => {
    const nodes = postNodes();
    for (const n of nodes) {
      const raw = (n.innerText || '').trim();
      if (raw.length < 40) continue;
      const body = bodyOf(raw);
      const urn = n.getAttribute('data-urn') || n.getAttribute('data-id') || '';
      const key = urn || body.replace(/\s+/g, ' ').slice(0, 160);
      const jobLink = n.querySelector('a[href*="/jobs/view/"]');
      const mailto = [...n.querySelectorAll('a[href^="mailto:"]')].map((a) => a.getAttribute('href').slice(7).split('?')[0].toLowerCase());
      const emails = [...new Set([...emailsIn(body), ...mailto])];
      const prev = seen.get(key);
      if (prev && prev.text.length >= Math.min(body.length, 4000) && prev.emails) continue;

      if (seekerRe.test(body)) continue; // someone looking for a job, not offering one
      if (!(hiringRe.test(body) || jobLink || emails.length)) continue;
      const norm = normalise(body);
      const matchesRole = !roleRes.length || roleRes.some((group) => group.every((re) => re.test(norm)));
      if (opts.requireRole && !matchesRole) continue;
      const age = ageOf(raw);
      if (opts.last24h && !isRecent(age)) continue;

      const authorLink = [...n.querySelectorAll('a[href*="/in/"], a[href*="/company/"]')].find((a) => (a.innerText || '').trim());
      const postLink = n.querySelector('a[href*="/feed/update/"], a[href*="/posts/"]');
      seen.set(key, {
        id: key,
        author: authorLink ? authorLink.innerText.trim().split('\n')[0].trim() : '',
        authorUrl: authorLink ? authorLink.href.split('?')[0] : '',
        age,
        text: body.replace(/\n{2,}/g, '\n').slice(0, 4000),
        postUrl: /^urn:li:(activity|ugcPost)/.test(urn) ? 'https://www.linkedin.com/feed/update/' + urn + '/' : postLink ? postLink.href.split('?')[0] : '',
        jobUrl: jobLink ? jobLink.href.split('?')[0] : '',
        emails: emails.join(', '),
        matchesRole,
      });
    }
    return nodes;
  };

  const total = Math.max(1, Math.min(200, opts.scrolls || 30));
  let idle = 0;
  let lastHeight = 0;
  let nodesSeen = 0;
  for (let i = 0; i < total && !window.__ljsStop; i++) {
    postNodes().forEach(expand);
    await sleep(350);
    const nodes = collect();
    nodesSeen = Math.max(nodesSeen, nodes.length);

    // Scroll in a way that works whether the page or an inner panel scrolls.
    const last = nodes[nodes.length - 1];
    if (last) last.scrollIntoView({ block: 'end' });
    window.scrollBy(0, Math.round(window.innerHeight * 0.9));
    document.querySelectorAll('button').forEach((b) => {
      if (/^(show|see|load) more( results| posts)?$/i.test((b.innerText || '').trim())) b.click();
    });
    await sleep(1000 + Math.random() * 900);

    const h = document.documentElement.scrollHeight;
    idle = h === lastHeight ? idle + 1 : 0;
    lastHeight = h;
    if (idle >= 6) break; // nothing new is loading
  }
  postNodes().forEach(expand);
  await sleep(350);
  collect();
  return { posts: [...seen.values()], nodesSeen, mode, url: location.href };
}
