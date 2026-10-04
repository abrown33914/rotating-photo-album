# Rotating Photo Album

A digital photo frame for old iPads. It plays a shuffled slideshow from a private Google Drive folder, picks up new photos automatically, and drops deleted ones within a few minutes, so the album can be curated from a phone while it's playing.

Built as a single Cloudflare Worker that serves the slideshow page, lists the folder, and proxies the photos. The Drive folder stays private, no credentials ever reach the browser, and the whole thing runs on free tiers.

## Features

- **Live sync.** The frame re-checks the folder every few minutes. New photos are slotted into the shuffle; removed photos disappear, and if one is on screen when it's removed, the frame skips ahead.
- **Automatic duplicate skipping.** Byte-identical files (same photo uploaded twice) are detected by checksum and only shown once.
- **Tap for info.** Tapping the screen shows the current file name, photo count, duplicates skipped, and last sync time, plus *Next photo* and *Sync now* buttons. The file name makes it easy to find and delete a near-duplicate in Drive.
- **Runs on old iPads.** The slideshow page is plain ES5 JavaScript with no frameworks, so it works on Safari versions stuck on iOS 9 and 10.
- **Phone-friendly photos.** Images are served as screen-sized JPEGs with rotation already applied, including iPhone HEIC photos that older Safari can't open.
- **Private by default.** Everything lives behind a secret URL token. Any other path returns 404.

## How it works

```
iPad (Safari)  ──►  Cloudflare Worker  ──►  Google Drive API
                    /f/<token>/              (service account,
                    ├─ slideshow page         read-only)
                    ├─ api/photos  (list)
                    └─ photo/<id>  (image)
```

The Worker signs in to Google as a **service account** that has Viewer access to one folder. It caches the folder listing for a minute and its Google access token for about an hour. Photos are sent with a one-week private cache header, so the iPad reloads repeat photos from its own cache.

## Project structure

```
src/
  index.js      Worker: routing, token check, Google sign-in, Drive listing, photo proxy
  frame.html    Slideshow page (ES5, served by the Worker)
wrangler.jsonc  Worker config and FOLDER_ID
```

## Setup

### Requirements

- Node.js (LTS), Git
- A free Cloudflare account
- A Google account for Google Cloud. Use a personal Gmail account; school and work accounts often block service account key creation.

### 1. Install

```bash
git clone <this repo>
cd rotating-photo-album
npm install
```

### 2. Create the Google service account

1. In [Google Cloud Console](https://console.cloud.google.com), create a project and enable the **Google Drive API**.
2. Go to **IAM & Admin → Service Accounts → Create service account**. No roles are needed.
3. Open the account → **Keys → Add key → Create new key → JSON**. Rename the download to `google.key.json` and place it in the project root. `*.key.json` is gitignored.
4. In Google Drive, share the photo folder with the service account's email as **Viewer**.

### 3. Configure the folder

Copy the folder ID (the part of the folder URL after `/folders/`) into `wrangler.jsonc`:

```jsonc
"vars": {
  "FOLDER_ID": "your-folder-id"
}
```

Use the real folder's ID, not a shortcut's. Only photos directly inside the folder are shown, not photos in subfolders.

### 4. Deploy

```bash
npx wrangler login
npm run deploy
```

### 5. Add secrets

Generate a token for the private URL, save it somewhere, and upload it:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
npx wrangler secret put FRAME_TOKEN
```

Upload the Google key. Writing it to a file and using `secret bulk` avoids piping, which can silently upload an empty secret on Windows:

```bash
node -e "require('fs').writeFileSync('secrets.key.json', JSON.stringify({GOOGLE_SERVICE_ACCOUNT: JSON.stringify(require('./google.key.json'))}))"
npx wrangler secret bulk secrets.key.json
```

Then **delete `google.key.json` and `secrets.key.json`** from the project folder.

### 6. Open the frame

```
https://photo-frame.<your-subdomain>.workers.dev/f/<FRAME_TOKEN>/
```

To check the connection to Drive, open `.../f/<FRAME_TOKEN>/api/photos`. It should return a JSON list of photos.

## iPad setup

1. Open the frame URL in Safari → **Share → Add to Home Screen**. Launch it from the icon to run full-screen.
2. Settings → **Auto-Lock → Never**.
3. Settings → Accessibility → **Guided Access** → on, with a passcode. Open the frame, triple-click the Home button, and tap **Start** to lock the iPad to the slideshow.
4. Leave it plugged in.

## Options

Add these to the frame URL before adding it to the Home Screen:

| Parameter | Default | Meaning |
|---|---|---|
| `seconds` | `12` | How long each photo stays on screen |
| `sync` | `3` | Minutes between folder checks |

Example: `.../f/<FRAME_TOKEN>/?seconds=20`

## Troubleshooting

Open `.../f/<FRAME_TOKEN>/api/photos` and match what you see:

| Response | Cause |
|---|---|
| `Unexpected end of JSON input` | The `GOOGLE_SERVICE_ACCOUNT` secret is empty. Re-upload it with `secret bulk` (step 5). |
| `Google sign-in failed: ...` | The key secret is malformed or the key was deleted. Create a new key and re-upload. |
| `Drive error: File not found: .` | `FOLDER_ID` is empty. Set it in `wrangler.jsonc` and redeploy. |
| `Drive error: File not found: <id>` | Wrong folder ID, or the folder isn't shared with the service account. |
| `Drive API has not been used in project...` | Enable the Drive API in the same Cloud project as the service account. |
| `{"photos":[]}` | The service account can't see any photos: check sharing, subfolders, and the folder ID. |
| Site can't be reached | The URL needs your account subdomain: `photo-frame.<subdomain>.workers.dev`. |

Changes to `wrangler.jsonc` only apply after `npm run deploy`. Secrets apply immediately.

## Security notes

- The Drive folder stays **Restricted**. Only the service account (read-only) and the people you share it with can access it.
- The service account key and URL token are stored as Cloudflare secrets, never in the repo.
- Anyone with the full frame URL can view the photos, so share it like a password. To revoke access, set a new `FRAME_TOKEN` and update the iPads.

## Cost

Free. One iPad uses well under 10% of the Cloudflare Workers free tier (100,000 requests/day), and the Drive API doesn't require billing. If the free tier were ever exceeded, the Worker would stop responding for the rest of the day rather than charge anything.