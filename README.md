# RentEase (with cross-device sync)

Rent manager for landlords. Add or delete renters and payments on any device;
every device shows the same data.

## Files
- `server.js` - small Node server + API (login, save/load data)
- `public/` - the app (index.html, manifest, service worker, icons)
- `render.yaml` - tells Render to create the web service AND the Postgres database
- `package.json` - dependency list (only `pg`)

## Deploy on Render
1. In your GitHub repo, delete the old files and upload everything from this folder
   (`server.js`, `package.json`, `render.yaml`, `README.md`, and the whole `public` folder).
2. Render dashboard > New > Blueprint > pick the repo > Apply.
   Render creates the database `rentease-db` and the web service `rentease-app`.
3. Open the web service URL (https://rentease-app.onrender.com or similar).
4. First open: create your Admin ID and password. On other devices, log in with the same ID and password.

## Notes
- Free web services on Render sleep after a while; the first open can take about a minute.
- Check Render's current free Postgres terms (free databases may expire). Upgrade the plan to keep data long-term.
- If the server is empty, the first device you log in with uploads its existing local data.
- If two devices change data at the same moment, the older change is rejected and the app reloads the latest data.

## Run locally
`node server.js` then open http://localhost:3000 (stores data in data.json, no database needed).
