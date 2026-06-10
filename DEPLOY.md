# Deploying Waypoint

Your app lives entirely in one file: `index.html`. No installs, no builds, no dependencies.

---

## Option 1 — Netlify (easiest, 60 seconds)

1. Go to [netlify.com](https://netlify.com) and create a free account (or sign in)
2. From your dashboard, look for **"Sites"** and scroll to the bottom
3. Drag your `index.html` file directly onto the big **"drag and drop"** area on that page
4. Netlify gives you a live URL instantly — something like `brave-lion-abc123.netlify.app`
5. Optional: click **"Site settings" → "Change site name"** to get a nicer URL

That's it. Your site is live.

---

## Option 2 — GitHub + Netlify (recommended for long term)

This lets you update the app just by saving a file — no re-dragging needed.

### One-time setup

1. Create a free account at [github.com](https://github.com) if you don't have one
2. Click the **+** icon → **"New repository"**
3. Name it `waypoint` (or anything you like), make it **Public**, click **"Create repository"**
4. On the next page, click **"uploading an existing file"**
5. Drag `index.html` onto the upload area, click **"Commit changes"**
6. Go to [netlify.com](https://netlify.com), click **"Add new site" → "Import an existing project"**
7. Connect your GitHub account, select your `waypoint` repository
8. Leave all settings as-is and click **"Deploy site"**

### Updating the app later

1. Make changes to `index.html`
2. Go to your GitHub repo → click `index.html` → click the pencil ✏️ edit icon
3. Paste in your updated file, click **"Commit changes"**
4. Netlify detects the change and redeploys automatically in ~30 seconds

---

## Sharing with beta users

Once deployed, just send people the Netlify URL. Works on mobile too.

For your first 20 users: share it as a link in DMs, not a public post. You want real
feedback, not noise. Ask each person: "What did you expect to happen that didn't?"

---

## What's in the app right now

- 6 screens: landing → year → courses → coverage map → 5-question session → results
- 25 real MCAT-style questions (Biology I, Gen Chemistry I, Statistics)
- Full coverage map showing all 17 MCAT content areas
- Streak tracking and session persistence (stored in the browser)
- Returning users go straight to their map

## Coming next

- More questions (target: 20 per course × 12 courses = 240 questions)
- User accounts so progress syncs across devices
- Spaced repetition to surface weak areas
- Semester review card ("Spotify Wrapped" for MCAT coverage)
