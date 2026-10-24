# Guess My Drawing

A real-time multiplayer drawing-and-guessing game built with Node.js, Express, Socket.IO, and Canvas.

## Run locally

1. Install Node.js 20 or newer.
2. Open a terminal in this folder (the folder containing `package.json`).
3. Run:

   ```bash
   npm install
   npm start
   ```

4. Open http://localhost:3000 in your browser.

To play with someone on the same Wi-Fi, they can open `http://YOUR-COMPUTER-LAN-IP:3000`. For friends on other networks, deploy the project to a Node.js hosting service and share the public URL.

## Main files

- `server.js` — game server and multiplayer events
- `public/index.html` — game page
- `public/style.css` — appearance and layout
- `public/app.js` — browser-side game logic
- `package.json` — dependencies and run commands

This is a starter project. Test multiplayer behavior and review security settings before making it publicly available.
