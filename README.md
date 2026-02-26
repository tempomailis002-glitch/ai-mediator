# 🤖 AI Mediator

Auto-matches movie requests from the **Movie Request Portal** with Telegram links from the **Telegram Link Library**.

## How It Works

1. **Polls** the Movie Request Portal every 30 seconds for new pending requests
2. **Searches** the Telegram Library API using the movie name
3. **Fuzzy matches** file names to find the best match (40%+ keyword match threshold)
4. **Auto-completes** the request with the Telegram download link
5. **Dashboard** at the root URL shows live stats, config, and activity logs

## Setup & Deployment

### Step 1: Create a GitHub Repo

1. Go to https://github.com/new
2. Create a new repo called `ai-mediator`
3. Open the folder `d:\ai app\ai-mediator` in terminal (Command Prompt or Git Bash)
4. Run these commands:
   ```
   git init
   git add .
   git commit -m "Initial commit - AI Mediator"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/ai-mediator.git
   git push -u origin main
   ```

### Step 2: Deploy on Render

1. Go to https://dashboard.render.com
2. Click **New** → **Web Service**
3. Connect your `ai-mediator` GitHub repo
4. Settings:
   - **Name**: `ai-mediator`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
5. Add these **Environment Variables**:
   - `PRP_API_URL` = `https://prp-ivnf.onrender.com`
   - `TELE_LIBRARY_URL` = `https://tele-to-gofile.onrender.com`
   - `POLL_INTERVAL_MS` = `30000`

### Step 3: Done!

Once deployed, the mediator will automatically start polling for movie requests and matching them with Telegram links. Visit your Render URL to see the dashboard.

## Local Testing

```
npm install
node index.js
```

Open http://localhost:3002 to see the dashboard.
