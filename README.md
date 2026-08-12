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

Environment variables (optional):

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `DISPLAY` | `:1` | X display to capture |
| `HOST_NAME` | `Connected host` | Name shown in the session bar |
| `FRAME_FPS` | `8` | Capture framerate |
| `FRAME_QUALITY` | `5` | JPEG quality (2–31, lower is better) |
| `FRAME_SCALE` | `1280:-1` | ffmpeg scale filter |
