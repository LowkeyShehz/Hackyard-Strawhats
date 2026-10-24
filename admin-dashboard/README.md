# Nirman Mitra — Admin Dashboard

React 18 + Vite single-page app for welfare officers and admins: dashboard stats,
the attendance review queue, worker search and profiles, construction sites, and
public certificate verification (`/verify/<hash>`).

## Develop

```bash
npm install
API_URL=https://<api-id>.execute-api.<region>.amazonaws.com/<stage> npm run dev   # proxies /api to API_URL
npm run build                                                                    # outputs dist/
```

At build time set `VITE_API_URL` to the API Gateway base URL (no trailing slash)
if the dashboard is not served from the same origin as the API.

## Routes

| Path | Auth | Page |
| --- | --- | --- |
| `/home` | public | Landing page |
| `/login` | public | Admin login |
| `/verify`, `/verify/:hash` | public | Certificate verification (QR target) |
| `/dashboard` | admin | Overview stats and charts |
| `/review` | admin | Flagged attendance review queue |
| `/workers`, `/workers/:id` | admin | Worker search and profile |
| `/sites` | admin | Sites and geofences |

## Hosting on AWS Amplify: SPA rewrite rule (required)

All routes above are client-side routes. Without a rewrite, opening a deep link
such as `/verify/<hash>` (the URL encoded in every certificate QR code) or
`/dashboard` directly returns **404** from Amplify Hosting.

Amplify Hosting does **not** read `_redirects` files. Add this rule in the
Amplify console under **Hosting > Rewrites and redirects > Manage redirects**:

| Source address | Target address | Type |
| --- | --- | --- |
| `</^[^.]+$\|\.(?!(css\|gif\|ico\|jpg\|js\|png\|txt\|svg\|woff\|woff2\|ttf\|map\|json\|webp)$)([^.]+$)/>` | `/index.html` | `200 (Rewrite)` |

Or open **Open text editor** on that screen and paste this JSON:

```json
[
  {
    "source": "</^[^.]+$|\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>",
    "target": "/index.html",
    "status": "200",
    "condition": null
  }
]
```

The same rule with the AWS CLI:

```bash
aws amplify update-app --app-id <app-id> --custom-rules \
  '[{"source":"</^[^.]+$|\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>","target":"/index.html","status":"200"}]'
```

The rule rewrites every path that is not a static asset to `index.html` with a
200 status, so React Router can render the page. Real files (`/assets/*.js`,
`/logo.png`, ...) are still served as-is.

### Amplify build settings (monorepo)

The app lives in `admin-dashboard/`, so set the app root to `admin-dashboard`
(Amplify console > Build settings, or `AMPLIFY_MONOREPO_APP_ROOT=admin-dashboard`)
and use this build spec (paste into the console build settings or a repo-root
`amplify.yml`):

```yaml
version: 1
applications:
  - appRoot: admin-dashboard
    frontend:
      phases:
        preBuild:
          commands:
            - npm ci
        build:
          commands:
            - npm run build
      artifacts:
        baseDirectory: dist
        files:
          - '**/*'
      cache:
        paths:
          - node_modules/**/*
```

Remember to set the `VITE_API_URL` environment variable for the branch.

## Other static hosts

`public/_redirects` (`/*  /index.html  200`) is copied into `dist/` and gives the
same SPA fallback on Netlify, Cloudflare Pages and other hosts that support the
`_redirects` format. It is ignored by Amplify Hosting.
