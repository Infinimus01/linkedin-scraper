# LinkedIn Jobs Scraper

A Chrome extension that finds jobs early. It collects fresh LinkedIn job postings, hiring posts where recruiters share an email address, and new openings on company career pages, then lets you filter them and export a short CSV.

## What it does

- **LinkedIn jobs** by role, location and posting time (down to the past 30 minutes).
- **Early jobs**: search only jobs with under 10 applicants, cap the applicant count, sort by fewest applicants.
- **Watch mode**: re-checks every few minutes and sends a desktop alert when a new matching job appears.
- **Hiring posts with emails**: scans LinkedIn post search and your own feed for posts like "send your resume to …", and pulls out the email.
- **Company career pages**: reads open jobs straight from companies whose careers site runs on Greenhouse, Lever or Ashby. Jobs often appear there before LinkedIn.
- **Filters**: years of experience, visa sponsorship, title must match your roles, hide repeats, hide closed jobs.
- **CSV export**: job, company, location, posted time, applicants, years of experience, visa sponsorship, email, source and link. No job descriptions.

## Install

1. Download this repository: **Code → Download ZIP**, then unzip it. Or clone it:
   ```bash
   git clone https://github.com/Infinimus01/linkedin-scraper.git
   ```
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `linkedin-jobs-scraper` folder inside this repository.
5. Click the extension's icon in the Chrome toolbar. The scraper opens in its own tab.

To update later, pull the new code and press the reload icon on the extension at `chrome://extensions`.

## Which tabs to open

| What you want | Tabs you need | LinkedIn sign-in |
|---|---|---|
| Scrape LinkedIn jobs | Only the scraper tab | Not needed |
| Company career pages | Only the scraper tab | Not needed |
| Watch mode | Only the scraper tab, left open | Not needed |
| Search all of LinkedIn for hiring posts | The scraper tab. It opens LinkedIn tabs by itself and closes them when done | Needed, in the same Chrome |
| Scan my feed | The scraper tab. It uses an open `linkedin.com/feed` tab, or opens one | Needed, in the same Chrome |

Inside the scraper there are two result tabs: **Jobs** (LinkedIn jobs and company career page jobs) and **Hiring posts** (posts with emails).

## How to run

### Find jobs

1. Enter your roles, one per line, for example `Backend Engineer`.
2. Enter a location. Several are allowed, separated by commas. `Europe` searches the European Union, United Kingdom, Switzerland and Norway.
3. Pick **Posted within**, for example Past 24 hours.
4. Optionally set years of experience, visa sponsorship and the applicant options.
5. Press **Scrape jobs**. Results fill the Jobs tab as they arrive.
6. Press **Export CSV** to save what the table currently shows.

### Be first to new jobs

1. Set **Posted within** to Past hour or Past 30 minutes.
2. Tick **Only jobs with under 10 applicants**.
3. Tick **Keep watching and alert me to new jobs** and leave it at 10 minutes.
4. Press **Scrape jobs** and keep the scraper tab open. Allow notifications when Chrome asks.

New jobs get a desktop notification, a green NEW tag, and a count in the tab title.

### Find hiring posts with emails

1. Sign in to LinkedIn in the same Chrome.
2. Press **Search all of LinkedIn** to search posts for each of your roles, or **Scan my feed** to read your own feed.
3. A LinkedIn tab opens and scrolls by itself. Leave it in front until it finishes.
4. Open the **Hiring posts** tab. Tick **Only show posts with an email** to narrow it down.

### Watch company career pages

1. In **Company career pages**, add company names or career page links, one per line:
   ```
   Stripe
   https://jobs.lever.co/palantir
   ```
2. Press **Scrape jobs**. Company jobs appear in the Jobs tab with "Company site" in the Source column.
3. The status bar reports how many jobs matched per company, or "no career page found".

## Settings explained

- **Jobs N of M**: M jobs were collected and N pass your filters. The line under the status bar says how many each filter hid.
- **How far to scroll**: how many screens of posts a hiring-post scan reads before stopping.
- **Quick mode**: skips opening each job, so it is faster but has no years, visa, email or applicant count.
- **Max jobs per role and location**: LinkedIn's public listing stops at about 1,000 results per search.

## Limits

- The years of experience and visa sponsorship values are read from the job description text. They can be missing or wrong.
- LinkedIn's public pages give coarse applicant counts: "among the first 25", an exact number, or "over 200".
- Watch mode stops when the scraper tab is closed or the computer sleeps.
- Company career pages only work for Greenhouse, Lever and Ashby. A bare company name can match the wrong company; paste the career page link if it does.
- The hiring-post scan depends on LinkedIn's page layout, which changes often. If it finds nothing on a page that clearly shows hiring posts, the scanner needs an update.
- LinkedIn slows down or blocks rapid requests. The extension waits 1–3 seconds between requests and backs off when asked to.

## Responsible use

LinkedIn's terms of service prohibit automated scraping. This tool is meant for personal job hunting at a modest pace. The job search uses public pages without your login; the hiring-post scan runs inside your signed-in session, so keep scroll counts low. You use it at your own risk.

## Files

| File | Purpose |
|---|---|
| `linkedin-jobs-scraper/manifest.json` | Extension definition and permissions |
| `linkedin-jobs-scraper/app.html`, `app.css`, `app.js` | The scraper page |
| `linkedin-jobs-scraper/core.js` | Search URLs, parsing, and the years, visa, email and role logic |
| `linkedin-jobs-scraper/feed.js` | The hiring-post scanner that runs inside LinkedIn tabs |
| `linkedin-jobs-scraper/background.js` | Opens the scraper page from the toolbar icon |
| `linkedin-jobs-scraper/timer-worker.js` | Keeps timing steady when the tab is in the background |
