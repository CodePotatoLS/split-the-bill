# Split the Bill

Photograph receipts, tag each line with who had it, and see what everyone owes.
Photos are read by Google Gemini (free tier) through a small Cloudflare Worker that keeps the API key private.
If Gemini is unavailable or its free quota runs out, the page reads the photo on the phone instead (less accurate).

## Files

| Path | What it is |
|---|---|
| `index.html` | The app (served by GitHub Pages) |
| `config.js` | The Worker address the app sends photos to |
| `worker/worker.js` | The Cloudflare Worker: holds the Gemini key and asks Gemini to read the receipt |
| `ocr/` | On-phone reader used as a fallback |

## Setup

### 1. Get a Gemini API key
1. Open https://aistudio.google.com/apikey and sign in with a Google account.
2. Tap **Create API key** and copy it.

### 2. Create the Cloudflare Worker
1. Sign up or log in at https://dash.cloudflare.com (free plan).
2. Go to **Workers & Pages → Create → Create Worker**, name it `split-reader`, and tap **Deploy**.
3. Tap **Edit code**, delete everything, paste the contents of `worker/worker.js`, and tap **Deploy**.
4. Go to the Worker's **Settings → Variables and Secrets → Add**:
   - Type **Secret**, name `GEMINI_API_KEY`, value: your key. Save and deploy.
   - Optional: type **Text**, name `ALLOWED_ORIGINS`, value `https://YOUR-GITHUB-USERNAME.github.io`. Without it, any `*.github.io` page can use your Worker.
5. Copy the Worker address, e.g. `https://split-reader.yourname.workers.dev`. Opening it in a browser should show `"keySet":true`.

### 3. Point the app at the Worker
Edit `config.js` and put the Worker address between the quotes.

### 4. Turn on GitHub Pages
Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`, **Save**.
The app appears at `https://YOUR-GITHUB-USERNAME.github.io/REPO-NAME/` after a minute or two.

## Limits and privacy
- Gemini's free tier allows roughly 15 scans a minute and 500 a day. Google may change this.
- On the free tier Google may use what you send to improve its products, and people may review it. Don't scan anything private.
- The Worker allows 60 scans per hour per device as a light guard against abuse.
- People, items and splits are saved only in each person's own browser.

## Changing the model
Set a `MODEL` text variable on the Worker (e.g. `gemini-3.5-flash`). If a model isn't available, the Worker falls back to `gemini-flash-lite-latest`, then `gemini-flash-latest`.
