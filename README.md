# Rotating Photo Album

A self-hosted digital photo frame that turns old iPads into a live slideshow from a private Google Drive folder.

Built for my dad, who wanted to put a couple of retired iPads to use.

## Features

- Shuffled slideshow that syncs with Google Drive every few minutes
- Automatically skips exact duplicate photos
- Hide button to remove similar shots from the rotation, with undo
- Runs on older iPads (plain ES5, no frameworks)
- Drive folder stays private; access is behind a secret URL

## Tech Stack

- **Cloudflare Workers** for hosting, API, and image proxy
- **Cloudflare KV** for the hidden-photo list
- **Google Drive API** with a read-only service account
- **Vanilla HTML/CSS/JavaScript** for the slideshow

## How It Works

The Worker authenticates to Google as a service account, lists the images in one Drive folder, and serves them to the slideshow as screen-sized JPEGs. Credentials are stored as Cloudflare secrets and never reach the browser.

## Setup

1. **Install**
   ```bash
   npm install
   ```

2. **Google Cloud:** enable the Google Drive API, create a service account, download its JSON key, and share your Drive folder with the service account's email as Viewer.

3. **Configure:** add your folder ID and a KV namespace to `wrangler.jsonc`:
   ```bash
   npx wrangler kv namespace create HIDDEN
   ```
   ```jsonc
   "vars": { "FOLDER_ID": "your-folder-id" },
   "kv_namespaces": [{ "binding": "HIDDEN", "id": "your-kv-id" }]
   ```

4. **Deploy and add secrets**
   ```bash
   npm run deploy
   npx wrangler secret put FRAME_TOKEN
   npx wrangler secret bulk secrets.key.json   # { "GOOGLE_SERVICE_ACCOUNT": "<key JSON as a string>" }
   ```

5. **Open** `https://photo-frame.<subdomain>.workers.dev/f/<FRAME_TOKEN>/`

## Usage

On the iPad, open the link in Safari, tap **Share → Add to Home Screen**, set Auto-Lock to Never, and use Guided Access to keep it on the slideshow.

Tap the screen to see the current photo and the **Next**, **Hide**, and **Sync** controls. Add `?seconds=20` to the URL to change how long each photo is shown.

## Project Structure

```
src/
  index.js      Cloudflare Worker (auth, Drive API, routing)
  frame.html    Slideshow page
wrangler.jsonc  Worker configuration
```