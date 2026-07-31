# clementine.app — landing page

Marketing site for Clementine. Single page, Next.js 15, deployed to Railway.

## Develop

```bash
cd apps/web
npm install
npm run dev
# open http://localhost:3000
```

## Build

```bash
npm run build
npm start
```

## Deploy (Railway)

1. New Railway service → connect this repo.
2. Settings → Root Directory: `apps/web`.
3. Railway picks up `railway.json` automatically (Nixpacks build, standalone Next.js server).

The `/api/download` route fetches the latest Clementine Mac asset from GitHub
Releases and 302s to it. It intentionally avoids caching so release-day
downloads pick up newly published desktop builds immediately.

## Hero video

The cinematic `public/hero.mp4` is generated with Higgsfield (Veo 3.1) and re-encoded with `ffmpeg -g 1 -keyint_min 1` so `video.currentTime` can be scrubbed smoothly by scroll position.

To regenerate:

```bash
higgsfield generate create veo3_1 --prompt "..." --duration 8 --aspect_ratio 16:9 --quality high --wait
# download the output URL, then:
ffmpeg -i raw.mp4 -c:v libx264 -preset slow -crf 20 -g 1 -keyint_min 1 -pix_fmt yuv420p -movflags +faststart public/hero.mp4
ffmpeg -i public/hero.mp4 -vframes 1 public/hero-poster.jpg
```
