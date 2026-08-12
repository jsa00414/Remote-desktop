# Remote Desktop

Chrome Remote Desktop–style app with an **admin page to add host computers**, served on **port 5000** by `server.js`.

Designed to run on the True Mail VPS as a **separate site** from `https://mail.truemailor.com/mail` (different port / hostname).

## Features

- Admin (`/admin`) — add/remove computers, set PIN, rotate setup codes (password `8112026`)
- Devices (`/`) — pick an online computer and connect with its PIN
- Host agent (`/host`) — register a computer with its setup code and share the screen
- Built-in “This server” host when a local display is available

## Run

```bash
npm install
npm start
```

- Devices: http://localhost:5000  
- Admin: http://localhost:5000/admin  
- Host share: http://localhost:5000/host  

## Deploy on True Mail VPS (separate from True Mail)

Keep True Mail on 443/`/mail`. Run this app on **port 5000** (or put Caddy in front on e.g. `remote.truemailor.com`).

```bash
export VPS_HOST=74.208.54.132
export VPS_USER=root
export VPS_SSH_PRIVATE_KEY="$(cat ~/.ssh/id_rsa)"   # or VPS_SSH_PASSWORD
export VPS_DEPLOY_PATH=/opt/remote-desktop
export VPS_APP_PORT=5000
./scripts/deploy-vps.sh
```

Optional Caddy site (separate hostname):

```
remote.truemailor.com {
  reverse_proxy 127.0.0.1:5000
}
```

Then open `http://VPS_IP:5000` or `https://remote.truemailor.com`.
