# Setup guide (Windows)

Four parts, in the order the work needs them. **Secrets** (passwords, connection strings)
only ever go into `dotnet user-secrets` on your PC, Render's environment settings, or
`firmware/node/secrets.h`. Never into a file Git tracks, and never into chat.

> **PowerShell tip:** put secret values in **single quotes** `'like this'`. In double
> quotes PowerShell treats `$` as a variable and silently changes your password.

---

## 1. Neon (PostgreSQL database)

**Done on 1 Nov 2026.** Project `smart-water` (`weathered-smoke-12212274`), region
**aws-eu-central-1 (Frankfurt)**, Postgres 18. The schema and seed are loaded on the
`production` branch.

How it's wired, so you can explain it:

- `neon.ts` (repo root) is the project's Neon config. `neon deploy` applies it and writes
  the connection strings into **`.env.local`**, which Git ignores:
  - `DATABASE_URL`: the **pooled** connection (`-pooler` host). The backend uses it,
    because a web server makes many short queries.
  - `DATABASE_URL_UNPOOLED`: the **direct** connection. `tools/dbsetup` uses it for schema
    changes, as Neon recommends.
- Locally the backend reads `DATABASE_URL` from `.env.local`; on Render it's an
  environment variable. `backend/.../Database/DatabaseUrl.cs` turns Neon's
  `postgresql://` URL into the format Npgsql (the .NET driver) expects.

### Redo it on another PC

```powershell
npx neon@latest login          # opens the browser to sign in
npx neon@latest env pull       # writes .env.local for the linked branch
cd backend\src\SmartWater.Api
dotnet run                     # http://localhost:5000/api/health -> "database":"ok"
```

### Load or reset the database

```powershell
cd tools\dbsetup
dotnet run                                                   # shows what's in it
dotnet run -- ..\..\db_schema.sql ..\..\db_seed.sql      # empty database only
dotnet run -- ..\..\db	ools
eset_demo_data.sql                 # before a presentation
```

### Create the logins
There are no default users: each login is created with its own password, which never goes
into Git. From the repo folder:

```powershell
cd tools\dbsetup
dotnet run -- adduser dillon administrator "Dillon Swart"
dotnet run -- adduser operator operator "Demo Operator"
```

It asks for the password twice (8+ characters, nothing shows while you type). Roles:
`administrator`, `operator`, `technician`, `engineer`. Running it again for the same
username changes the password and unlocks the account.

### A `dev` branch for testing

Test on a branch so test data never reaches the demo database:

```powershell
npx neon@latest checkout dev --create   # copy of production, .env.local now points at it
npx neon@latest checkout production     # back to production before presenting
```

`neon.ts` makes new branches **expire after 7 days** (`ttl: "7d"`). That's fine for
throw-away test branches. For a long-lived `dev`, remove the `ttl` line first.

---

## 2. EMQX Cloud (MQTT broker)

About 10 minutes. We first planned HiveMQ Cloud, but HiveMQ retired its free Serverless
plan (no new clusters, shut down 31 Dec 2026). EMQX Serverless is the same idea and free.

### 2.1 Create the deployment
1. Go to **https://cloud-intl.emqx.com** → sign up (Google or GitHub is fine).
2. **New Deployment** → **Serverless** (not Dedicated, which is paid).
3. Region: a European one if offered. **Spending limit: 0**, so it can never charge you;
   it pauses instead if the free allowance runs out.
4. Name it `smart-water` → **Deploy**. Ready in a minute or two.
5. On the deployment's **Overview**, under connection information, find:
   - the **address**, like `a1b2c3d4.ala.eu-central-1.emqxsl.com`. You'll paste it below.
   - **MQTT over TLS** port `8883`. That's the one we use.

The free allowance is about 1 GB of traffic a month. One node sending every second uses
roughly 60 MB a day, so don't leave the node or the simulator running for weeks.

### 2.2 Create two logins
One for the backend, one for node-2. The simulator uses node-2's, because it pretends to
be node-2.
1. In the deployment: **Access Control** → **Authentication** → **+ Add**.
2. Username `backend`, a strong password (20+ letters and digits; a password manager's
   generator is ideal) → **Confirm**.
3. Again: username `node-2`, a **different** strong password.
4. Keep both passwords in your password manager.

### 2.3 Give the passwords to the simulator and the backend
In PowerShell from the repo folder, pasting your values between the single quotes:

```powershell
cd tools\simulator
dotnet user-secrets set 'Mqtt:Host' '<address, e.g. a1b2c3d4.ala.eu-central-1.emqxsl.com>'
dotnet user-secrets set 'Mqtt:Username' 'node-2'
dotnet user-secrets set 'Mqtt:Password' '<node-2 password>'

cd ..\..ackend\src\SmartWater.Api
dotnet user-secrets set 'Mqtt:Host' '<address>'
dotnet user-secrets set 'Mqtt:Username' 'backend'
dotnet user-secrets set 'Mqtt:Password' '<backend password>'
```

The firmware gets node-2's details in `firmware/node/secrets.h` (see `firmware/` README).
The ESP32 must trust EMQX's root certificate, **DigiCert Global Root G2**.

### 2.4 Check it works
1. `cd tools\simulator` then `dotnet run`. It prints `connected` within a few seconds.
2. With the backend running too, its log shows node-2 online and readings arriving.
3. Press **O** in the simulator: node-2 should go offline straight away (the last will).
   Press **O** again to reconnect, then **Q** to quit.

---

## 3. Local development (all on your PC)

Install once:
| What | Where | Check in PowerShell |
|---|---|---|
| .NET 10 SDK | https://dotnet.microsoft.com/download → .NET 10 → SDK, Windows x64 | `dotnet --version` → `10.…` |
| Node.js LTS | https://nodejs.org → LTS, Windows installer | `node -v` → `v22` or newer |

Run the whole system with three PowerShell windows:

| Window | Folder | Command | What it is |
|---|---|---|---|
| 1 | `backend\src\SmartWater.Api` | `dotnet run` | API + MQTT + detection on http://localhost:5000 |
| 2 | `web` | `npm run dev` | Web app with live reload on http://localhost:5173 (needs `VITE_DATA_SOURCE=api` in `web\.env`) |
| 3 | `tools\simulator` | `dotnet run` | Fake node-2 (or power the real node instead, never both) |

Or skip window 2: `npm run build` in `web` once, and the backend serves the app itself on
http://localhost:5000, just as Render does.

---

## 4. Render (hosting)

1. Push the repo to GitHub (private). Render builds what's on GitHub, not what's on your PC.
2. Go to https://render.com and sign up with GitHub. Allow it to see the `smart-water` repo.
3. Click **New +**, then **Blueprint**, and pick `smart-water`. Render reads `render.yaml`:
   one free web service in Frankfurt.
4. It asks for the secret settings. Paste these, copying each value from the file named:
   | Key | Value | Where to copy it from |
   |---|---|---|
   | `DATABASE_URL` | the whole `DATABASE_URL` value (pooled, not `_UNPOOLED`) | `.env.local` |
   | `Mqtt__Host` | `x2fc9bd5.ala.eu-central-1.emqxsl.com` | |
   | `Mqtt__Username` | `backend` | |
   | `Mqtt__Password` | the `backend` password | `passwords.env.local` |

   `Jwt__Key` (signs login tokens) is generated by Render, so it isn't in the list.
5. Click **Apply**. The first build takes about 5 minutes.
6. Open `https://<service>.onrender.com/api/health`. You want `"database":"ok"`,
   `"mqtt":"connected"` and `"webApp":"served"`.
7. **Stop the backend on your PC.** Two backends would both run leak detection, so every
   leak and alert would appear twice.

The double underscore `__` is how environment variables write the `:` in setting names.

**Free plan limits:**
- An idle free service sleeps after 15 minutes, which would stop it hearing MQTT. The
  backend calls its own `/api/ping` every 10 minutes to stay awake (`Hosting/KeepAwake.cs`).
- Each push to GitHub redeploys, and the backend restarts. Don't push during a demo.
- Every sensor adds a row per second to Neon, so switch the node off when you aren't using
  it, to stay inside Neon's free storage and EMQX's 1 GB of traffic a month.
