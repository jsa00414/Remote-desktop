# Remote Desktop

Chrome Remote Desktop–style **connected host** session, run by `server.js`.

## Features

- Password gate: `8112026`
- Live host screen stream from the server display (`ffmpeg` + Socket.IO)
- Mouse and keyboard control (`xdotool`)
- Connected-host session UI (toolbar, fullscreen, disconnect)

## Run

```bash
npm install
npm start
```

Open http://localhost:3000, enter password `8112026`, and use the connected host.

## Deploy to VPS

```bash
export VPS_HOST=your.vps.ip
export VPS_USER=root
# either:
export VPS_SSH_PRIVATE_KEY="$(cat ~/.ssh/id_rsa)"
# or:
# export VPS_SSH_PASSWORD='…'
export VPS_DEPLOY_PATH=/opt/remote-desktop
export VPS_APP_PORT=3000

chmod +x scripts/deploy-vps.sh
./scripts/deploy-vps.sh
```

Then open `http://YOUR_VPS_IP:3000` and connect with password `8112026`.

