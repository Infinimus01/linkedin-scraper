// Pure helpers: URL building, HTML parsing and text classification.
// No chrome.* APIs here so this file can be tested outside the extension.
(function (root) {
  const SEARCH_BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
  const DETAIL_BASE = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/';
  const POSTS_BASE = 'https://www.linkedin.com/search/results/content/';
  const PAGE_SIZE = 10;

  // ---------- locations ----------
  // LinkedIn has no single "Europe" region, so it is expanded into the regions it does know.
  const REGION_ALIASES = {
    europe: ['European Union', 'United Kingdom', 'Switzerland', 'Norway'],
    eu: ['European Union'],
    uk: ['United Kingdom'],
    usa: ['United States'],
    us: ['United States'],
    uae: ['United Arab Emirates'],
    worldwide: [''],
    anywhere: [''],
  };
  function expandLocations(input) {
    const out = [];
    String(input || '')
      .split(/[,\n;]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((loc) => (REGION_ALIASES[loc.toLowerCase()] || [loc]).forEach((l) => out.includes(l) || out.push(l)));
    return out.length ? out : [''];
  }

  // ---------- URLs ----------
  function buildSearchUrl(opts, start) {
    const p = new URLSearchParams();
    p.set('keywords', opts.keywords);
    if (opts.location) p.set('location', opts.location);
    if (opts.seconds) p.set('f_TPR', 'r' + opts.seconds);
    if (opts.levels && opts.levels.length) p.set('f_E', opts.levels.join(','));
    if (opts.workTypes && opts.workTypes.length) p.set('f_WT', opts.workTypes.join(','));
    if (opts.early) p.set('f_EA', 'true'); // LinkedIn's "under 10 applicants" filter
    p.set('sortBy', opts.sort === 'relevant' ? 'R' : 'DD');
    p.set('start', String(start || 0));
    return SEARCH_BASE + '?' + p.toString();
  }

  // LinkedIn post search (needs the signed-in browser tab).
  function buildPostSearchUrl(role, place, last24h) {
    const kw = ['hiring', role, place].filter(Boolean).join(' ');
    return (
      POSTS_BASE + '?keywords=' + encodeURIComponent(kw) + '&origin=FACETED_SEARCH&sortBy=%22date_posted%22' +
      (last24h ? '&datePosted=%22past-24h%22' : '')
    );
  }

  // ---------- job HTML parsing ----------
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const text = (el) => (el ? clean(el.textContent) : '');

  function parseCards(doc) {
    const out = [];
    doc.querySelectorAll('[data-entity-urn*="jobPosting:"]').forEach((card) => {
      const m = /jobPosting:(\d+)/.exec(card.getAttribute('data-entity-urn') || '');
      if (!m) return;
      const link = card.querySelector('a.base-card__full-link, a[href*="/jobs/view/"]');
      const companyLink = card.querySelector('.base-search-card__subtitle a');
      const time = card.querySelector('time');
      out.push({
        id: m[1],
        title: text(card.querySelector('.base-search-card__title')),
        company: text(card.querySelector('.base-search-card__subtitle')),
        companyUrl: companyLink ? (companyLink.getAttribute('href') || '').split('?')[0] : '',
        location: text(card.querySelector('.job-search-card__location')),
        postedDate: time ? time.getAttribute('datetime') || '' : '',
        postedText: text(time),
        url: link ? (link.getAttribute('href') || '').split('?')[0] : 'https://www.linkedin.com/jobs/view/' + m[1],
      });
    });
    return out;
  }

  function parseDetail(doc) {
    const d = { description: '', seniority: '', employmentType: '', applicants: '', closed: false };
    const body = doc.querySelector('.show-more-less-html__markup');
    if (body) {
      const html = body.innerHTML
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|li|ul|ol|div|h\d)>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ');
      const tmp = doc.createElement('div');
      tmp.innerHTML = html;
      d.description = tmp.textContent.replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
    }
    doc.querySelectorAll('.description__job-criteria-item').forEach((li) => {
      const k = text(li.querySelector('.description__job-criteria-subheader')).toLowerCase();
      const v = text(li.querySelector('.description__job-criteria-text'));
      if (k.includes('seniority')) d.seniority = v;
      else if (k.includes('employment')) d.employmentType = v;
    });
    d.applicants = text(doc.querySelector('.num-applicants__caption, [class*="num-applicants"]'));
    d.closed = /no longer accepting applications/i.test(doc.body ? doc.body.textContent : '');
    return d;
  }

  // ---------- applicants and posting time ----------
  // "58 applicants" -> 58, "Be among the first 25 applicants" -> 24, "Over 200 applicants" -> 201.
  function applicantCount(str) {
    const m = /(\d[\d,]*)/.exec(str || '');
    if (!m) return null;
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    if (/first/i.test(str)) return n - 1;
    if (/over|more than|\+/i.test(str)) return n + 1;
    return n;
  }
  // "14 minutes ago" -> 14, "2 hours ago" -> 120. Null when it cannot be read.
  function postedMinutes(str) {
    const t = (str || '').toLowerCase();
    if (/just now|moments? ago/.test(t)) return 0;
    const m = /(\d+)\s*(minute|hour|day|week|month)/.exec(t);
    if (!m) return null;
    return parseInt(m[1], 10) * { minute: 1, hour: 60, day: 1440, week: 10080, month: 43200 }[m[2]];
  }

  // ---------- years of experience ----------
  // Returns { min, max } (max is null for "5+ years") or null if not stated.
  function extractYears(desc) {
    if (!desc) return null;
    const re = /(\d{1,2})\s*(?:\+|plus)?\s*(?:(?:-|–|—|to)\s*(\d{1,2})\s*\+?\s*)?(?:years?|yrs?)\b/gi;
    const found = [];
    let m;
    while ((m = re.exec(desc))) {
      const lo = parseInt(m[1], 10);
      const hi = m[2] ? parseInt(m[2], 10) : null;
      if (lo > 30 || (hi !== null && (hi > 40 || hi < lo))) continue;
      const around = desc.slice(Math.max(0, m.index - 60), m.index + m[0].length + 90).toLowerCase();
      if (!/experience|exp\b|hands[- ]on|working (with|in|on)|background|industry|professional|relevant/.test(around)) continue;
      found.push({ min: lo, max: hi });
    }
    if (!found.length) return null;
    return found.reduce((a, b) => (b.min > a.min ? b : a));
  }
  function yearsLabel(y) {
    if (!y) return '';
    return y.max ? y.min + '-' + y.max : y.min + '+';
  }

  // ---------- emails ----------
  function extractEmails(str) {
    if (!str) return [];
    const t = String(str)
      .replace(/\s*[\[({]\s*at\s*[\])}]\s*/gi, '@')
      .replace(/\s*[\[({]\s*dot\s*[\])}]\s*/gi, '.');
    const out = [];
    (t.match(/[a-z0-9][a-z0-9._%+-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) || []).forEach((e) => {
      e = e.replace(/[.\-]+$/, '').toLowerCase();
      if (!/\.[a-z]{2,}$/.test(e)) return;
      if (/\.(png|jpe?g|gif|svg|webp)$/.test(e) || /^(no-?reply|donotreply)@/.test(e)) return;
      if (!out.includes(e)) out.push(e);
    });
    return out;
  }

  // ---------- visa sponsorship ----------
  // 'no' = says it will not sponsor, 'yes' = mentions sponsorship or relocation, '' = not mentioned.
  const VISA_NO = [
    /\b(no|not|unable to|cannot|can't|can not|won't|will not|don't|doesn't|do not|does not|without)\s+(?:[\w'-]+\s+){0,6}?(?:visa\s+)?sponsor/i,
    /sponsorship\s+(?:is\s+|are\s+)?(?:not|un)\s*(?:available|offered|provided|possible)/i,
    /not\s+eligible\s+for\s+(?:visa\s+)?sponsorship/i,
    /must\s+(?:already\s+)?(?:have|hold|possess)\s+(?:a\s+|an\s+|the\s+)?(?:valid\s+|existing\s+|full\s+)?(?:right to work|work (?:permit|authori[sz]ation))/i,
    /(?:right to work|work authori[sz]ation|work permit)\s+(?:is\s+)?(?:required|mandatory)/i,
  ];
  const VISA_YES = /visa\s+(?:sponsorship|support|assistance)|sponsor(?:s|ing)?\s+(?:your\s+|a\s+|an\s+|the\s+|work\s+|employment\s+)*visas?|relocation\s+(?:support|assistance|package|bonus|allowance)|we\s+(?:can|will|do)\s+sponsor|sponsorship\s+(?:is\s+)?(?:available|provided|offered|possible)|blue\s+card|skilled\s+worker\s+visa|\bh-?1b\b/i;
  function visaStatus(desc) {
    if (!desc) return '';
    if (VISA_NO.some((re) => re.test(desc))) return 'no';
    if (VISA_YES.test(desc)) return 'yes';
    return '';
  }

  // ---------- company career pages (Greenhouse, Lever, Ashby public job feeds) ----------
  const ATS_URL = {
    greenhouse: (slug) => 'https://boards-api.greenhouse.io/v1/boards/' + slug + '/jobs?content=true',
    lever: (slug) => 'https://api.lever.co/v0/postings/' + slug + '?mode=json',
    ashby: (slug) => 'https://api.ashbyhq.com/posting-api/job-board/' + slug,
  };
  const atsUrl = (ats, slug) => ATS_URL[ats](encodeURIComponent(slug));

  // Turns what the user typed (a company name or a career page link) into feeds to try.
  function companyCandidates(entry) {
    const e = String(entry || '').trim();
    let m;
    if ((m = /greenhouse\.io\/(?:embed\/job_board\?for=)?([\w-]+)/i.exec(e))) return [{ ats: 'greenhouse', slug: m[1].toLowerCase() }];
    if ((m = /lever\.co\/([\w-]+)/i.exec(e))) return [{ ats: 'lever', slug: m[1].toLowerCase() }];
    if ((m = /ashbyhq\.com\/([\w.-]+)/i.exec(e))) return [{ ats: 'ashby', slug: m[1] }];
    const words = e.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/[\s-]+/).filter(Boolean);
    if (!words.length) return [];
    const slugs = [...new Set([words.join(''), words.join('-')])];
    const out = [];
    slugs.forEach((slug) => ['greenhouse', 'lever', 'ashby'].forEach((ats) => out.push({ ats, slug })));
    return out;
  }

  function htmlToText(str) {
    const decode = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&rsquo;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    return decode(decode(String(str || '')).replace(/<(br|\/p|\/li|\/div|\/h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' '))
      .replace(/[ \t]+/g, ' ').replace(/ ?\n\s*/g, '\n').trim();
  }
  function countryName(code) {
    try { return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) || ''; } catch (e) { return ''; }
  }

  // Normalises one company's feed into the same job shape the LinkedIn search produces.
  function parseAts(ats, slug, data, typedName) {
    const pretty = /[\/.]/.test(typedName || '') ? slug.charAt(0).toUpperCase() + slug.slice(1) : typedName || slug;
    const make = (id, title, company, location, url, postedAt, description) => ({
      id: ats + ':' + slug + ':' + id, title: clean(title), company, location: clean(location), url,
      postedAt: postedAt || 0, postedDate: '', postedText: '', description, source: 'Company site',
    });
    if (ats === 'greenhouse') {
      return ((data && data.jobs) || []).map((j) =>
        make(j.id, j.title, j.company_name || pretty, j.location && j.location.name, j.absolute_url,
          Date.parse(j.first_published || j.updated_at), htmlToText(j.content)));
    }
    if (ats === 'lever') {
      return (Array.isArray(data) ? data : []).map((j) => {
        const loc = (j.categories && j.categories.location) || '';
        const country = j.country ? countryName(j.country) : '';
        const lists = (j.lists || []).map((l) => (l.text || '') + '\n' + htmlToText(l.content)).join('\n');
        return make(j.id, j.text, pretty, country && !loc.toLowerCase().includes(country.toLowerCase()) ? loc + ', ' + country : loc,
          j.hostedUrl, +j.createdAt, [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join('\n'));
      });
    }
    if (ats === 'ashby') {
      return ((data && data.jobs) || []).filter((j) => j.isListed !== false).map((j) => {
        const more = (j.secondaryLocations || []).map((x) => x.location).filter(Boolean);
        const addr = j.address && j.address.postalAddress && j.address.postalAddress.addressCountry;
        return make(j.id, j.title, pretty, [j.location, ...more, addr].filter(Boolean).join('; '), j.jobUrl,
          Date.parse(j.publishedAt), j.descriptionPlain || htmlToText(j.descriptionHtml));
      });
    }
    return [];
  }

  // Company feeds describe places freely ("Bengaluru", "Remote - EMEA"), so a region is a word list.
  const PLACE_WORDS = {
    india: ['india', 'bengaluru', 'bangalore', 'hyderabad', 'pune', 'mumbai', 'gurgaon', 'gurugram', 'noida', 'chennai', 'delhi', 'kolkata', 'ahmedabad'],
    'european union': ['europe', 'emea', 'austria', 'belgium', 'bulgaria', 'croatia', 'cyprus', 'czech', 'denmark', 'estonia', 'finland', 'france', 'germany', 'greece', 'hungary', 'ireland', 'italy', 'latvia', 'lithuania', 'luxembourg', 'malta', 'netherlands', 'poland', 'portugal', 'romania', 'slovakia', 'slovenia', 'spain', 'sweden', 'berlin', 'munich', 'paris', 'amsterdam', 'dublin', 'madrid', 'barcelona', 'stockholm', 'lisbon', 'warsaw', 'prague', 'vienna', 'copenhagen', 'helsinki'],
    'united kingdom': ['united kingdom', 'uk', 'london', 'england', 'scotland', 'manchester', 'edinburgh', 'wales'],
    'united states': ['united states', 'usa', 'new york', 'san francisco', 'seattle', 'austin', 'boston', 'chicago', 'los angeles', 'denver', 'atlanta'],
    'united arab emirates': ['united arab emirates', 'uae', 'dubai', 'abu dhabi'],
  };
  function locationMatches(jobLocation, userLocations) {
    if (!userLocations || !userLocations.length || userLocations.includes('')) return true;
    const t = (jobLocation || '').toLowerCase();
    return userLocations.some((u) =>
      (PLACE_WORDS[u.toLowerCase()] || [u.toLowerCase()]).some((w) => (w.length <= 3 ? new RegExp('\\b' + w + '\\b').test(t) : t.includes(w))));
  }

  // ---------- role matching ----------
  const GENERIC = new Set(['engineer', 'engineers', 'developer', 'developers', 'senior', 'junior', 'lead', 'staff', 'principal', 'sr', 'jr', 'i', 'ii', 'iii', 'intern', 'associate', 'the', 'and', 'of']);
  const SYNONYMS = { software: ['software', 'sde', 'swe'], frontend: ['frontend', 'ui'], fullstack: ['fullstack'], devops: ['devops', 'sre'] };
  const normalise = (s) =>
    String(s || '').toLowerCase().replace(/back[\s-]end/g, 'backend').replace(/front[\s-]end/g, 'frontend').replace(/full[\s-]stack/g, 'fullstack');

  // A role becomes a list of regex sources; a text matches the role when every one matches.
  function rolePatterns(role) {
    const words = normalise(role).split(/[^a-z0-9+#.]+/).filter(Boolean);
    let core = words.filter((w) => !GENERIC.has(w));
    if (!core.length) core = words;
    return core.map((w) => '\\b(?:' + (SYNONYMS[w] || [w]).map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')s?(?![a-z0-9])');
  }
  function matchesAnyRole(str, roles) {
    if (!roles || !roles.length) return true;
    const t = normalise(str);
    return roles.some((r) => rolePatterns(r).every((src) => new RegExp(src, 'i').test(t)));
  }

  root.LJS = {
    SEARCH_BASE, DETAIL_BASE, PAGE_SIZE,
    expandLocations, buildSearchUrl, buildPostSearchUrl, parseCards, parseDetail,
    applicantCount, postedMinutes, extractYears, yearsLabel, extractEmails, visaStatus, atsUrl, companyCandidates, parseAts, htmlToText, locationMatches, rolePatterns, matchesAnyRole, normalise,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
