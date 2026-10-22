# 💎 FF Diamond — Free Fire Watch & Earn Platform

Zero-dependency Node.js backend (`server.js`) and mobile-app-ready frontend (`public/index.html`) for the **FF Diamond Watch & Earn Platform**.

## 📁 Folder Structure (GitHub Repository Layout)

Make sure your GitHub repository has this exact folder structure:

```text
ff-diamond-platform/
├── server.js
├── package.json
├── render.yaml
├── README.md
├── .gitignore
└── public/
    ├── index.html
    └── manifest.json
```

> **Important:** `index.html` must be placed inside the **`public/`** folder (`public/index.html`), while `server.js`, `package.json`, `render.yaml`, and `README.md` stay in the root folder.

## 🚀 Features Included

- **🌐 Public Guest Mode + Official Intro Video:** Any visitor can open the Home page without logging in, watch the **Official Introduction Video**, browse videos, read **Terms & Conditions**, or submit a **Promotional Ticket / Direct Email**. Also hides the Redeem tab until a user registers/logs in.
- **⚡ Interactive App-Ready Header:** Live status badge (`● LIVE`), real-time instant search with 1-tap clear, interactive Notification Bell popover (`🔔`), clickable Daily Streak (`🔥`), Rank (`🥉`), and Wallet (`💎` with mini 60s progress bar) pills, plus Fullscreen App Mode (`📲`).
- **🎯 Gamification & Rewards:**
  - **7-Day Login & Watch Streak** (unlocked after 2 minutes of daily watch time)
  - **Watch-to-Unlock Daily Lucky Spin Wheel** (unlocked after 10 minutes of daily watch time)
  - **3 Free Fire Daily Missions + Bonus Booyah Chest**
  - **Free Fire Watcher Ranks** (*Bronze → Silver → Gold → Platinum → Diamond → Heroic → Grandmaster*)
- **🔥 Viral Views & Anti-Cheat Engine:**
  - **1x Playback Speed Lock:** Automatically resets playback speed to `1x` if a viewer tries to fast-forward (`1.5x` / `2x`).
  - **Lifetime 1x Video Reward Cap:** Prevents loop farming by capping lifetime rewards per user per video to 100% of the video's duration.
  - **10-Minute Activity Check:** Mandatory *"Are you still watching?"* verification every 10 minutes of continuous playback.
  - **2X Diamond Boost Videos:** Owner can enable **🔥 2X Boost** (`0.30 💎/min`) on new uploads.
  - **Secret Video Promo Codes:** Viewers can claim limited promo codes shown inside your YouTube videos.
  - **Fraud-Proof Referral System:** Credits **+2.00 💎** to both inviter and friend only after the friend completes **15 minutes of verified watch time**.
- **🔒 Private Owner Portal (Hidden from Public Pages):**
  - Regular visitors never see an Owner Login button anywhere on the site.
  - Only accessible via your private link:
    - `https://your-domain.com/owner`
    - `https://your-domain.com/#/owner`
    - `https://your-domain.com/?owner=1`

## 🛠 Local Setup

1. Install Node.js (v18 or newer).
2. Run the server with your owner credentials:

```bash
OWNER_USERNAME=admin OWNER_PASSWORD=your_strong_password npm start
```

3. Open `http://localhost:3000` for the public platform, or `http://localhost:3000/owner` for the Private Owner Command Center.

## ☁️ Deploying on Render.com (via GitHub)

1. Create a new repository on GitHub and upload `server.js`, `package.json`, `render.yaml`, `README.md`, and the `public/` folder (`public/index.html`).
2. Log in to [Render.com](https://render.com) and click **New +** → **Web Service** (or **Blueprint**).
3. Connect your GitHub repository.
4. In the **Environment Variables** section on Render, set:
   - `OWNER_USERNAME` = `admin` (or your preferred owner username)
   - `OWNER_PASSWORD` = `your_secret_owner_password`
5. Click **Deploy**. Once live, use `https://your-app.onrender.com/owner` to log into your Owner Command Center and use the **💾 1-Click Download DB Backup** button regularly to keep a local copy of your `db.json`.

## 📲 Converting to a Mobile App (Android APK / WebView)

Because `public/index.html` includes mobile web-app meta tags and `public/manifest.json`, you can convert your live HTTPS website into an Android app in minutes using:
- **[PWABuilder.com](https://www.pwabuilder.com):** Paste your deployed HTTPS URL and download a signed Android `.apk` / `.aab` package.
- **Android Studio WebView:** Load your deployed HTTPS URL inside an Android `WebView` with `javaScriptEnabled = true` and `domStorageEnabled = true`.
